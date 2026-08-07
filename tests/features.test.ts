import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, it } from "node:test";
import { ConfigError, DEFAULT_CONFIG, loadConfig } from "../src/config.ts";
import { JobNotificationManager } from "../src/job-notifications.ts";
import { PythonRuntime, runtimeEnvironment, type JobMetadata } from "../src/runtime.ts";

async function waitForTerminal(runtime: PythonRuntime, id: string): Promise<JobMetadata> {
	const deadline = Date.now() + 5000;
	let metadata = await runtime.getJobMetadata(id);
	while ((metadata.status === "starting" || metadata.status === "running") && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 50));
		metadata = await runtime.getJobMetadata(id);
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

	it("does not hang when a descendant inherits foreground stdio", async () => {
		const runtime = new PythonRuntime();
		let output = "";
		const startedAt = Date.now();
		const exitCode = await runtime.runForeground({
			code: [
				"import subprocess, sys",
				"subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(1.2)'], stdout=sys.stdout, stderr=sys.stderr)",
				"print('parent finished', flush=True)",
			].join("\n"),
			cwd: process.cwd(),
			onData: (chunk) => (output += chunk.toString("utf8")),
		});
		assert.equal(exitCode, 0);
		assert.match(output, /parent finished/);
		assert.ok(Date.now() - startedAt < 900, "foreground wait should not follow the inherited pipe until the descendant exits");
	});

	it("keeps version 1 job records readable", async () => {
		const jobDir = await mkdtemp(join(tmpdir(), "pi-python-v1-"));
		const id = "py-1234abcd";
		const directory = join(jobDir, id);
		try {
			await mkdir(directory);
			const now = new Date().toISOString();
			await Promise.all([
				writeFile(join(directory, "output.log"), "legacy output\n"),
				writeFile(join(directory, "cursor"), "0"),
				writeFile(join(directory, "meta.json"), JSON.stringify({
					version: 1,
					id,
					supervisorPid: 0,
					cwd: process.cwd(),
					createdAt: now,
					updatedAt: now,
					status: "completed",
					exitCode: 0,
				})),
			]);
			const result = await new PythonRuntime({ jobDir }).readJob(id);
			assert.equal(result.metadata.version, 1);
			assert.match(result.output, /legacy output/);
		} finally {
			await rm(jobDir, { recursive: true, force: true });
		}
	});
});

describe("durable job notifications", () => {
	it("reports readiness and completion once, isolates session metadata, and updates the widget", async () => {
		const jobDir = await mkdtemp(join(tmpdir(), "pi-python-notify-"));
		const messages: Array<{ message: any; options: any }> = [];
		const widgets: Array<{ key: string; content: unknown; options: unknown }> = [];
		const pi = { sendMessage: (message: any, options: any) => messages.push({ message, options }) };
		const ctx = {
			mode: "rpc",
			hasUI: true,
			ui: { setWidget: (key: string, content: unknown, options: unknown) => widgets.push({ key, content, options }) },
		};
		const runtime = new PythonRuntime({ jobDir, sessionId: "session-a" });
		const manager = new JobNotificationManager(pi as any, ctx as any, runtime, "session-a", {
			pollIntervalMs: 0,
			batchIntervalMs: 60_000,
		});
		try {
			const malformedDirectory = join(jobDir, "py-deadbeef");
			await mkdir(malformedDirectory);
			const malformedTime = new Date().toISOString();
			await writeFile(join(malformedDirectory, "meta.json"), JSON.stringify({
				version: 2,
				id: "py-deadbeef",
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
			const job = await runtime.startBackground(
				"import time\nprint('Listening on 4321', flush=True)\ntime.sleep(0.4)\nprint('done', flush=True)",
				process.cwd(),
				undefined,
				"Listening on",
			);
			assert.equal(job.version, 2);
			assert.equal(job.sessionId, "session-a");
			assert.match(job.instanceId ?? "", /^[0-9a-f]{32}$/);

			const deadline = Date.now() + 5000;
			while (!messages.some(({ message }) => message.details.jobs.some((detail: any) => detail.kind === "ready")) && Date.now() < deadline) {
				await manager.scanNow();
				await manager.flushNow();
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			const ready = messages.find(({ message }) => message.details.jobs.some((detail: any) => detail.kind === "ready"));
			assert.ok(ready);
			assert.deepEqual(ready.options, { deliverAs: "steer", triggerTurn: true });
			assert.match(ready.message.content, /UNTRUSTED JOB DATA/);
			assert.ok(widgets.some(({ content }) => Array.isArray(content) && content[0] === "python jobs · 1 running"));

			while (!messages.some(({ message }) => message.details.jobs.some((detail: any) => detail.kind === "exit")) && Date.now() < deadline) {
				await manager.scanNow();
				await manager.flushNow();
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			const exit = messages.find(({ message }) => message.details.jobs.some((detail: any) => detail.kind === "exit"));
			assert.ok(exit);
			assert.equal(exit.message.details.jobs[0].status, "completed");
			assert.match(exit.message.details.jobs[0].output, /done/);
			assert.equal(await readFile(join(runtime.jobDirectoryPath(job.id), "cursor"), "utf8"), "0");
			const manuallyRead = await runtime.readJob(job.id);
			assert.match(manuallyRead.output, /Listening on 4321/);
			assert.match(manuallyRead.output, /done/);
			const delivered = messages.length;
			await manager.scanNow();
			await manager.flushNow();
			assert.equal(messages.length, delivered);

			await manager.close();
			const resumed = new JobNotificationManager(pi as any, ctx as any, runtime, "session-a", {
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
			await rm(jobDir, { recursive: true, force: true });
		}
	});

	it("does not repeat final output when a manual read wins the delivery race", async () => {
		const jobDir = await mkdtemp(join(tmpdir(), "pi-python-notify-race-"));
		const messages: Array<{ message: any; options: any }> = [];
		const pi = { sendMessage: (message: any, options: any) => messages.push({ message, options }) };
		const ctx = { mode: "print", hasUI: false, ui: { setWidget() {} } };
		const runtime = new PythonRuntime({ jobDir, sessionId: "session-race" });
		const manager = new JobNotificationManager(pi as any, ctx as any, runtime, "session-race", {
			pollIntervalMs: 0,
			batchIntervalMs: 60_000,
		});
		try {
			await manager.start();
			const job = await runtime.startBackground("print('final output', flush=True)", process.cwd());
			const metadata = await waitForTerminal(runtime, job.id);
			assert.equal(metadata.status, "completed");

			const release = manager.deferDuringToolCall();
			await manager.scanNow();
			await manager.flushNow();
			assert.equal(messages.length, 0);
			const result = await runtime.readJob(job.id);
			assert.match(result.output, /final output/);
			assert.equal(existsSync(join(runtime.jobDirectoryPath(job.id), `${job.instanceId}.exit.presented`)), true);
			release();
			await manager.flushNow();
			assert.equal(messages.length, 1);
			assert.equal(messages[0].message.details.jobs[0].outputAlreadyReceived, true);
			assert.equal(messages[0].message.details.jobs[0].output, "");
			assert.doesNotMatch(messages[0].message.content, /final output/);
		} finally {
			await manager.close();
			await rm(jobDir, { recursive: true, force: true });
		}
	});
});
