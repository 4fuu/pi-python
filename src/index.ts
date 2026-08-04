import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PythonRuntime, type JobResult } from "./runtime.ts";

const MAX_CAPTURE_BYTES = 50 * 1024;

const TOOL_DESCRIPTION = `Execute Python 3 code in the current working directory, either in the foreground or as a persistent background job.

Pass code to execute it. Foreground execution is the default and streams output until Python exits. Set background=true for long-running programs; the call returns immediately with a jobId, and the process continues across tool calls, /reload, and pi restarts.

Pass jobId (without code) to read output produced since the previous read and get the current status. Set wait to briefly wait for new output or completion instead of polling repeatedly. Set stop=true with jobId to terminate the background process tree and return its final unread output.

Exactly one of code or jobId is required. timeout applies only to foreground code and terminates its process tree. wait and stop apply only to jobId. Python runs unbuffered with UTF-8 defaults. Output is limited to the most recent 50KB per result; completed job records become eligible for automatic cleanup after 24 hours.`;

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

function assertValidCombination(params: {
	code?: string;
	background?: boolean;
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
		if (params.background && params.timeout !== undefined) {
			throw new Error("python: timeout is accepted only for foreground execution");
		}
		return;
	}
	if (params.background !== undefined) throw new Error("python: background is accepted only with code");
	if (params.timeout !== undefined) throw new Error("python: timeout is accepted only with foreground code");
	if (params.stop && params.wait !== undefined) throw new Error("python: wait is not accepted when stop=true");
}

export default function pythonExtension(pi: ExtensionAPI): void {
	const runtime = new PythonRuntime();

	pi.registerTool({
		name: "python",
		label: "Python",
		description: TOOL_DESCRIPTION,
		promptSnippet: "Execute Python code and manage persistent background Python jobs",
		promptGuidelines: [
			"Use python for complex or otherwise suitable tasks; run long-lived programs in the background, then use the returned jobId to read incremental output or stop them.",
		],
		parameters: PythonParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			signal?.throwIfAborted();
			assertValidCombination(params);

			if (params.jobId !== undefined) {
				const result = params.stop
					? await runtime.stopJob(params.jobId)
					: await runtime.readJob(params.jobId, params.wait ?? 0, signal);
				return {
					content: [{ type: "text" as const, text: jobText(result) }],
					details: detailsForJob(result),
				};
			}

			const code = params.code as string;
			if (params.background) {
				const metadata = await runtime.startBackground(code, ctx.cwd, signal);
				const text = `Python job started.\njobId: ${metadata.id}\npid: ${metadata.pid}\nUse python with jobId="${metadata.id}" to read new output or stop it.`;
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
			const exitCode = await runtime.runForeground({
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
		},
	});

	pi.on("session_start", async () => {
		await runtime.cleanupExpired();
	});
}
