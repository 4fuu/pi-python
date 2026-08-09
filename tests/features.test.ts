import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
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

class FakeCoordinator {
	offers: Array<{ update: any; callbacks: any }> = [];
	active: any[] = [];
	withdrawals: any[] = [];
	offer(update: any, callbacks: any) { this.offers.push({ update, callbacks }); }
	updateActiveTasks(tasks: any[]) { this.active = tasks; }
	holdTask() { return () => {}; }
	holdSource() { return () => {}; }
	withdrawTask(...args: any[]) { this.withdrawals.push(args); }
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

	it("offers current-session readiness and terminal events with durable lifecycle callbacks", async () => {
		const taskDir = await mkdtemp(join(tmpdir(), "pi-python-notify-"));
		const coordinator = new FakeCoordinator();
		const runtime = new PythonRuntime({ taskDir, sessionId: "session-a" });
		const manager = new TaskNotificationManager(coordinator as any, runtime, "session-a", { pollIntervalMs: 0 });
		try {
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
			while (!coordinator.offers.some(({ update }) => update.event === "ready") && Date.now() < deadline) {
				await manager.scanNow();
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			const ready = coordinator.offers.find(({ update }) => update.event === "ready");
			assert.ok(ready);
			assert.equal(ready.update.eventId, `python:${task.instanceId}:ready`);
			assert.equal(ready.update.taskKey, `python:${task.id}`);
			assert.equal(ready.update.source, "python");
			assert.ok(ready.update.output.length <= 4_000);
			const readyClaim = join(runtime.taskDirectoryPath(task.id), `${task.instanceId}.ready.notifying`);
			const readySubmitted = join(runtime.taskDirectoryPath(task.id), `${task.instanceId}.ready.submitted`);
			await ready.callbacks.onSubmitted("delivery");
			assert.equal(existsSync(readyClaim), false);
			assert.equal(existsSync(readySubmitted), true);

			while (!coordinator.offers.some(({ update }) => update.event === "terminal") && Date.now() < deadline) {
				await manager.scanNow();
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			const terminal = coordinator.offers.find(({ update }) => update.event === "terminal");
			assert.ok(terminal);
			assert.equal(terminal.update.status, "completed");
			assert.match(terminal.update.output, /done/);
			await terminal.callbacks.onSubmitted("delivery");
			await terminal.callbacks.onDelivered("delivery");
			assert.equal(existsSync(join(runtime.taskDirectoryPath(task.id), `${task.instanceId}.exit.notified`)), true);
			await ready.callbacks.onWithdrawn("superseded");
			assert.equal(existsSync(readySubmitted), false);
			assert.equal(existsSync(join(runtime.taskDirectoryPath(task.id), `${task.instanceId}.ready.notified`)), true);
			const offered = coordinator.offers.length;
			await manager.scanNow();
			assert.equal(coordinator.offers.length, offered);
			const resumedCoordinator = new FakeCoordinator();
			const resumed = new TaskNotificationManager(resumedCoordinator as any, runtime, "session-a", { pollIntervalMs: 0 });
			await resumed.start();
			assert.equal(resumedCoordinator.offers.length, 0);
			await resumed.close();
		} finally {
			await manager.close();
			await rm(taskDir, { recursive: true, force: true });
		}
	});

	it("skips explicitly presented readiness and terminal events", async () => {
		const taskDir = await mkdtemp(join(tmpdir(), "pi-python-notify-race-"));
		const coordinator = new FakeCoordinator();
		const runtime = new PythonRuntime({ taskDir, sessionId: "session-race" });
		const manager = new TaskNotificationManager(coordinator as any, runtime, "session-race", { pollIntervalMs: 0 });
		try {
			await manager.start();
			const task = await runtime.startTask("print('READY', flush=True)\nimport time; time.sleep(.2)", process.cwd(), "READY");
			const result = await runtime.readTask(task.id, 2);
			assert.equal(result.ready, true);
			assert.equal(existsSync(join(runtime.taskDirectoryPath(task.id), `${task.instanceId}.ready.presented`)), true);
			await manager.scanNow();
			assert.equal(coordinator.offers.some(({ update }) => update.event === "ready"), false);
			await waitForTerminal(runtime, task.id);
			await runtime.readTask(task.id);
			assert.equal(existsSync(join(runtime.taskDirectoryPath(task.id), `${task.instanceId}.exit.presented`)), true);
			await manager.scanNow();
			assert.equal(coordinator.offers.length, 0);
		} finally {
			await manager.close();
			await rm(taskDir, { recursive: true, force: true });
		}
	});

	it("waits for an in-flight scan to stop before session shutdown completes", async () => {
		const coordinator = new FakeCoordinator();
		let releaseList!: (tasks: TaskMetadata[]) => void;
		const runtime = {
			listTasks: () => new Promise<TaskMetadata[]>((resolve) => { releaseList = resolve; }),
			taskDirectoryPath: () => "/unused",
		};
		const manager = new TaskNotificationManager(coordinator as any, runtime as any, "session-old", { pollIntervalMs: 0 });
		const starting = manager.start();
		const closing = manager.close();
		releaseList([]);
		await Promise.all([starting, closing]);
		assert.equal(coordinator.offers.length, 0);
		assert.deepEqual(coordinator.active, []);
	});

	it("recovers expired pre-submission and submitted leases without re-offering fresh submission", async () => {
		const taskDir = await mkdtemp(join(tmpdir(), "pi-python-notify-lease-"));
		const coordinator = new FakeCoordinator();
		const runtime = new PythonRuntime({ taskDir, sessionId: "session-lease" });
		const manager = new TaskNotificationManager(coordinator as any, runtime, "session-lease", { pollIntervalMs: 0 });
		try {
			await manager.start();
			const task = await runtime.startTask("print('done', flush=True)", process.cwd());
			await waitForTerminal(runtime, task.id);
			const lease = join(runtime.taskDirectoryPath(task.id), `${task.instanceId}.exit.notifying`);
			await writeFile(lease, "", { mode: 0o600 });
			const stale = new Date(Date.now() - 60_000);
			await utimes(lease, stale, stale);
			await manager.scanNow();
			assert.equal(coordinator.offers.length, 1);
			await coordinator.offers[0].callbacks.onSubmitted("delivery");
			const submitted = join(runtime.taskDirectoryPath(task.id), `${task.instanceId}.exit.submitted`);
			await utimes(submitted, stale, stale);
			await coordinator.offers[0].callbacks.onSubmitted("delivery-retry");
			assert.ok(Date.now() - (await stat(submitted)).mtimeMs < 1_000);
			await manager.close();
			const resumedCoordinator = new FakeCoordinator();
			const resumed = new TaskNotificationManager(resumedCoordinator as any, runtime, "session-lease", { pollIntervalMs: 0 });
			await resumed.start();
			assert.equal(resumedCoordinator.offers.length, 0);
			await utimes(submitted, stale, stale);
			await resumed.scanNow();
			assert.equal(resumedCoordinator.offers.length, 1);
			await resumed.close();
		} finally {
			await manager.close();
			await rm(taskDir, { recursive: true, force: true });
		}
	});
});
