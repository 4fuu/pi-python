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
import { registerTaskCoordinator } from "@4fu/pi-task-coordinator";
import { loadConfig } from "./config.ts";
import { TaskNotificationManager } from "./task-notifications.ts";
import { PythonRuntime, type TaskResult } from "./runtime.ts";

const TOOL_DESCRIPTION = `Start or inspect persistent Python 3 tasks in the current working directory.

Exactly one of code or taskId is required. Every code call starts a persistent task immediately. wait expires after the requested number of seconds without stopping the task; with notifyOn it waits for literal readiness, otherwise for completion. A taskId call queries an idempotent status and latest-output snapshot; wait long-polls it. stop=true terminates the process tree. Cancelling the tool only ends its wait. Task IDs are usable only in the parent session that launched them.`;

const PythonParams = Type.Object(
	{
		code: Type.Optional(
			Type.String({
				minLength: 1,
				description: "Python 3 source code that starts a persistent task. Omit when querying a task.",
			}),
		),
		notifyOn: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 256,
				description: "For a code call, one-time literal readiness text (1..256 UTF-8 bytes).",
			}),
		),
		taskId: Type.Optional(
			Type.String({
				pattern: "^py_[0-9a-f]{8}$",
				description: "Persistent task ID returned by an earlier code call in this parent session.",
			}),
		),
		wait: Type.Optional(
			Type.Number({
				minimum: 0,
				maximum: 300,
				description: "Seconds to wait for readiness when notifyOn is configured, otherwise for terminal status. Defaults to 0.",
			}),
		),
		stop: Type.Optional(
			Type.Boolean({
				description: "With taskId, terminate the process tree before returning its snapshot.",
			}),
		),
	},
	{ additionalProperties: false },
);

interface PythonDetails {
	version: 1;
	kind: "task";
	status: "starting" | "running" | "completed" | "failed" | "cancelled";
	exitCode?: number | null;
	taskId?: string;
	pid?: number;
	createdAt: string;
	ready: boolean;
	omittedBytes: number;
	error?: string;
}

function taskText(result: TaskResult): string {
	const { metadata } = result;
	const lines = [
		`taskId: ${metadata.id}`,
		`status: ${metadata.status}`,
		...(result.ready ? ["ready: true"] : []),
		...(metadata.pid ? [`pid: ${metadata.pid}`] : []),
		...(metadata.exitCode !== undefined ? [`exitCode: ${metadata.exitCode ?? "unknown"}`] : []),
	];
	if (result.omittedBytes > 0) lines.push(`output: [${result.omittedBytes} earlier bytes omitted]`);
	else lines.push("output:");
	lines.push(result.output ? result.output.replace(/\s+$/, "") : "(no output)");
	if (metadata.error) lines.push(`error: ${metadata.error}`);
	return lines.join("\n");
}

function detailsForTask(result: TaskResult): PythonDetails {
	return {
		version: 1,
		kind: "task",
		status: result.metadata.status,
		exitCode: result.metadata.exitCode,
		taskId: result.metadata.id,
		pid: result.metadata.pid,
		createdAt: result.metadata.createdAt,
		ready: !!result.ready,
		omittedBytes: result.omittedBytes,
		error: result.metadata.error,
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
	notifyOn?: string;
	taskId?: string;
	wait?: number;
	stop?: boolean;
};

function formatPythonCodeCall(args: PythonToolArgs, expanded: boolean, theme: Theme, cache: CodeHighlightCache | undefined): string {
	let text = theme.fg("toolTitle", theme.bold("python"));
	if (args.notifyOn) text += theme.fg("muted", ` (notify on ${JSON.stringify(args.notifyOn)})`);
	if (args.wait !== undefined) text += theme.fg("muted", ` (wait ${args.wait}s)`);

	const code = typeof args.code === "string" ? args.code : "";
	if (!code) return `${text} ${theme.fg("muted", "...")}`;

	const rendered = cache?.highlightedLines ?? highlightCode(replaceTabs(normalizeDisplayText(code)), PYTHON_LANG);
	const lines = trimTrailingEmptyLines(rendered);
	const maxLines = expanded ? lines.length : CALL_COLLAPSED_CODE_LINES;
	text += `\n${lines.slice(0, maxLines).join("\n")}`;
	if (lines.length > maxLines) {
		text += `${theme.fg("muted", `\n... (${lines.length - maxLines} more lines, ${lines.length} total,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
	}
	return text;
}

function formatPythonTaskCall(args: PythonToolArgs, theme: Theme): string {
	let text = `${theme.fg("toolTitle", theme.bold("python"))} ${theme.fg("accent", args.taskId ?? "?")}`;
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

/** Split a task result text into display parts, dropping the structured header already echoed in the status line. */
function extractTaskBody(text: string): { note?: string; body: string } {
	const lines = text.split("\n");
	const markerIndex = lines.findIndex((line) => line === "output:" || line.startsWith("output: ["));
	if (markerIndex === -1) return { body: text };
	const marker = lines[markerIndex];
	const note = marker.startsWith("output: [") ? marker.slice("output: [".length, -1) : undefined;
	return { note, body: lines.slice(markerIndex + 1).join("\n") };
}

function taskStatusHeader(details: PythonDetails, duration: string, expanded: boolean, theme: Theme): string {
	const statusColor =
		details.status === "completed" ? "success" : details.status === "failed" ? "error" : details.status === "cancelled" ? "muted" : "warning";
	let text = `${theme.fg("toolTitle", theme.bold("python"))} ${theme.fg("accent", details.taskId ?? "?")} ${theme.fg(statusColor, details.status)} ${theme.fg("dim", `· ${duration}`)}`;
	if (details.ready) text += theme.fg("success", " · ready");
	if (expanded && details.pid) text += theme.fg("dim", ` · PID ${details.pid}`);
	if (expanded && details.exitCode !== undefined) text += theme.fg("dim", ` · exit ${details.exitCode ?? "unknown"}`);
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
	parts: { header?: string; output: string; note?: string; error?: string },
	options: { expanded: boolean },
	theme: Theme,
): void {
	component.clear();
	if (parts.header) component.addChild(new Text(parts.header, 0, 0));

	const output = parts.output.trim();
	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");
		if (options.expanded) {
			component.addChild(new Text(styledOutput, 0, 0));
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
						return [truncateToWidth(hint, width, "..."), ...(cache.visualLines ?? [])];
					}
					return cache.visualLines ?? [];
				},
				invalidate: () => {
					cache.width = undefined;
					cache.visualLines = undefined;
					cache.skippedCount = undefined;
				},
			});
		}
	}

	if (parts.note) component.addChild(new Text(theme.fg("warning", `[${parts.note}]`), 0, 0));
	if (parts.error) component.addChild(new Text(theme.fg("error", parts.error), 0, 0));
}

function assertValidCombination(params: {
	code?: string;
	notifyOn?: string;
	taskId?: string;
	wait?: number;
	stop?: boolean;
}): void {
	if ((params.code === undefined) === (params.taskId === undefined)) {
		throw new Error("python: provide exactly one of code or taskId");
	}
	if (params.code !== undefined) {
		if (params.stop !== undefined) throw new Error("python: stop is accepted only with taskId");
		if (params.notifyOn !== undefined && (params.notifyOn.length === 0 || Buffer.byteLength(params.notifyOn, "utf8") > 256)) {
			throw new Error("python: notifyOn must contain 1 to 256 UTF-8 bytes");
		}
		return;
	}
	if (params.notifyOn !== undefined) throw new Error("python: notifyOn is accepted only with code");
	if (params.stop && params.wait !== undefined) throw new Error("python: wait is not accepted when stop=true");
}

export default function pythonExtension(pi: ExtensionAPI): void {
	const coordinator = registerTaskCoordinator(pi, "python");
	let runtime: PythonRuntime | undefined;
	let setupError: string | undefined;
	let notifications: TaskNotificationManager | undefined;
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
	pi.registerTool({
		name: "python",
		label: "Python",
		description: TOOL_DESCRIPTION,
		promptSnippet: "Execute Python scripts",
		promptGuidelines: [
			"Use python for complex tasks and computation; every code execution starts a persistent background task.",
		],
		parameters: PythonParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			assertValidCombination(params);
			if (!runtime) throw new Error(`python: ${setupError ?? "runtime configuration could not be loaded"}`);
			const activeRuntime = runtime;
			let releaseHold = params.taskId !== undefined
				? notifications?.holdTask(params.taskId) ?? (() => {})
				: notifications?.holdSource() ?? (() => {});
			try {
				if (params.taskId !== undefined) {
					const result = params.stop
						? await activeRuntime.stopTask(params.taskId)
						: await activeRuntime.readTask(params.taskId, params.wait ?? 0, signal);
					await activeRuntime.markResultPresented(result);
					notifications?.withdrawPresented(result);
					return {
						content: [{ type: "text" as const, text: taskText(result) }],
						details: detailsForTask(result),
					};
				}

				const metadata = await activeRuntime.startTask(params.code as string, ctx.cwd, params.notifyOn);
				const releaseSource = releaseHold;
				releaseHold = notifications?.holdTask(metadata.id) ?? (() => {});
				releaseSource();
				const result = params.wait !== undefined
					? await activeRuntime.waitForTask(metadata.id, params.wait, signal)
					: await activeRuntime.readTask(metadata.id, 0);
				await activeRuntime.markResultPresented(result);
				notifications?.withdrawPresented(result);
				return {
					content: [{ type: "text" as const, text: taskText(result) }],
					details: detailsForTask(result),
				};
			} finally {
				releaseHold();
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
					typeof args?.taskId === "string" ? formatPythonTaskCall(args, theme) : theme.fg("toolTitle", theme.bold("python")),
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
			let error: string | undefined;
			let output = sanitizeOutput(resultText(result));
			if (details?.kind === "task") {
				const duration = formatDuration(Math.max(0, Date.now() - Date.parse(details.createdAt)));
				header = taskStatusHeader(details, duration, options.expanded, theme);
				const extracted = extractTaskBody(output);
				note = extracted.note;
				output = extracted.body;
				error = details.error;
				if (error && output.endsWith(`\nerror: ${error}`)) output = output.slice(0, -(`\nerror: ${error}`).length);
				if ((details.status === "starting" || details.status === "running") && output.trim() === "(no output)") output = "";
			}
			const component = (context.lastComponent as PythonResultComponent | undefined) ?? new PythonResultComponent();
			rebuildPythonResultComponent(component, { header, output, note, error }, options, theme);
			return component;
		},
	});

	pi.on("session_shutdown", async () => {
		const current = notifications;
		notifications = undefined;
		await current?.close();
		coordinator.closeSession();
	});

	pi.on("session_start", async (_event, ctx) => {
		const current = notifications;
		notifications = undefined;
		await current?.close();
		coordinator.closeSession();
		if (!runtime) {
			ctx.ui.notify(`pi-python: ${setupError ?? "runtime configuration could not be loaded"}`, "error");
			return;
		}
		runtime.setSessionId(ctx.sessionManager.getSessionId());
		coordinator.startSession(ctx, ctx.sessionManager.getSessionId());
		try {
			await Promise.all([runtime.cleanupExpired(), runtime.interpreter()]);
		} catch (error) {
			coordinator.closeSession();
			ctx.ui.notify(`pi-python: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		const manager = new TaskNotificationManager(coordinator, runtime, ctx.sessionManager.getSessionId());
		try {
			await manager.start();
			notifications = manager;
		} catch (error) {
			await manager.close();
			ctx.ui.notify(`pi-python: task notification startup failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});
}
