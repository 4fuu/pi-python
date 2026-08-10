import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
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
	const eventHandlers = new Map<string, Array<(event: unknown) => void>>();
	const pi = {
		events: {
			on(name: string, handler: (event: unknown) => void) {
				eventHandlers.set(name, [...(eventHandlers.get(name) ?? []), handler]);
			},
			emit(name: string, event: unknown) {
				for (const handler of eventHandlers.get(name) ?? []) handler(event);
			},
		},
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
		assert.equal(renderers.has("pi-background-task-notification"), true);
	});

	it("renders call, status, and output without blank spacer rows", () => {
		const { tool } = createHarness();
		const theme = { fg: (_tone: string, text: string) => text, bold: (text: string) => text };
		const call = tool.renderCall(
			{ code: "print('compact')" }, theme,
			{ state: {}, argsComplete: true, expanded: false, executionStarted: false },
		);
		assert.deepEqual(call.render(100).map((line: string) => line.trimEnd()), ["python", "print('compact')"]);
		const createdAt = new Date().toISOString();
		const result = tool.renderResult(
			{ content: [{ type: "text", text: "taskId: py_12345678\nstatus: completed\noutput:\ncompact" }], details: {
				version: 1, kind: "task", taskId: "py_12345678", status: "completed", createdAt, ready: false, omittedBytes: 0,
			} },
			{ expanded: false, isPartial: false }, theme,
			{ state: {}, isError: false, invalidate() {} },
		);
		const lines = result.render(100).map((line: string) => line.trimEnd());
		assert.equal(lines.some((line: string) => line === ""), false);
		assert.match(lines[0], /^python py_12345678 completed/);
		assert.equal(lines.at(-1), "compact");
	});

	it("keeps model task text compact while preserving rich details and empty-output TUI", async () => {
		const originalReadTask = PythonRuntime.prototype.readTask;
		const originalMarkResultPresented = PythonRuntime.prototype.markResultPresented;
		const createdAt = new Date().toISOString();
		try {
			PythonRuntime.prototype.readTask = async () => ({
				metadata: {
					version: 2, id: "py_12345678", instanceId: "a".repeat(32), sessionId: "", supervisorPid: 1,
					pid: 4321, cwd: process.cwd(), createdAt, updatedAt: createdAt, status: "completed", exitCode: 0,
				},
				output: "", omittedBytes: 0, ready: true,
			});
			PythonRuntime.prototype.markResultPresented = async () => {};
			const { tool } = createHarness();
			const result = await execute(tool, { taskId: "py_12345678" });
			assert.equal(result.content[0].text, "taskId: py_12345678\nstatus: completed");
			assert.equal(result.details.pid, 4321);
			assert.equal(result.details.exitCode, 0);
			assert.equal(result.details.ready, true);

			const theme = { fg: (_tone: string, text: string) => text, bold: (text: string) => text };
			const component = tool.renderResult(result, { expanded: true, isPartial: false }, theme, {
				state: {}, isError: false, invalidate() {},
			});
			const rendered = component.render(120).join("\n");
			assert.match(rendered, /PID 4321/);
			assert.match(rendered, /exit 0/);
			assert.match(rendered, /\(no output\)/);
			assert.doesNotMatch(rendered, /taskId:|status:/);
		} finally {
			PythonRuntime.prototype.readTask = originalReadTask;
			PythonRuntime.prototype.markResultPresented = originalMarkResultPresented;
		}
	});

	it("adds diagnostics only for metadata infrastructure errors", async () => {
		const originalReadTask = PythonRuntime.prototype.readTask;
		const originalMarkResultPresented = PythonRuntime.prototype.markResultPresented;
		const originalTaskDirectoryPath = PythonRuntime.prototype.taskDirectoryPath;
		const createdAt = new Date().toISOString();
		const diagnosticsPath = await mkdtemp(join(tmpdir(), "pi-python-diagnostics-"));
		try {
			PythonRuntime.prototype.markResultPresented = async () => {};
			PythonRuntime.prototype.taskDirectoryPath = () => diagnosticsPath;
			PythonRuntime.prototype.readTask = async (id) => ({
				metadata: {
					version: 2, id, instanceId: "b".repeat(32), sessionId: "", supervisorPid: 1, cwd: process.cwd(),
					createdAt, updatedAt: createdAt, status: "failed", exitCode: 1, error: "launcher broke", failureKind: "infrastructure",
				}, output: "partial", omittedBytes: 7,
			});
			const { tool } = createHarness();
			const result = await execute(tool, { taskId: "py_12345678" });
			assert.match(result.content[0].text, /exitCode: 1/);
			assert.match(result.content[0].text, /output: \[7 earlier bytes omitted\]\npartial/);
			assert.match(result.content[0].text, /error: launcher broke/);
			assert.equal(result.content[0].text.includes(`diagnosticsPath: ${result.details.diagnosticsPath}`), true);
			assert.equal(result.details.output, "partial");
			const theme = { fg: (_tone: string, text: string) => text, bold: (text: string) => text };
			const rendered = tool.renderResult(result, { expanded: true, isPartial: false }, theme, {
				state: {}, isError: false, invalidate() {},
			}).render(120).join("\n");
			assert.match(rendered, /7 earlier bytes omitted/);
			assert.match(rendered, /partial/);
			assert.match(rendered, /Diagnostics:/);

			PythonRuntime.prototype.readTask = async (id) => ({
				metadata: {
					version: 2, id, instanceId: "c".repeat(32), sessionId: "", supervisorPid: 1, cwd: process.cwd(),
					createdAt, updatedAt: createdAt, status: "failed", exitCode: null, error: "Python exited after signal SIGTERM",
				}, output: "", omittedBytes: 0,
			});
			const signalFailure = await execute(tool, { taskId: "py_87654321" });
			assert.match(signalFailure.content[0].text, /error: Python exited after signal SIGTERM/);
			assert.doesNotMatch(signalFailure.content[0].text, /diagnosticsPath/);
		} finally {
			PythonRuntime.prototype.readTask = originalReadTask;
			PythonRuntime.prototype.markResultPresented = originalMarkResultPresented;
			PythonRuntime.prototype.taskDirectoryPath = originalTaskDirectoryPath;
			await rm(diagnosticsPath, { recursive: true, force: true });
		}
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

	it("takes a real zero-wait snapshot before suppressing a fast terminal notification", async () => {
		const originalStartTask = PythonRuntime.prototype.startTask;
		const originalReadTask = PythonRuntime.prototype.readTask;
		const originalMarkResultPresented = PythonRuntime.prototype.markResultPresented;
		const createdAt = new Date().toISOString();
		let presentedOutput: string | undefined;
		try {
			PythonRuntime.prototype.startTask = async () => ({
				version: 2, id: "py_12345678", instanceId: "a".repeat(32), sessionId: "", supervisorPid: 1,
				cwd: process.cwd(), createdAt, updatedAt: createdAt, status: "completed", exitCode: 0,
			});
			PythonRuntime.prototype.readTask = async (_id, wait, signal) => {
				assert.equal(wait, 0);
				assert.equal(signal, undefined);
				return {
					metadata: await PythonRuntime.prototype.startTask("", ""),
					output: "fast output",
					omittedBytes: 0,
				};
			};
			PythonRuntime.prototype.markResultPresented = async (result) => { presentedOutput = result.output; };

			const { tool } = createHarness();
			const result = await execute(tool, { code: "print('fast output')" });
			assert.match(result.content[0].text, /fast output/);
			assert.equal(presentedOutput, "fast output");
		} finally {
			PythonRuntime.prototype.startTask = originalStartTask;
			PythonRuntime.prototype.readTask = originalReadTask;
			PythonRuntime.prototype.markResultPresented = originalMarkResultPresented;
		}
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

	it("retains an existing diagnostic directory when launcher startup fails", async () => {
		const taskDir = await mkdtemp(join(tmpdir(), "pi-python-startup-diagnostic-"));
		const runtime = new PythonRuntime({ taskDir, launcherPath: join(taskDir, "missing-launcher.mjs") });
		try {
			await assert.rejects(runtime.startTask("print('never runs')", process.cwd()), (error: Error) => {
				const match = error.message.match(/diagnosticsPath: (.+)$/m);
				assert.ok(match);
				const directory = match[1];
				assert.equal(existsSync(directory), true);
				for (const name of ["main.py", "output.log", "meta.json", "config.json"]) assert.equal(existsSync(join(directory, name)), true);
				return true;
			});
			const [entry] = await readdir(taskDir);
			const metadata = JSON.parse(await readFile(join(taskDir, entry, "meta.json"), "utf8"));
			assert.equal(metadata.status, "failed");
			assert.equal(metadata.failureKind, "infrastructure");
			assert.match(metadata.error, /launcher exited during startup/);
			assert.match(await readFile(join(taskDir, entry, "output.log"), "utf8"), /startup failure/);
			assert.equal(existsSync(join(taskDir, entry, `${metadata.instanceId}.exit.presented`)), true);
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
