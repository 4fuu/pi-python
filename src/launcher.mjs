import { closeSync, openSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const configPath = process.argv[2];
if (!configPath) throw new Error("Missing background job configuration path");

const config = JSON.parse(await readFile(configPath, "utf8"));

let metadataTail = Promise.resolve();

function writeMetadata(patch) {
	const update = async () => {
		const current = JSON.parse(await readFile(config.metaPath, "utf8"));
		if (current.id !== config.id || current.instanceId !== config.instanceId) return false;
		const terminal = current.status === "completed" || current.status === "failed" || current.status === "stopped";
		if (terminal) return false;
		if (patch.status === "running" && current.status !== "starting") return false;
		const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
		const temporary = `${config.metaPath}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
		await rename(temporary, config.metaPath);
		return true;
	};
	metadataTail = metadataTail.then(update, update);
	return metadataTail;
}

function notify(message) {
	if (!process.connected || !process.send) return;
	try {
		process.send(message, () => {
			// The parent may reload or exit during startup. Delivery failure must not
			// kill an otherwise healthy persistent supervisor.
		});
	} catch {
		// The IPC channel closed between the connected check and send.
	}
}

const logFd = openSync(config.logPath, "a");
let logClosed = false;
function closeLog() {
	if (logClosed) return;
	logClosed = true;
	closeSync(logFd);
}

const pythonArgs = [...config.prefixArgs, ...(config.unbuffered === false ? [] : ["-u"]), config.codePath];
const child = spawn(config.executable, pythonArgs, {
	cwd: config.cwd,
	env: process.env,
	stdio: ["ignore", logFd, logFd],
	windowsHide: true,
});

let started = false;

child.once("spawn", () => {
	started = true;
	void (async () => {
		try {
			const published = await writeMetadata({ status: "running", supervisorPid: process.pid, pid: child.pid });
			if (!published) {
				child.kill();
				throw new Error("background job metadata was replaced during startup");
			}
			notify({ type: "ready", pid: child.pid });
		} catch (error) {
			child.kill();
			notify({ type: "error", error: error instanceof Error ? error.message : String(error) });
			closeLog();
			process.exitCode = 1;
		} finally {
			if (process.connected) process.disconnect();
		}
	})();
});

child.once("error", (error) => {
	void (async () => {
		try {
			await writeMetadata({ status: "failed", exitCode: null, error: error.message });
		} catch {
			process.exitCode = 1;
		} finally {
			notify({ type: "error", error: error.message });
			if (process.connected) process.disconnect();
			closeLog();
			process.exitCode = 1;
		}
	})();
});

child.once("exit", (code, signal) => {
	if (!started) return;
	void (async () => {
		try {
			const status = code === 0 ? "completed" : "failed";
			await writeMetadata({
				status,
				exitCode: code,
				...(signal ? { error: `Python exited after signal ${signal}` } : {}),
			});
		} catch {
			process.exitCode = 1;
		} finally {
			closeLog();
		}
	})();
});
