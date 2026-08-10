import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
	chmod,
	mkdir,
	open,
	readFile,
	readdir,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LAUNCHER_PATH = join(SOURCE_DIR, "launcher.mjs");
const DEFAULT_TASK_DIR = join(tmpdir(), "pi-python-tasks");
const TASK_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_NOTIFY_PATTERN_BYTES = 256;
const TASK_ID_PATTERN = /^py_[0-9a-f]{8}$/;
const TASK_STATUSES = new Set<TaskStatus>(["starting", "running", "completed", "failed", "cancelled"]);

export type TaskStatus = "starting" | "running" | "completed" | "failed" | "cancelled";

export interface TaskMetadata {
	version: 2;
	id: string;
	instanceId: string;
	sessionId: string;
	supervisorPid: number;
	pid?: number;
	cwd: string;
	codeSummary?: string;
	notifyOn?: string;
	createdAt: string;
	updatedAt: string;
	status: TaskStatus;
	exitCode?: number | null;
	error?: string;
	failureKind?: "infrastructure";
}

export interface TaskResult {
	metadata: TaskMetadata;
	output: string;
	omittedBytes: number;
	ready?: boolean;
}

interface Interpreter {
	executable: string;
	prefixArgs: string[];
	version: string;
}

interface RuntimeOptions {
	taskDir?: string;
	launcherPath?: string;
	interpreter?: { executable: string; prefixArgs?: string[] };
	utf8?: boolean;
	unbuffered?: boolean;
	sessionId?: string;
}

function findEnvKey(env: NodeJS.ProcessEnv, name: string): string | undefined {
	if (process.platform !== "win32") {
		return Object.prototype.hasOwnProperty.call(env, name) ? name : undefined;
	}
	const normalized = name.toUpperCase();
	return Object.keys(env).find((key) => key.toUpperCase() === normalized);
}

export function runtimeEnvironment(
	config: { utf8: boolean; unbuffered: boolean },
	baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const env = { ...baseEnv };
	const defaults: Record<string, string> = {};
	if (config.utf8) {
		defaults.PYTHONIOENCODING = "utf-8";
		defaults.PYTHONUTF8 = "1";
	}
	if (config.unbuffered) defaults.PYTHONUNBUFFERED = "1";
	for (const [name, value] of Object.entries(defaults)) {
		const existing = findEnvKey(env, name);
		if (existing === undefined || env[existing] === undefined) env[name] = value;
	}
	return env;
}

async function probe(executable: string, prefixArgs: string[]): Promise<Interpreter | undefined> {
	return new Promise((resolve) => {
		let stdout = "";
		let settled = false;
		const source = "import json, sys; print(json.dumps({'executable': sys.executable, 'version': '.'.join(map(str, sys.version_info[:3]))}))";
		const child = spawn(executable, [...prefixArgs, "-c", source], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const finish = (value: Interpreter | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(() => {
			child.kill();
			finish(undefined);
		}, 5000);
		child.stdout?.on("data", (data: Buffer) => (stdout += data.toString("utf8")));
		child.once("error", () => finish(undefined));
		child.once("close", (code) => {
			if (code !== 0) return finish(undefined);
			try {
				const result = JSON.parse(stdout.trim()) as { executable?: unknown; version?: unknown };
				if (
					typeof result.executable !== "string" ||
					!isAbsolute(result.executable) ||
					typeof result.version !== "string" ||
					!/^3(?:\.|$)/.test(result.version)
				) {
					return finish(undefined);
				}
				finish({ executable: normalize(result.executable), prefixArgs: [], version: `Python ${result.version}` });
			} catch {
				finish(undefined);
			}
		});
	});
}

const INTERPRETER_CANDIDATES = [
	{ executable: "python3", prefixArgs: [] },
	{ executable: "python", prefixArgs: [] },
];

async function findInterpreter(): Promise<Interpreter> {
	for (const candidate of INTERPRETER_CANDIDATES) {
		const found = await probe(candidate.executable, candidate.prefixArgs);
		if (found) return found;
	}
	throw new Error("python: Python 3 was not found (tried python3 and python on PATH)");
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function isProcessGroupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
		throw error;
	}
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporary, path);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		const finish = (error?: unknown) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolve();
		};
		const onAbort = () => finish(signal?.reason ?? new DOMException("This operation was aborted", "AbortError"));
		const timer = setTimeout(finish, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
	});
}

async function killProcessTree(pid: number): Promise<void> {
	if (!pid) return;
	if (process.platform === "win32") {
		const exitCode = await new Promise<number | null>((resolve, reject) => {
			const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true,
			});
			killer.once("error", reject);
			killer.once("close", resolve);
		});
		if (exitCode !== 0 && isAlive(pid)) throw new Error(`python: failed to terminate process tree ${pid}`);
		return;
	}
	try {
		process.kill(-pid, "SIGTERM");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
		throw error;
	}
	await new Promise((resolve) => setTimeout(resolve, 300));
	if (isProcessGroupAlive(pid)) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}
	const deadline = Date.now() + 2000;
	while (isProcessGroupAlive(pid) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	if (isProcessGroupAlive(pid)) throw new Error(`python: process tree ${pid} did not terminate`);
}

function isTerminal(status: TaskStatus): boolean {
	return status !== "starting" && status !== "running";
}

function summarizeCode(code: string): string {
	return code
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
		.replace(/\n/g, " ↵ ")
		.slice(0, 2000);
}

function parseTaskMetadata(value: unknown, id: string): TaskMetadata {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid metadata");
	const input = value as Record<string, unknown>;
	if (input.version !== 2 || input.id !== id) throw new Error("invalid metadata identity");
	if (!Number.isInteger(input.supervisorPid) || (input.supervisorPid as number) < 0) throw new Error("invalid supervisor PID");
	if (input.pid !== undefined && (!Number.isInteger(input.pid) || (input.pid as number) <= 0)) throw new Error("invalid process PID");
	if (typeof input.cwd !== "string") throw new Error("invalid working directory");
	if (typeof input.createdAt !== "string" || !Number.isFinite(Date.parse(input.createdAt))) throw new Error("invalid creation time");
	if (typeof input.updatedAt !== "string" || !Number.isFinite(Date.parse(input.updatedAt))) throw new Error("invalid update time");
	if (typeof input.status !== "string" || !TASK_STATUSES.has(input.status as TaskStatus)) throw new Error("invalid status");
	if (input.exitCode !== undefined && input.exitCode !== null && !Number.isInteger(input.exitCode)) throw new Error("invalid exit code");
	if (input.error !== undefined && typeof input.error !== "string") throw new Error("invalid error");
	if (input.failureKind !== undefined && input.failureKind !== "infrastructure") throw new Error("invalid failure kind");
	{
		if (typeof input.instanceId !== "string" || !/^[0-9a-f]{32}$/i.test(input.instanceId)) throw new Error("invalid instance ID");
		if (typeof input.sessionId !== "string") throw new Error("invalid session ID");
		if (input.codeSummary !== undefined && (typeof input.codeSummary !== "string" || input.codeSummary.length > 2000)) {
			throw new Error("invalid source summary");
		}
		if (
			input.notifyOn !== undefined &&
			(typeof input.notifyOn !== "string" ||
				input.notifyOn.length === 0 ||
				Buffer.byteLength(input.notifyOn, "utf8") > MAX_NOTIFY_PATTERN_BYTES)
		) {
			throw new Error("invalid readiness pattern");
		}
	}
	return input as unknown as TaskMetadata;
}

export class PythonRuntime {
	readonly taskDir: string;
	readonly launcherPath: string;
	readonly configuredInterpreter?: { executable: string; prefixArgs: string[] };
	readonly utf8: boolean;
	readonly unbuffered: boolean;
	#sessionId: string;
	#interpreter?: Promise<Interpreter>;

	constructor(options: RuntimeOptions = {}) {
		this.taskDir = options.taskDir ?? DEFAULT_TASK_DIR;
		this.launcherPath = options.launcherPath ?? DEFAULT_LAUNCHER_PATH;
		this.utf8 = options.utf8 ?? true;
		this.unbuffered = options.unbuffered ?? true;
		this.#sessionId = options.sessionId ?? "";
		this.configuredInterpreter = options.interpreter
			? { executable: options.interpreter.executable, prefixArgs: options.interpreter.prefixArgs ?? [] }
			: undefined;
	}

	setSessionId(sessionId: string): void {
		this.#sessionId = sessionId;
	}

	async interpreter(): Promise<Interpreter> {
		if (!this.#interpreter) {
			this.#interpreter = this.configuredInterpreter
				? probe(this.configuredInterpreter.executable, this.configuredInterpreter.prefixArgs).then((value) => {
						if (!value) throw new Error(`python: configured interpreter ${this.configuredInterpreter?.executable} is not Python 3`);
						return value;
					})
				: findInterpreter();
		}
		return this.#interpreter;
	}

	async startTask(code: string, cwd: string, notifyOn?: string): Promise<TaskMetadata> {
		if (notifyOn !== undefined && (notifyOn.length === 0 || Buffer.byteLength(notifyOn, "utf8") > MAX_NOTIFY_PATTERN_BYTES)) {
			throw new Error("python: notifyOn must contain 1 to 256 UTF-8 bytes");
		}
		await this.cleanupExpired();
		const interpreter = await this.interpreter();
		await mkdir(this.taskDir, { recursive: true, mode: 0o700 });
		await chmod(this.taskDir, 0o700);
		let id = "";
		let directory = "";
		for (let attempt = 0; attempt < 5; attempt++) {
			id = `py_${randomUUID().slice(0, 8)}`;
			directory = join(this.taskDir, id);
			try {
				await mkdir(directory, { mode: 0o700 });
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt === 4) throw error;
			}
		}
		const instanceId = randomUUID().replace(/-/g, "");
		const codePath = join(directory, "main.py");
		const logPath = join(directory, "output.log");
		const metaPath = join(directory, "meta.json");
		const configPath = join(directory, "config.json");
		const cancelMarkerPath = join(directory, `${instanceId}.cancelled`);
		const now = new Date().toISOString();
		const initial: TaskMetadata = {
			version: 2,
			id,
			instanceId,
			sessionId: this.#sessionId,
			supervisorPid: 0,
			cwd,
			codeSummary: summarizeCode(code),
			...(notifyOn ? { notifyOn } : {}),
			createdAt: now,
			updatedAt: now,
			status: "starting",
		};
		let supervisorPid = 0;
		try {
			await Promise.all([
				writeFile(codePath, code, { encoding: "utf8", mode: 0o600 }),
				writeFile(logPath, "", { encoding: "utf8", mode: 0o600 }),
				writeJsonAtomic(metaPath, initial),
			]);
			await writeJsonAtomic(configPath, {
				id,
				instanceId,
				executable: interpreter.executable,
				prefixArgs: interpreter.prefixArgs,
				unbuffered: this.unbuffered,
				cwd,
				codePath,
				logPath,
				metaPath,
				notifyOn,
				readyMarkerPath: join(directory, `${instanceId}.ready.detected`),
				cancelMarkerPath,
			});
			const supervisor = spawn(process.execPath, [this.launcherPath, configPath], {
				cwd,
				env: runtimeEnvironment(this),
				detached: true,
				stdio: ["ignore", "ignore", "ignore", "ipc"],
				windowsHide: true,
			});
			supervisorPid = supervisor.pid ?? 0;

			await new Promise<void>((resolve, reject) => {
				let settled = false;
				const finish = (error?: Error) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					supervisor.removeListener("error", onError);
					supervisor.removeListener("exit", onExit);
					supervisor.removeListener("message", onMessage);
					if (error) reject(error);
					else resolve();
				};
				const onError = (error: Error) => finish(error);
				const onExit = (code: number | null) => finish(new Error(`python: task launcher exited during startup (${code})`));
				const onMessage = (message: unknown) => {
					if (typeof message !== "object" || message === null) return;
					const value = message as { type?: unknown; error?: unknown };
					if (value.type === "ready") finish();
					if (value.type === "error") finish(new Error(`python: ${String(value.error)}`));
				};
				const timer = setTimeout(() => finish(new Error("python: task launcher did not start within 5 seconds")), 5000);
				supervisor.once("error", onError);
				supervisor.once("exit", onExit);
				supervisor.on("message", onMessage);
			});
			const metadata = await this.readMetadata(id);
			if (supervisor.connected) supervisor.disconnect();
			supervisor.unref();
			return metadata;
		} catch (error) {
			let metadata: TaskMetadata | undefined;
			try {
				metadata = JSON.parse(await readFile(metaPath, "utf8")) as TaskMetadata;
			} catch {
				// Startup may have failed before metadata was fully created.
			}
			const ownedMetadata = metadata?.id === id && metadata.instanceId === instanceId ? metadata : undefined;
			const startupMessage = error instanceof Error ? error.message : String(error);
			const cleanupErrors: string[] = [];
			try {
				await writeFile(cancelMarkerPath, "", { flag: "a", mode: 0o600 });
			} catch (cleanupError) {
				cleanupErrors.push(`cancel marker: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
			}
			try {
				await killProcessTree(supervisorPid || ownedMetadata?.supervisorPid || 0);
				if (process.platform === "win32" && ownedMetadata?.pid && isAlive(ownedMetadata.pid)) {
					await killProcessTree(ownedMetadata.pid);
				}
			} catch (cleanupError) {
				cleanupErrors.push(`process cleanup: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
			}
			const message = cleanupErrors.length > 0
				? `${startupMessage}; cleanup failed (${cleanupErrors.join("; ")})`
				: startupMessage;
			const failed: TaskMetadata = {
				...(ownedMetadata ?? initial),
				supervisorPid: supervisorPid || ownedMetadata?.supervisorPid || 0,
				updatedAt: new Date().toISOString(),
				status: "failed",
				exitCode: null,
				error: message,
				failureKind: "infrastructure",
			};
			// Once a task directory has been allocated it is a durable diagnostic record,
			// even when startup failed before all normal files could be written.
			await Promise.allSettled([
				existsSync(codePath) ? Promise.resolve() : writeFile(codePath, code, { encoding: "utf8", mode: 0o600 }),
				writeFile(logPath, `[pi-python startup failure] ${message}\n`, { encoding: "utf8", mode: 0o600, flag: "a" }),
				existsSync(configPath) ? Promise.resolve() : writeJsonAtomic(configPath, { id, instanceId, cwd, codePath, logPath, metaPath }),
				writeJsonAtomic(metaPath, failed),
				writeFile(join(directory, `${instanceId}.exit.presented`), "", { flag: "a", mode: 0o600 }),
			]);
			if (existsSync(directory)) throw new Error(`${message}\ndiagnosticsPath: ${directory}`);
			throw error;
		}
	}

	async readTask(id: string, waitSeconds = 0, signal?: AbortSignal): Promise<TaskResult> {
		return this.waitForTask(id, waitSeconds, signal);
	}

	/** Wait after launch for literal readiness (when configured) or a terminal state. */
	async waitForTask(id: string, waitSeconds: number, signal?: AbortSignal): Promise<TaskResult> {
		this.assertTaskId(id);
		signal?.throwIfAborted();
		const deadline = Date.now() + waitSeconds * 1000;
		let metadata = await this.refreshOwned(id);
		let snapshot = await this.snapshotOutput(id);
		let ready = existsSync(this.readyMarkerPath(metadata));
		while (!ready && !isTerminal(metadata.status) && Date.now() < deadline) {
			await delay(Math.min(50, deadline - Date.now()), signal);
			signal?.throwIfAborted();
			metadata = await this.refreshOwned(id);
			snapshot = await this.snapshotOutput(id);
			ready = existsSync(this.readyMarkerPath(metadata));
		}
		if (isTerminal(metadata.status)) await this.markTerminalPresented(metadata);
		else if (ready) await this.markPresented(metadata, "ready");
		return { metadata, ...snapshot, ...(ready ? { ready: true } : {}) };
	}

	async stopTask(id: string): Promise<TaskResult> {
		this.assertTaskId(id);
		let metadata = await this.refreshOwned(id);
		if (metadata.status === "running" || metadata.status === "starting") {
			const cancelMarker = join(this.directory(id), `${metadata.instanceId}.cancelled`);
			try {
				const handle = await open(cancelMarker, "wx");
				await handle.close();
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			const cancelled: TaskMetadata = {
				...metadata,
				status: "cancelled",
				exitCode: null,
				updatedAt: new Date().toISOString(),
			};
			await writeJsonAtomic(this.metaPath(id), cancelled);
			metadata = cancelled;
			await killProcessTree(metadata.supervisorPid);
			if (process.platform === "win32" && metadata.pid && isAlive(metadata.pid)) {
				await killProcessTree(metadata.pid);
			}
			const current = await this.readMetadata(id);
			if (current.instanceId !== metadata.instanceId || current.sessionId !== this.#sessionId) {
				throw new Error(`python: task "${id}" changed while stopping`);
			}
			// Re-publish the durable cancellation decision after the supervisor is
			// gone, closing the final metadata rename race at process exit.
			metadata = {
				...current,
				status: "cancelled",
				exitCode: null,
				error: undefined,
				failureKind: undefined,
				updatedAt: new Date().toISOString(),
			};
			await writeJsonAtomic(this.metaPath(id), metadata);
		}
		const { output, omittedBytes } = await this.snapshotOutput(id);
		if (isTerminal(metadata.status)) await this.markTerminalPresented(metadata);
		return { metadata, output, omittedBytes };
	}

	/** Persist suppression for a successful explicit result returned by the tool. */
	async markResultPresented(result: TaskResult): Promise<void> {
		if (isTerminal(result.metadata.status)) await this.markTerminalPresented(result.metadata);
		else if (result.ready) await this.markPresented(result.metadata, "ready");
	}

	async listTasks(sessionId?: string): Promise<TaskMetadata[]> {
		await mkdir(this.taskDir, { recursive: true });
		const entries = await readdir(this.taskDir, { withFileTypes: true });
		const tasks = await Promise.all(
			entries
				.filter((entry) => entry.isDirectory() && TASK_ID_PATTERN.test(entry.name))
				.map(async (entry) => {
					try {
						return await this.readMetadata(entry.name);
					} catch {
						return undefined;
					}
				}),
		);
		const selected = tasks.filter(
			(metadata): metadata is TaskMetadata => metadata !== undefined && (sessionId === undefined || metadata.sessionId === sessionId),
		);
		const refreshed = await Promise.all(selected.map((metadata) =>
			metadata.sessionId === this.#sessionId ? this.refreshOwned(metadata.id) : metadata
		));
		return refreshed.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
	}

	async getTaskMetadata(id: string): Promise<TaskMetadata> {
		return this.refreshOwned(id);
	}

	taskDirectoryPath(id: string): string {
		if (!TASK_ID_PATTERN.test(id)) throw new Error(`python: invalid taskId "${id}"`);
		return join(this.taskDir, id);
	}

	async cleanupExpired(): Promise<void> {
		await mkdir(this.taskDir, { recursive: true, mode: 0o700 });
		await chmod(this.taskDir, 0o700);
		const entries = await readdir(this.taskDir, { withFileTypes: true });
		await Promise.all(
			entries
				.filter((entry) => entry.isDirectory() && TASK_ID_PATTERN.test(entry.name))
				.map(async (entry) => {
					try {
						const metadata = await this.readMetadata(entry.name);
						if (
							metadata.status !== "running" &&
							metadata.status !== "starting" &&
							Date.now() - Date.parse(metadata.updatedAt) > TASK_RETENTION_MS
						) {
							await rm(join(this.taskDir, entry.name), { recursive: true, force: true });
						}
					} catch {
						// Leave malformed records untouched; they may be under active creation.
					}
				}),
		);
	}

	private directory(id: string): string {
		return this.taskDirectoryPath(id);
	}

	private metaPath(id: string): string {
		return join(this.directory(id), "meta.json");
	}

	private readyMarkerPath(metadata: TaskMetadata): string {
		return join(this.directory(metadata.id), `${metadata.instanceId}.ready.detected`);
	}

	private assertOwned(metadata: TaskMetadata): void {
		if (metadata.sessionId !== this.#sessionId) {
			throw new Error(`python: task "${metadata.id}" belongs to a different session`);
		}
	}

	private assertTaskId(id: string): void {
		if (!TASK_ID_PATTERN.test(id)) throw new Error(`python: invalid taskId "${id}"`);
		if (!existsSync(this.directory(id))) throw new Error(`python: persistent task "${id}" was not found`);
	}

	private async readMetadata(id: string): Promise<TaskMetadata> {
		this.assertTaskId(id);
		const directory = this.directory(id);
		try {
			return parseTaskMetadata(JSON.parse(await readFile(this.metaPath(id), "utf8")), id);
		} catch (error) {
			throw new Error(`python: could not read persistent task "${id}": ${error instanceof Error ? error.message : String(error)}\ndiagnosticsPath: ${directory}`);
		}
	}

	private async refreshOwned(id: string): Promise<TaskMetadata> {
		this.assertOwned(await this.readMetadata(id));
		const metadata = await this.refreshMetadata(id);
		this.assertOwned(metadata);
		return metadata;
	}

	private async refreshMetadata(id: string): Promise<TaskMetadata> {
		let metadata = await this.readMetadata(id);
		if (
			metadata.status === "starting" &&
			metadata.supervisorPid === 0 &&
			Date.now() - Date.parse(metadata.updatedAt) > 10_000
		) {
			const failed: TaskMetadata = {
				...metadata,
				status: "failed",
				exitCode: null,
				error: "Task supervisor did not finish starting",
				failureKind: "infrastructure",
				updatedAt: new Date().toISOString(),
			};
			const current = await this.readMetadata(id);
			if (current.instanceId === metadata.instanceId && current.status === "starting" && current.supervisorPid === 0) {
				await writeJsonAtomic(this.metaPath(id), failed);
				metadata = failed;
			} else {
				metadata = current;
			}
		}
		if (!isTerminal(metadata.status) && metadata.supervisorPid > 0 && !isAlive(metadata.supervisorPid)) {
			await new Promise((resolve) => setTimeout(resolve, 50));
			metadata = await this.readMetadata(id);
			if (!isTerminal(metadata.status) && metadata.supervisorPid > 0 && !isAlive(metadata.supervisorPid)) {
				const failed: TaskMetadata = {
					...metadata,
					status: "failed",
					exitCode: null,
					error: "Task supervisor exited without recording a final status",
					failureKind: "infrastructure",
					updatedAt: new Date().toISOString(),
				};
				const current = await this.readMetadata(id);
				if (current.instanceId === metadata.instanceId && !isTerminal(current.status)) {
					await writeJsonAtomic(this.metaPath(id), failed);
					metadata = failed;
				} else {
					metadata = current;
				}
			}
		}
		return metadata;
	}

	private async markPresented(metadata: TaskMetadata, kind: "ready" | "exit"): Promise<void> {
		if (!metadata.instanceId) return;
		const current = await this.readMetadata(metadata.id);
		if (current.instanceId !== metadata.instanceId) return;
		if (kind === "exit" && !isTerminal(current.status)) return;
		if (kind === "ready" && !existsSync(this.readyMarkerPath(current))) return;
		const path = join(this.directory(metadata.id), `${metadata.instanceId}.${kind}.presented`);
		try {
			const handle = await open(path, "wx");
			await handle.close();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}

	private async markTerminalPresented(metadata: TaskMetadata): Promise<void> {
		await this.markPresented(metadata, "exit");
		if (existsSync(this.readyMarkerPath(metadata))) await this.markPresented(metadata, "ready");
	}

	private async snapshotOutput(id: string): Promise<{ output: string; omittedBytes: number }> {
		const directory = this.directory(id);
		const logPath = join(directory, "output.log");
		const logStat = await stat(logPath);
		const omittedBytes = Math.max(0, logStat.size - MAX_OUTPUT_BYTES);
		const start = omittedBytes;
		const length = logStat.size - start;
		let output = "";
		if (length > 0) {
			const handle = await open(logPath, "r");
			try {
				const buffer = Buffer.alloc(length);
				let bytesRead = 0;
				while (bytesRead < length) {
					const read = await handle.read(buffer, bytesRead, length - bytesRead, start + bytesRead);
					if (read.bytesRead === 0) break;
					bytesRead += read.bytesRead;
				}
				output = buffer.subarray(0, bytesRead).toString("utf8");
			} finally {
				await handle.close();
			}
		}
		return { output, omittedBytes };
	}
}
