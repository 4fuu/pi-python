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
		const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
		const temporary = `${config.metaPath}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
		await rename(temporary, config.metaPath);
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
const child = spawn(config.executable, [...config.prefixArgs, "-u", config.codePath], {
	cwd: config.cwd,
	env: process.env,
	stdio: ["ignore", logFd, logFd],
	windowsHide: true,
});

let started = false;

child.once("spawn", async () => {
	started = true;
	await writeMetadata({ status: "running", supervisorPid: process.pid, pid: child.pid });
	notify({ type: "ready", pid: child.pid });
	if (process.connected) process.disconnect();
});

child.once("error", async (error) => {
	await writeMetadata({ status: "failed", exitCode: null, error: error.message });
	notify({ type: "error", error: error.message });
	if (process.connected) process.disconnect();
	closeSync(logFd);
	process.exitCode = 1;
});

child.once("exit", async (code, signal) => {
	if (!started) return;
	const status = code === 0 ? "completed" : "failed";
	await writeMetadata({
		status,
		exitCode: code,
		...(signal ? { error: `Python exited after signal ${signal}` } : {}),
	});
	closeSync(logFd);
});
