import { Type } from "typebox";
import {
	getAgentDir,
	highlightCode,
	keyHint,
	truncateToVisualLines,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { loadConfig } from "./config.ts";
import { JobNotificationManager, registerJobNotificationRenderer } from "./job-notifications.ts";
import { PythonRuntime, type JobResult } from "./runtime.ts";

const MAX_CAPTURE_BYTES = 50 * 1024;

const TOOL_DESCRIPTION = `Execute Python 3 code in the current working directory, either in the foreground or as a persistent background job.

Pass code for foreground execution. Output streams until Python exits; use timeout when execution must be bounded.

BACKGROUND JOBS: Set background=true for long-running programs. The job persists across tool calls, /reload, and pi restarts, and completion is reported automatically. Use notifyOn only when the next step depends on a literal readiness message. Pass jobId to read incremental output and status, optionally with wait; set stop=true to terminate the active process tree.

Exactly one of code or jobId is required. timeout applies only to foreground code; wait and stop apply only to jobId. Each result is limited to the latest 50KB.`;

const PythonParams = Type.Object(
	{
		code: Type.Optional(
			Type.String({
				minLength: 1,
				description: "Python 3 source code to execute. Omit when querying a background job.",
			}),
		),
		background: Type.Optional(
			Type.Boolean({
				description: "Run code as a persistent background job and return a jobId immediately. Defaults to false.",
			}),
		),
		notifyOn: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 256,
				description: "With background=true, request a one-time readiness notification when this literal text appears in output.",
			}),
		),
		timeout: Type.Optional(
			Type.Number({
				minimum: 0.001,
				maximum: 86400,
				description: "Maximum seconds for foreground execution before its process tree is terminated.",
			}),
		),
		jobId: Type.Optional(
			Type.String({
				description: "Background job ID returned by an earlier call. Omit when executing code.",
			}),
		),
		wait: Type.Optional(
			Type.Number({
				minimum: 0,
				maximum: 30,
				description: "Seconds to wait for new output or job completion when querying jobId. Defaults to 0.",
			}),
		),
		stop: Type.Optional(
			Type.Boolean({
				description: "With jobId, terminate the background process tree before returning status and unread output.",
			}),
		),
	},
	{ additionalProperties: false },
);

interface PythonDetails {
	version: 1;
	kind: "foreground" | "background";
	status: "running" | "completed" | "failed" | "stopped";
	exitCode?: number | null;
	jobId?: string;
	pid?: number;
}

function appendCaptured(current: Buffer, chunk: Buffer): { buffer: Buffer; omitted: boolean } {
	const combined = Buffer.concat([current, chunk]);
	if (combined.length <= MAX_CAPTURE_BYTES) return { buffer: combined, omitted: false };
	return { buffer: combined.subarray(combined.length - MAX_CAPTURE_BYTES), omitted: true };
}

function foregroundText(output: string, omitted: boolean, exitCode?: number | null): string {
	const parts: string[] = [];
	if (omitted) parts.push("[Earlier output omitted; showing the latest 50KB]");
	if (output) parts.push(output.replace(/\s+$/, ""));
	if (exitCode !== undefined && !output) parts.push(`Python exited with code ${exitCode}.`);
	return parts.join("\n");
}

function jobText(result: JobResult): string {
	const { metadata } = result;
	const lines = [
		`jobId: ${metadata.id}`,
		`status: ${metadata.status}`,
		...(metadata.pid ? [`pid: ${metadata.pid}`] : []),
		...(metadata.exitCode !== undefined ? [`exitCode: ${metadata.exitCode ?? "unknown"}`] : []),
	];
	if (result.omittedBytes > 0) lines.push(`output: [${result.omittedBytes} earlier unread bytes omitted]`);
	else lines.push("output:");
	lines.push(result.output ? result.output.replace(/\s+$/, "") : "(no new output)");
	if (metadata.error) lines.push(`error: ${metadata.error}`);
	return lines.join("\n");
}

function detailsForJob(result: JobResult): PythonDetails {
	return {
		version: 1,
		kind: "background",
		status: result.metadata.status === "starting" ? "running" : result.metadata.status,
		exitCode: result.metadata.exitCode,
		jobId: result.metadata.id,
		pid: result.metadata.pid,
	};
}

// ---------------------------------------------------------------------------
// TUI rendering (syntax highlighting adapted from pi's built-in write tool,
// output preview from the built-in bash tool)
// ---------------------------------------------------------------------------

const CALL_COLLAPSED_CODE_LINES = 10;
const OUTPUT_PREVIEW_LINES = 5;
const PARTIAL_FULL_HIGHLIGHT_LINES = 50;
const PYTHON_LANG = "python";

// ANSI escape sequences (OSC + CSI), the same pattern family as pi's stripAnsi.
const ANSI_PATTERN = new RegExp(
	"(?:\\u001B\\][\\s\\S]*?(?:\\u0007|\\u001B\\u005C|\\u009C))|[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]",
	"g",
);

function normalizeDisplayText(text: string): string {
	return text.replace(/\r/g, "");
}

function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

/** Strip ANSI escapes and control characters that would corrupt the TUI layout. */
function sanitizeOutput(text: string): string {
	return normalizeDisplayText(text)
		.replace(ANSI_PATTERN, "")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") end--;
	return lines.slice(0, end);
}

interface CodeHighlightCache {
	rawCode: string;
	normalizedLines: string[];
	highlightedLines: string[];
}

function highlightSingleLine(line: string): string {
	return highlightCode(line, PYTHON_LANG)[0] ?? "";
}

function rebuildCodeHighlightCache(code: string): CodeHighlightCache {
	const normalized = replaceTabs(normalizeDisplayText(code));
	return {
		rawCode: code,
		normalizedLines: normalized.split("\n"),
		highlightedLines: highlightCode(normalized, PYTHON_LANG),
	};
}

/** Re-highlight the first lines with full context so multiline constructs (e.g. triple-quoted strings) stay correct while streaming. */
function refreshHighlightPrefix(cache: CodeHighlightCache): void {
	const prefixCount = Math.min(PARTIAL_FULL_HIGHLIGHT_LINES, cache.normalizedLines.length);
	if (prefixCount === 0) return;
	const prefixHighlighted = highlightCode(cache.normalizedLines.slice(0, prefixCount).join("\n"), PYTHON_LANG);
	for (let i = 0; i < prefixCount; i++) {
		cache.highlightedLines[i] = prefixHighlighted[i] ?? highlightSingleLine(cache.normalizedLines[i] ?? "");
	}
}

/** Incremental highlighter for streaming args: append-only growth only re-highlights the tail. */
function updateCodeHighlightCacheIncremental(cache: CodeHighlightCache | undefined, code: string): CodeHighlightCache {
	if (!cache) return rebuildCodeHighlightCache(code);
	if (!code.startsWith(cache.rawCode)) return rebuildCodeHighlightCache(code);
	if (code.length === cache.rawCode.length) return cache;

	const delta = replaceTabs(normalizeDisplayText(code.slice(cache.rawCode.length)));
	cache.rawCode = code;
	if (cache.normalizedLines.length === 0) {
		cache.normalizedLines.push("");
		cache.highlightedLines.push("");
	}
	const segments = delta.split("\n");
	const lastIndex = cache.normalizedLines.length - 1;
	cache.normalizedLines[lastIndex] += segments[0];
	cache.highlightedLines[lastIndex] = highlightSingleLine(cache.normalizedLines[lastIndex]);
	for (let i = 1; i < segments.length; i++) {
		cache.normalizedLines.push(segments[i]);
		cache.highlightedLines.push(highlightSingleLine(segments[i]));
	}
	refreshHighlightPrefix(cache);
	return cache;
}

type PythonToolArgs = {
	code?: string;
	background?: boolean;
	notifyOn?: string;
	timeout?: number;
	jobId?: string;
	wait?: number;
	stop?: boolean;
};

function formatPythonCodeCall(args: PythonToolArgs, expanded: boolean, theme: Theme, cache: CodeHighlightCache | undefined): string {
	let text = theme.fg("toolTitle", theme.bold("python"));
	if (args.background) text += theme.fg("muted", args.notifyOn ? ` (background · notify on ${JSON.stringify(args.notifyOn)})` : " (background)");
	else if (args.timeout !== undefined) text += theme.fg("muted", ` (timeout ${args.timeout}s)`);

	const code = typeof args.code === "string" ? args.code : "";
	if (!code) return `${text} ${theme.fg("muted", "...")}`;

	const rendered = cache?.highlightedLines ?? highlightCode(replaceTabs(normalizeDisplayText(code)), PYTHON_LANG);
	const lines = trimTrailingEmptyLines(rendered);
	const maxLines = expanded ? lines.length : CALL_COLLAPSED_CODE_LINES;
	text += `\n\n${lines.slice(0, maxLines).join("\n")}`;
	if (lines.length > maxLines) {
		text += `${theme.fg("muted", `\n... (${lines.length - maxLines} more lines, ${lines.length} total,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
	}
	return text;
}

function formatPythonJobCall(args: PythonToolArgs, theme: Theme): string {
	let text = `${theme.fg("toolTitle", theme.bold("python"))} ${theme.fg("accent", args.jobId ?? "?")}`;
	if (args.stop) text += theme.fg("muted", " (stop)");
	else if (args.wait) text += theme.fg("muted", ` (wait ${args.wait}s)`);
	return text;
}

interface PythonRenderState {
	startedAt?: number;
	endedAt?: number;
	interval?: ReturnType<typeof setInterval>;
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

/** Split a job result text into display parts, dropping the structured header already echoed in the status line. */
function extractJobBody(text: string): { note?: string; body: string } {
	const lines = text.split("\n");
	const markerIndex = lines.findIndex((line) => line === "output:" || line.startsWith("output: ["));
	if (markerIndex === -1) return { body: text };
	const marker = lines[markerIndex];
	const note = marker.startsWith("output: [") ? marker.slice("output: [".length, -1) : undefined;
	return { note, body: lines.slice(markerIndex + 1).join("\n") };
}

function jobStatusHeader(details: PythonDetails, theme: Theme): string {
	const statusColor =
		details.status === "completed" ? "success" : details.status === "failed" ? "error" : details.status === "stopped" ? "muted" : "warning";
	let text = `${theme.fg("toolTitle", theme.bold("job"))} ${theme.fg("accent", details.jobId ?? "?")} ${theme.fg(statusColor, details.status)}`;
	if (details.pid) text += theme.fg("dim", ` · pid ${details.pid}`);
	if (details.exitCode !== undefined) text += theme.fg("dim", ` · exit ${details.exitCode ?? "unknown"}`);
	return text;
}

class PythonCallComponent extends Text {
	highlightCache?: CodeHighlightCache;

	constructor() {
		super("", 0, 0);
	}
}

class PythonResultComponent extends Container {
	previewCache: { width?: number; source?: string; visualLines?: string[]; skippedCount?: number } = {};
}

function rebuildPythonResultComponent(
	component: PythonResultComponent,
	parts: { header?: string; output: string; note?: string; timing?: string },
	options: { expanded: boolean },
	theme: Theme,
): void {
	component.clear();
	if (parts.header) component.addChild(new Text(`\n${parts.header}`, 0, 0));

	const output = parts.output.trim();
	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");
		if (options.expanded) {
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			const cache = component.previewCache;
			component.addChild({
				render: (width: number) => {
					if (cache.visualLines === undefined || cache.width !== width || cache.source !== styledOutput) {
						const preview = truncateToVisualLines(styledOutput, OUTPUT_PREVIEW_LINES, width);
						cache.visualLines = preview.visualLines;
						cache.skippedCount = preview.skippedCount;
						cache.width = width;
						cache.source = styledOutput;
					}
					if (cache.skippedCount && cache.skippedCount > 0) {
						const hint =
							theme.fg("muted", `... (${cache.skippedCount} earlier lines,`) +
							` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
						return ["", truncateToWidth(hint, width, "..."), ...(cache.visualLines ?? [])];
					}
					return ["", ...(cache.visualLines ?? [])];
				},
				invalidate: () => {
					cache.width = undefined;
					cache.visualLines = undefined;
					cache.skippedCount = undefined;
				},
			});
		}
	}

	if (parts.note) component.addChild(new Text(`\n${theme.fg("warning", `[${parts.note}]`)}`, 0, 0));
	if (parts.timing) component.addChild(new Text(`\n${theme.fg("muted", parts.timing)}`, 0, 0));
}

function assertValidCombination(params: {
	code?: string;
	background?: boolean;
	notifyOn?: string;
	timeout?: number;
	jobId?: string;
	wait?: number;
	stop?: boolean;
}): void {
	if ((params.code === undefined) === (params.jobId === undefined)) {
		throw new Error("python: provide exactly one of code or jobId");
	}
	if (params.code !== undefined) {
		if (params.wait !== undefined) throw new Error("python: wait is accepted only with jobId");
		if (params.stop !== undefined) throw new Error("python: stop is accepted only with jobId");
		if (params.notifyOn !== undefined && !params.background) throw new Error("python: notifyOn requires background=true");
		if (params.notifyOn !== undefined && (params.notifyOn.length === 0 || Buffer.byteLength(params.notifyOn, "utf8") > 256)) {
			throw new Error("python: notifyOn must contain 1 to 256 UTF-8 bytes");
		}
		if (params.background && params.timeout !== undefined) {
			throw new Error("python: timeout is accepted only for foreground execution");
		}
		return;
	}
	if (params.background !== undefined) throw new Error("python: background is accepted only with code");
	if (params.notifyOn !== undefined) throw new Error("python: notifyOn is accepted only with background code");
	if (params.timeout !== undefined) throw new Error("python: timeout is accepted only with foreground code");
	if (params.stop && params.wait !== undefined) throw new Error("python: wait is not accepted when stop=true");
}

export default function pythonExtension(pi: ExtensionAPI): void {
	let runtime: PythonRuntime | undefined;
	let setupError: string | undefined;
	let notifications: JobNotificationManager | undefined;
	try {
		const { config } = loadConfig({ agentDir: getAgentDir() });
		runtime = new PythonRuntime({
			...(config.executable === "auto" ? {} : { interpreter: { executable: config.executable } }),
			utf8: config.utf8,
			unbuffered: config.unbuffered,
		});
	} catch (error) {
		setupError = error instanceof Error ? error.message : String(error);
	}
	registerJobNotificationRenderer(pi);

	pi.registerTool({
		name: "python",
		label: "Python",
		description: TOOL_DESCRIPTION,
		promptSnippet: "Execute Python scripts",
		promptGuidelines: [
			"Use python for complex tasks and computation, both foreground and background.",
		],
		parameters: PythonParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			signal?.throwIfAborted();
			assertValidCombination(params);
			if (!runtime) throw new Error(`python: ${setupError ?? "runtime configuration could not be loaded"}`);
			const activeRuntime = runtime;
			const releaseNotifications = notifications?.deferDuringToolCall() ?? (() => {});
			try {

				if (params.jobId !== undefined) {
					const result = params.stop
						? await activeRuntime.stopJob(params.jobId)
						: await activeRuntime.readJob(params.jobId, params.wait ?? 0, signal);
					return {
						content: [{ type: "text" as const, text: jobText(result) }],
						details: detailsForJob(result),
					};
				}

				const code = params.code as string;
				if (params.background) {
					const metadata = await activeRuntime.startBackground(code, ctx.cwd, signal, params.notifyOn);
					const text = [
						"Python job started.",
						`jobId: ${metadata.id}`,
						`pid: ${metadata.pid}`,
						...(params.notifyOn ? [`notifyOn: ${JSON.stringify(params.notifyOn)}`] : []),
					].join("\n");
					return {
						content: [{ type: "text" as const, text }],
						details: {
							version: 1,
							kind: "background",
							status: "running",
							jobId: metadata.id,
							pid: metadata.pid,
						} satisfies PythonDetails,
					};
				}

				let captured: Buffer = Buffer.alloc(0);
				let omitted = false;
				const exitCode = await activeRuntime.runForeground({
					code,
					cwd: ctx.cwd,
					timeout: params.timeout,
					signal,
					onData(chunk) {
						const next = appendCaptured(captured, chunk);
						captured = next.buffer;
						omitted ||= next.omitted;
						onUpdate?.({
							content: [{ type: "text" as const, text: foregroundText(captured.toString("utf8"), omitted) }],
							details: { version: 1, kind: "foreground", status: "running" } satisfies PythonDetails,
						});
					},
				});
				const output = foregroundText(captured.toString("utf8"), omitted, exitCode === 0 ? exitCode : undefined);
				if (exitCode !== 0) throw new Error(`${output ? `${output}\n\n` : ""}Python exited with code ${exitCode}.`);
				return {
					content: [{ type: "text" as const, text: output }],
					details: {
						version: 1,
						kind: "foreground",
						status: "completed",
						exitCode,
					} satisfies PythonDetails,
				};
			} finally {
				releaseNotifications();
			}
		},

		renderCall(args, theme, context) {
			const state = context.state as PythonRenderState;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const component = (context.lastComponent as PythonCallComponent | undefined) ?? new PythonCallComponent();
			const code = typeof args?.code === "string" && args.code.length > 0 ? args.code : undefined;
			if (code !== undefined) {
				// Full re-highlight once args are complete (correct multiline context);
				// while streaming, grow the cache incrementally.
				component.highlightCache = context.argsComplete
					? component.highlightCache?.rawCode === code
						? component.highlightCache
						: rebuildCodeHighlightCache(code)
					: updateCodeHighlightCacheIncremental(component.highlightCache, code);
				component.setText(formatPythonCodeCall(args, context.expanded, theme, component.highlightCache));
			} else {
				component.highlightCache = undefined;
				component.setText(
					typeof args?.jobId === "string" ? formatPythonJobCall(args, theme) : theme.fg("toolTitle", theme.bold("python")),
				);
			}
			return component;
		},

		renderResult(result, options, theme, context) {
			const state = context.state as PythonRenderState;
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}

			const details = result.details as PythonDetails | undefined;
			let header: string | undefined;
			let note: string | undefined;
			let output = sanitizeOutput(resultText(result));
			if (details?.kind === "background") {
				header = jobStatusHeader(details, theme);
				if (output.startsWith("Python job started.")) {
					output = "";
				} else {
					const extracted = extractJobBody(output);
					note = extracted.note;
					output = extracted.body;
				}
			}
			let timing: string | undefined;
			if (state.startedAt !== undefined && details?.kind !== "background") {
				const label = options.isPartial ? "Elapsed" : "Took";
				timing = `${label} ${formatDuration((state.endedAt ?? Date.now()) - state.startedAt)}`;
			}

			const component = (context.lastComponent as PythonResultComponent | undefined) ?? new PythonResultComponent();
			rebuildPythonResultComponent(component, { header, output, note, timing }, options, theme);
			return component;
		},
	});

	pi.on("session_shutdown", async () => {
		const current = notifications;
		notifications = undefined;
		await current?.close();
	});

	pi.on("session_start", async (_event, ctx) => {
		const current = notifications;
		notifications = undefined;
		await current?.close();
		if (!runtime) {
			ctx.ui.notify(`pi-python: ${setupError ?? "runtime configuration could not be loaded"}`, "error");
			return;
		}
		runtime.setSessionId(ctx.sessionManager.getSessionId());
		try {
			await Promise.all([runtime.cleanupExpired(), runtime.interpreter()]);
		} catch (error) {
			ctx.ui.notify(`pi-python: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		const manager = new JobNotificationManager(pi, ctx, runtime, ctx.sessionManager.getSessionId());
		try {
			await manager.start();
			notifications = manager;
		} catch (error) {
			await manager.close();
			ctx.ui.notify(`pi-python: job notification startup failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});
}
