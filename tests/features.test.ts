import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, it } from "node:test";
import { ConfigError, DEFAULT_CONFIG, loadConfig } from "../src/config.ts";
import { TaskNotificationManager } from "../src/task-notifications.ts";
import { PythonRuntime, runtimeEnvironment, type TaskMetadata } from "../src/runtime.ts";

async function waitForTerminal(runtime: PythonRuntime, id: string): Promise<TaskMetadata> {
	const deadline = Date.now() + 5000;
	let metadata = await runtime.getTaskMetadata(id);
	while ((metadata.status === "starting" || metadata.status === "running") && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 50));
		metadata = await runtime.getTaskMetadata(id);
	}
	return metadata;
}

describe("configuration and runtime hardening", () => {
	it("loads strict configuration with environment precedence", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-python-config-"));
		try {
			assert.deepEqual(loadConfig({ agentDir: directory, env: {} }).config, DEFAULT_CONFIG);
			await writeFile(join(directory, "python.json"), JSON.stringify({ utf8: false, unbuffered: false }));
			const loaded = loadConfig({
				agentDir: directory,
				env: { PI_PYTHON_UNBUFFERED: "yes" },
			});
			assert.equal(loaded.config.utf8, false);
			assert.equal(loaded.config.unbuffered, true);

			await writeFile(join(directory, "python.json"), JSON.stringify({ typo: true }));
			assert.throws(() => loadConfig({ agentDir: directory, env: {} }), ConfigError);
			assert.throws(
				() => loadConfig({ agentDir: directory, env: { PI_PYTHON_CONFIG: join(directory, "missing.json") } }),
				/configured file was not found/,
			);
			assert.throws(() => loadConfig({ agentDir: directory, env: { PI_PYTHON_UTF8: "maybe" } }), ConfigError);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("preserves caller environment and pins an absolute Python 3 executable", async () => {
		assert.deepEqual(runtimeEnvironment({ utf8: false, unbuffered: false }, {}), {});
		assert.deepEqual(runtimeEnvironment({ utf8: true, unbuffered: true }, { PYTHONUTF8: "0" }), {
			PYTHONUTF8: "0",
			PYTHONIOENCODING: "utf-8",
			PYTHONUNBUFFERED: "1",
		});
		const runtime = new PythonRuntime();
		const interpreter = await runtime.interpreter();
		assert.match(interpreter.version, /^Python 3\./);
		assert.equal(isAbsolute(interpreter.executable), true);
	});

	it("rejects cross-session query, wait, and stop", async () => {
		const taskDir = await mkdtemp(join(tmpdir(), "pi-python-owner-"));
		try {
			const owner = new PythonRuntime({ taskDir, sessionId: "owner" });
			const other = new PythonRuntime({ taskDir, sessionId: "other" });
			const task = await owner.startTask("import time\ntime.sleep(60)", process.cwd());
			await assert.rejects(other.readTask(task.id), /different session/);
			await assert.rejects(other.waitForTask(task.id, 0), /different session/);
			await assert.rejects(other.stopTask(task.id), /different session/);
			const staleId = "py_deadbeef";
			const staleDirectory = join(taskDir, staleId);
			await mkdir(staleDirectory, { mode: 0o700 });
			const stale = {
				...task,
				id: staleId,
				instanceId: "e".repeat(32),
				supervisorPid: 99999999,
				pid: undefined,
				status: "running",
			};
			await writeFile(join(staleDirectory, "meta.json"), JSON.stringify(stale));
			await writeFile(join(staleDirectory, "output.log"), "");
			await assert.rejects(other.readTask(staleId), /different session/);
			assert.deepEqual(await other.listTasks("other"), []);
			assert.deepEqual(JSON.parse(await readFile(join(staleDirectory, "meta.json"), "utf8")), JSON.parse(JSON.stringify(stale)));
			await owner.stopTask(task.id);
		} finally {
			await rm(taskDir, { recursive: true, force: true });
		}
	});
});

describe("durable task notifications", () => {
	it("detects UTF-8 literal readiness across scan chunks before more than 50KB of later output", async () => {
		const taskDir = await mkdtemp(join(tmpdir(), "pi-python-ready-full-"));
		const runtime = new PythonRuntime({ taskDir, sessionId: "ready-session" });
		try {
			const pattern = "界READY";
			const task = await runtime.startTask(
				[
					"import sys, time",
					"sys.stdout.buffer.write(b'a' * 65534 + '界READY'.encode() + b'z' * 60000)",
					"sys.stdout.buffer.flush()",
					"time.sleep(0.2)",
				].join("\n"),
				process.cwd(),
				pattern,
			);
			const result = await runtime.readTask(task.id, 3);
			assert.equal(result.ready, true);
			assert.ok(result.omittedBytes > 50_000);
			assert.equal(existsSync(join(runtime.taskDirectoryPath(task.id), `${task.instanceId}.ready.detected`)), true);
		} finally {
			await rm(taskDir, { recursive: true, force: true });
		}
	});

	it("aborting a poll ends only the wait and leaves no abort listener", async () => {
		const taskDir = await mkdtemp(join(tmpdir(), "pi-python-abort-wait-"));
		const runtime = new PythonRuntime({ taskDir, sessionId: "abort-session" });
		try {
			const task = await runtime.startTask("import time\ntime.sleep(60)", process.cwd());
			const controller = new AbortController();
			const waiting = runtime.readTask(task.id, 30, controller.signal);
			setTimeout(() => controller.abort(), 50);
			await assert.rejects(waiting, /abort/i);
			assert.equal((await runtime.getTaskMetadata(task.id)).status, "running");
			await runtime.stopTask(task.id);
		} finally {
			await rm(taskDir, { recursive: true, force: true });
		}
	});

	it("reports readiness and completion once, isolates session metadata, and updates the widget", async () => {
		const taskDir = await mkdtemp(join(tmpdir(), "pi-python-notify-"));
		const messages: Array<{ message: any; options: any }> = [];
		const widgets: Array<{ key: string; content: unknown; options: unknown }> = [];
		const pi = { sendMessage: (message: any, options: any) => messages.push({ message, options }) };
		const ctx = {
			mode: "rpc",
			hasUI: true,
			ui: { setWidget: (key: string, content: unknown, options: unknown) => widgets.push({ key, content, options }) },
		};
		const runtime = new PythonRuntime({ taskDir, sessionId: "session-a" });
		const manager = new TaskNotificationManager(pi as any, ctx as any, runtime, "session-a", {
			pollIntervalMs: 0,
			batchIntervalMs: 60_000,
		});
		try {
			const malformedDirectory = join(taskDir, "py_deadbeef");
			await mkdir(malformedDirectory);
			const malformedTime = new Date().toISOString();
			await writeFile(join(malformedDirectory, "meta.json"), JSON.stringify({
				version: 2,
				id: "py_deadbeef",
				instanceId: "d".repeat(32),
				sessionId: "session-a",
				supervisorPid: process.pid,
				cwd: process.cwd(),
				createdAt: malformedTime,
				updatedAt: malformedTime,
				status: "running",
				notifyOn: 42,
			}));
			await manager.start();
			const task = await runtime.startTask(
				"import time\nprint('Listening on 4321', flush=True)\ntime.sleep(0.4)\nprint('done', flush=True)",
				process.cwd(),
				"Listening on",
			);
			assert.equal(task.version, 2);
			assert.equal(task.sessionId, "session-a");
			assert.match(task.instanceId ?? "", /^[0-9a-f]{32}$/);

			const deadline = Date.now() + 5000;
			while (!messages.some(({ message }) => message.details.tasks.some((detail: any) => detail.kind === "ready")) && Date.now() < deadline) {
				await manager.scanNow();
				await manager.flushNow();
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			const ready = messages.find(({ message }) => message.details.tasks.some((detail: any) => detail.kind === "ready"));
			assert.ok(ready);
			assert.deepEqual(ready.options, { deliverAs: "steer", triggerTurn: true });
			assert.match(ready.message.content, /TASK DATA/);
			assert.ok(widgets.some(({ content }) => Array.isArray(content) && /^py_/.test(String(content[0]))));

			while (!messages.some(({ message }) => message.details.tasks.some((detail: any) => detail.kind === "exit")) && Date.now() < deadline) {
				await manager.scanNow();
				await manager.flushNow();
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			const exit = messages.find(({ message }) => message.details.tasks.some((detail: any) => detail.kind === "exit"));
			assert.ok(exit);
			assert.equal(exit.message.details.tasks[0].status, "completed");
			assert.match(exit.message.details.tasks[0].output, /done/);
			const manuallyRead = await runtime.readTask(task.id);
			assert.match(manuallyRead.output, /Listening on 4321/);
			assert.match(manuallyRead.output, /done/);
			const delivered = messages.length;
			await manager.scanNow();
			await manager.flushNow();
			assert.equal(messages.length, delivered);

			await manager.close();
			const resumed = new TaskNotificationManager(pi as any, ctx as any, runtime, "session-a", {
				pollIntervalMs: 0,
				batchIntervalMs: 60_000,
			});
			await resumed.start();
			await resumed.flushNow();
			assert.equal(messages.length, delivered);
			await resumed.close();
			assert.equal(widgets.at(-1)?.content, undefined);
		} finally {
			await manager.close();
			await rm(taskDir, { recursive: true, force: true });
		}
	});

	it("does not repeat final output when a manual read wins the delivery race", async () => {
		const taskDir = await mkdtemp(join(tmpdir(), "pi-python-notify-race-"));
		const messages: Array<{ message: any; options: any }> = [];
		const pi = { sendMessage: (message: any, options: any) => messages.push({ message, options }) };
		const ctx = { mode: "print", hasUI: false, ui: { setWidget() {} } };
		const runtime = new PythonRuntime({ taskDir, sessionId: "session-race" });
		const manager = new TaskNotificationManager(pi as any, ctx as any, runtime, "session-race", {
			pollIntervalMs: 0,
			batchIntervalMs: 60_000,
		});
		try {
			await manager.start();
			const task = await runtime.startTask("print('final output', flush=True)", process.cwd());
			const metadata = await waitForTerminal(runtime, task.id);
			assert.equal(metadata.status, "completed");

			const release = manager.deferDuringToolCall();
			await manager.scanNow();
			await manager.flushNow();
			assert.equal(messages.length, 0);
			const result = await runtime.readTask(task.id);
			assert.match(result.output, /final output/);
			assert.equal(existsSync(join(runtime.taskDirectoryPath(task.id), `${task.instanceId}.exit.presented`)), true);
			release();
			await manager.flushNow();
			assert.equal(messages.length, 1);
			assert.equal(messages[0].message.details.tasks[0].outputAlreadyReceived, true);
			assert.equal(messages[0].message.details.tasks[0].output, "");
			assert.doesNotMatch(messages[0].message.content, /final output/);
		} finally {
			await manager.close();
			await rm(taskDir, { recursive: true, force: true });
		}
	});

	it("retries failed delivery and recovers an expired notification lease", async () => {
		const taskDir = await mkdtemp(join(tmpdir(), "pi-python-notify-lease-"));
		let attempts = 0;
		const messages: unknown[] = [];
		const pi = { sendMessage: (message: unknown) => {
			attempts++;
			if (attempts === 1) throw new Error("injected send failure");
			messages.push(message);
		} };
		const ctx = { mode: "print", hasUI: false, ui: { setWidget() {} } };
		const runtime = new PythonRuntime({ taskDir, sessionId: "session-lease" });
		const manager = new TaskNotificationManager(pi as any, ctx as any, runtime, "session-lease", {
			pollIntervalMs: 0,
			batchIntervalMs: 60_000,
		});
		try {
			await manager.start();
			const task = await runtime.startTask("print('done', flush=True)", process.cwd());
			await waitForTerminal(runtime, task.id);
			const lease = join(runtime.taskDirectoryPath(task.id), `${task.instanceId}.exit.notifying`);
			await writeFile(lease, "", { mode: 0o600 });
			const stale = new Date(Date.now() - 60_000);
			await utimes(lease, stale, stale);
			await manager.scanNow();
			await manager.flushNow();
			assert.equal(attempts, 1);
			assert.equal(existsSync(lease), false);
			await manager.flushNow();
			assert.equal(attempts, 2);
			assert.equal(messages.length, 1);
			assert.equal(existsSync(join(runtime.taskDirectoryPath(task.id), `${task.instanceId}.exit.notified`)), true);
		} finally {
			await manager.close();
			await rm(taskDir, { recursive: true, force: true });
		}
	});
});
