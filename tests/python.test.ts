import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import pythonExtension from "../src/index.ts";
import { PythonRuntime } from "../src/runtime.ts";

function createHarness() {
	let tool: Record<string, any> | undefined;
	const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
	const renderers = new Map<string, (...args: any[]) => unknown>();
	const messages: Array<{ message: unknown; options: unknown }> = [];
	const pi = {
		registerTool(definition: Record<string, any>) {
			tool = definition;
		},
		registerMessageRenderer(name: string, renderer: (...args: any[]) => unknown) {
			renderers.set(name, renderer);
		},
		sendMessage(message: unknown, options: unknown) {
			messages.push({ message, options });
		},
		on(name: string, handler: (...args: any[]) => unknown) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
	};
	pythonExtension(pi as any);
	assert.ok(tool);
	return { tool, handlers, renderers, messages };
}

async function execute(tool: Record<string, any>, params: Record<string, unknown>) {
	return tool.execute("call-1", params, undefined, undefined, { cwd: process.cwd() });
}

async function temporaryRuntime() {
	const jobDir = await mkdtemp(join(tmpdir(), "pi-python-test-"));
	const runtime = new PythonRuntime({ jobDir });
	return { runtime, jobDir };
}

describe("python extension", () => {
	it("registers concise prompt metadata and the intended flat schema", () => {
		const { tool, renderers } = createHarness();
		assert.equal(tool.name, "python");
		assert.equal(tool.promptSnippet, "Execute Python scripts");
		assert.deepEqual(tool.promptGuidelines, [
			"Use python for complex tasks and computation, both foreground and background.",
		]);
		assert.deepEqual(Object.keys(tool.parameters.properties), ["code", "background", "notifyOn", "timeout", "jobId", "wait", "stop"]);
		assert.equal(tool.executionMode, "sequential");
		assert.match(tool.description, /Exactly one of code or jobId is required/);
		assert.equal(renderers.has("pi-python-job-notification"), true);
	});

	it("runs foreground Python and reports non-zero exits as errors", async () => {
		const { tool } = createHarness();
		const result = await execute(tool, { code: "print('hello from python')" });
		assert.equal(result.details.status, "completed");
		assert.equal(result.details.exitCode, 0);
		assert.equal(result.content[0].text, "hello from python");
		await assert.rejects(execute(tool, { code: "raise RuntimeError('boom')" }), /RuntimeError: boom[\s\S]*exited with code 1/);
	});

	it("starts and closes session-scoped notification resources", async () => {
		const { handlers } = createHarness();
		const notifications: string[] = [];
		const widgets: unknown[] = [];
		const ctx = {
			cwd: process.cwd(),
			mode: "rpc",
			hasUI: true,
			sessionManager: { getSessionId: () => "extension-session" },
			ui: {
				notify: (message: string) => notifications.push(message),
				setWidget: (_key: string, content: unknown) => widgets.push(content),
			},
		};
		await handlers.get("session_start")?.[0]?.({}, ctx);
		assert.deepEqual(notifications, []);
		await handlers.get("session_shutdown")?.[0]?.({}, ctx);
		assert.equal(widgets.at(-1), undefined);
	});

	it("terminates foreground execution on timeout", async () => {
		const { runtime, jobDir } = await temporaryRuntime();
		try {
			const startedAt = Date.now();
			await assert.rejects(
				runtime.runForeground({
					code: "import time\ntime.sleep(60)",
					cwd: process.cwd(),
					timeout: 0.1,
					onData() {},
				}),
				/timed out after 0.1 seconds/,
			);
			assert.ok(Date.now() - startedAt < 3000);
		} finally {
			await rm(jobDir, { recursive: true, force: true });
		}
	});

	it("rejects ambiguous parameter combinations", async () => {
		const { tool } = createHarness();
		await assert.rejects(execute(tool, {}), /exactly one of code or jobId/);
		await assert.rejects(execute(tool, { code: "print(1)", jobId: "py-12345678" }), /exactly one/);
		await assert.rejects(execute(tool, { code: "print(1)", background: true, timeout: 1 }), /foreground/);
		await assert.rejects(execute(tool, { code: "print(1)", notifyOn: "ready" }), /background=true/);
		await assert.rejects(execute(tool, { code: "print(1)", background: true, notifyOn: "界".repeat(86) }), /256 UTF-8 bytes/);
		await assert.rejects(execute(tool, { jobId: "py-12345678", wait: 1, stop: true }), /wait is not accepted/);
	});

	it("runs detached jobs and consumes their output incrementally", async () => {
		const { runtime, jobDir } = await temporaryRuntime();
		try {
			const job = await runtime.startBackground(
				"import time\nprint('first', flush=True)\ntime.sleep(0.5)\nprint('second', flush=True)",
				process.cwd(),
			);
			assert.equal(job.status, "running");
			assert.ok(job.pid);

			const first = await runtime.readJob(job.id, 0.3);
			assert.match(first.output, /first/);
			const second = await runtime.readJob(job.id, 2);
			assert.match(second.output, /second/);
			assert.doesNotMatch(second.output, /first/);
			// The supervisor records the terminal status asynchronously after the
			// child exits, so it can lag the final output chunk; poll for it.
			let final = second;
			const deadline = Date.now() + 5000;
			while (final.metadata.status === "running" && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 50));
				final = await runtime.readJob(job.id);
			}
			assert.equal(final.metadata.status, "completed");
			assert.equal(final.metadata.exitCode, 0);
		} finally {
			await rm(jobDir, { recursive: true, force: true });
		}
	});

	it("recovers a completed job from a fresh runtime", async () => {
		const { runtime, jobDir } = await temporaryRuntime();
		try {
			const job = await runtime.startBackground("print('persisted', flush=True)", process.cwd());
			const restored = new PythonRuntime({ jobDir });
			// A fresh runtime instance recovers the job from disk. The supervisor
			// records the terminal status asynchronously after the output appears,
			// so poll (accumulating consumed output) until the status settles.
			const deadline = Date.now() + 5000;
			let result = await restored.readJob(job.id, 1);
			let output = result.output;
			while (result.metadata.status === "running" && Date.now() < deadline) {
				result = await restored.readJob(job.id, 1);
				output += result.output;
			}
			assert.equal(result.metadata.status, "completed");
			assert.match(output, /persisted/);
		} finally {
			await rm(jobDir, { recursive: true, force: true });
		}
	});

	it("stops the whole detached job and preserves final status", async () => {
		const { runtime, jobDir } = await temporaryRuntime();
		try {
			const job = await runtime.startBackground(
				"import time\nprint('started', flush=True)\ntime.sleep(60)",
				process.cwd(),
			);
			const started = await runtime.readJob(job.id, 1);
			assert.match(started.output, /started/);
			const stopped = await runtime.stopJob(job.id);
			assert.equal(stopped.metadata.status, "stopped");
			const reread = await runtime.readJob(job.id);
			assert.equal(reread.metadata.status, "stopped");
		} finally {
			await rm(jobDir, { recursive: true, force: true });
		}
	});
});
