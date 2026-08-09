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
	const taskDir = await mkdtemp(join(tmpdir(), "pi-python-test-"));
	const runtime = new PythonRuntime({ taskDir });
	return { runtime, taskDir };
}

describe("python extension", () => {
	it("registers concise prompt metadata and the intended flat schema", () => {
		const { tool, renderers } = createHarness();
		assert.equal(tool.name, "python");
		assert.equal(tool.promptSnippet, "Execute Python scripts");
		assert.deepEqual(tool.promptGuidelines, [
			"Use python for complex tasks and computation; every code execution starts a persistent background task.",
		]);
		assert.deepEqual(Object.keys(tool.parameters.properties), ["code", "notifyOn", "taskId", "wait", "stop"]);
		assert.equal(tool.executionMode, "sequential");
		assert.match(tool.description, /Exactly one of code or taskId is required/);
		assert.equal(renderers.has("pi-python-task-notification"), true);
	});

	it("starts every call persistently and supports startup wait", async () => {
		const { tool } = createHarness();
		const result = await execute(tool, { code: "print('hello from python')", wait: 2 });
		assert.equal(result.details.status, "completed");
		assert.equal(result.details.exitCode, 0);
		assert.match(result.details.taskId, /^py_[0-9a-f]{8}$/);
		assert.match(result.content[0].text, /hello from python/);
		const failed = await execute(tool, { code: "raise RuntimeError('boom')", wait: 2 });
		assert.equal(failed.details.status, "failed");
		assert.match(failed.content[0].text, /RuntimeError: boom/);
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

	it("rejects ambiguous parameter combinations", async () => {
		const { tool } = createHarness();
		await assert.rejects(execute(tool, {}), /exactly one of code or taskId/);
		await assert.rejects(execute(tool, { code: "print(1)", taskId: "py_12345678" }), /exactly one/);
		await assert.rejects(execute(tool, { code: "print(1)", notifyOn: "界".repeat(86) }), /256 UTF-8 bytes/);
		await assert.rejects(execute(tool, { taskId: "py_12345678", notifyOn: "ready" }), /only with code/);
		await assert.rejects(execute(tool, { taskId: "py_12345678", wait: 1, stop: true }), /wait is not accepted/);
	});

	it("runs detached tasks and returns idempotent output snapshots", async () => {
		const { runtime, taskDir } = await temporaryRuntime();
		try {
			const task = await runtime.startTask(
				"import time\nprint('first', flush=True)\ntime.sleep(0.5)\nprint('second', flush=True)",
				process.cwd(),
			);
			assert.equal(task.status, "running");
			assert.ok(task.pid);

			const first = await runtime.readTask(task.id, 0.3);
			assert.match(first.output, /first/);
			const second = await runtime.readTask(task.id, 2);
			assert.match(second.output, /second/);
			assert.match(second.output, /first/);
			assert.equal((await runtime.readTask(task.id)).output, second.output);
			// The supervisor records the terminal status asynchronously after the
			// child exits, so it can lag the final output chunk; poll for it.
			let final = second;
			const deadline = Date.now() + 5000;
			while (final.metadata.status === "running" && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 50));
				final = await runtime.readTask(task.id);
			}
			assert.equal(final.metadata.status, "completed");
			assert.equal(final.metadata.exitCode, 0);
		} finally {
			await rm(taskDir, { recursive: true, force: true });
		}
	});

	it("recovers a completed task from a fresh runtime", async () => {
		const { runtime, taskDir } = await temporaryRuntime();
		try {
			const task = await runtime.startTask("print('persisted', flush=True)", process.cwd());
			const restored = new PythonRuntime({ taskDir });
			// A fresh runtime instance recovers the task from disk. The supervisor
			// records the terminal status asynchronously after the output appears,
			// so poll (accumulating consumed output) until the status settles.
			const deadline = Date.now() + 5000;
			let result = await restored.readTask(task.id, 1);
			let output = result.output;
			while (result.metadata.status === "running" && Date.now() < deadline) {
				result = await restored.readTask(task.id, 1);
				output += result.output;
			}
			assert.equal(result.metadata.status, "completed");
			assert.match(output, /persisted/);
		} finally {
			await rm(taskDir, { recursive: true, force: true });
		}
	});

	it("stops the whole detached task and preserves final status", async () => {
		const { runtime, taskDir } = await temporaryRuntime();
		try {
			const task = await runtime.startTask(
				"import time\nprint('started', flush=True)\ntime.sleep(60)",
				process.cwd(),
			);
			const started = await runtime.readTask(task.id, 1);
			assert.match(started.output, /started/);
			const cancelled = await runtime.stopTask(task.id);
			assert.equal(cancelled.metadata.status, "cancelled");
			const reread = await runtime.readTask(task.id);
			assert.equal(reread.metadata.status, "cancelled");
		} finally {
			await rm(taskDir, { recursive: true, force: true });
		}
	});
});
