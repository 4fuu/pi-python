import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
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
const DEFAULT_JOB_DIR = join(tmpdir(), "pi-python-jobs");
const JOB_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_TIMEOUT_MS = 2_147_483_647;
const EXIT_STDIO_GRACE_MS = 100;
const MAX_NOTIFY_PATTERN_BYTES = 256;
const JOB_ID_PATTERN = /^py-[0-9a-f]{8}$/;
const JOB_STATUSES = new Set<JobStatus>(["starting", "running", "completed", "failed", "stopped"]);

export type JobStatus = "starting" | "running" | "completed" | "failed" | "stopped";

export interface JobMetadata {
	version: 1 | 2;
	id: string;
	instanceId?: string;
	sessionId?: string;
	supervisorPid: number;
	pid?: number;
	cwd: string;
	codeSummary?: string;
	notifyOn?: string;
	createdAt: string;
	updatedAt: string;
	status: JobStatus;
	exitCode?: number | null;
	error?: string;
}

export interface JobResult {
	metadata: JobMetadata;
	output: string;
	omittedBytes: number;
}

interface Interpreter {
	executable: string;
	prefixArgs: string[];
	version: string;
}

interface RuntimeOptions {
	jobDir?: string;
	launcherPath?: string;
	interpreter?: { executable: string; prefixArgs?: string[] };
	utf8?: boolean;
	unbuffered?: boolean;
	sessionId?: string;
}

interface ForegroundOptions {
	code: string;
	cwd: string;
	timeout?: number;
	signal?: AbortSignal;
	onData: (data: Buffer) => void;
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

/** Wait for process exit without hanging on pipe handles inherited by descendants. */
function waitForExit(child: ChildProcess): Promise<number | null> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let postExitTimer: NodeJS.Timeout | undefined;
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;

		const cleanup = () => {
			if (postExitTimer) clearTimeout(postExitTimer);
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
			child.stdout?.removeListener("data", onData);
			child.stderr?.removeListener("data", onData);
		};
		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve(code);
		};
		const maybeFinish = () => {
			if (exited && stdoutEnded && stderrEnded) finish(exitCode);
		};
		const armIdleTimer = () => {
			if (postExitTimer) clearTimeout(postExitTimer);
			postExitTimer = setTimeout(() => finish(exitCode), EXIT_STDIO_GRACE_MS);
		};
		const onData = () => {
			if (exited && !settled) armIdleTimer();
		};
		const onStdoutEnd = () => {
			stdoutEnded = true;
			maybeFinish();
		};
		const onStderrEnd = () => {
			stderrEnded = true;
			maybeFinish();
		};
		const onError = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onExit = (code: number | null) => {
			exited = true;
			exitCode = code;
			maybeFinish();
			if (!settled) armIdleTimer();
		};
		const onClose = (code: number | null) => finish(code);

		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);
	});
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
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await rename(temporary, path);
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

function isTerminal(status: JobStatus): boolean {
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

function parseJobMetadata(value: unknown, id: string): JobMetadata {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid metadata");
	const input = value as Record<string, unknown>;
	if ((input.version !== 1 && input.version !== 2) || input.id !== id) throw new Error("invalid metadata identity");
	if (!Number.isInteger(input.supervisorPid) || (input.supervisorPid as number) < 0) throw new Error("invalid supervisor PID");
	if (input.pid !== undefined && (!Number.isInteger(input.pid) || (input.pid as number) <= 0)) throw new Error("invalid process PID");
	if (typeof input.cwd !== "string") throw new Error("invalid working directory");
	if (typeof input.createdAt !== "string" || !Number.isFinite(Date.parse(input.createdAt))) throw new Error("invalid creation time");
	if (typeof input.updatedAt !== "string" || !Number.isFinite(Date.parse(input.updatedAt))) throw new Error("invalid update time");
	if (typeof input.status !== "string" || !JOB_STATUSES.has(input.status as JobStatus)) throw new Error("invalid status");
	if (input.exitCode !== undefined && input.exitCode !== null && !Number.isInteger(input.exitCode)) throw new Error("invalid exit code");
	if (input.error !== undefined && typeof input.error !== "string") throw new Error("invalid error");
	if (input.version === 2) {
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
	return input as unknown as JobMetadata;
}

export class PythonRuntime {
	readonly jobDir: string;
	readonly launcherPath: string;
	readonly configuredInterpreter?: { executable: string; prefixArgs: string[] };
	readonly utf8: boolean;
	readonly unbuffered: boolean;
	#sessionId: string;
	#interpreter?: Promise<Interpreter>;

	constructor(options: RuntimeOptions = {}) {
		this.jobDir = options.jobDir ?? DEFAULT_JOB_DIR;
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

	async runForeground(options: ForegroundOptions): Promise<number | null> {
		options.signal?.throwIfAborted();
		const interpreter = await this.interpreter();
		options.signal?.throwIfAborted();
		const directory = await mkdtemp(join(tmpdir(), "pi-python-run-"));
		try {
			const codePath = join(directory, "main.py");
			await writeFile(codePath, options.code, "utf8");
			options.signal?.throwIfAborted();
			const pythonArgs = [...interpreter.prefixArgs, ...(this.unbuffered ? ["-u"] : []), codePath];
			const child = spawn(interpreter.executable, pythonArgs, {
				cwd: options.cwd,
				env: runtimeEnvironment(this),
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
				detached: process.platform !== "win32",
			});
			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			let killPromise: Promise<void> | undefined;
			const stop = () => {
				killPromise ??= killProcessTree(child.pid ?? 0);
			};
			child.stdout?.on("data", options.onData);
			child.stderr?.on("data", options.onData);
			options.signal?.addEventListener("abort", stop, { once: true });
			if (options.signal?.aborted) stop();
			if (options.timeout !== undefined) {
				const timeoutMs = Math.min(options.timeout * 1000, MAX_TIMEOUT_MS);
				timeoutHandle = setTimeout(() => {
					timedOut = true;
					stop();
				}, timeoutMs);
			}

			try {
				const exitCode = await waitForExit(child);
				if (killPromise) await killPromise;
				options.signal?.throwIfAborted();
				if (timedOut) throw new Error(`python: timed out after ${options.timeout} seconds`);
				return exitCode;
			} finally {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				options.signal?.removeEventListener("abort", stop);
				if (timedOut || options.signal?.aborted) {
					stop();
					await killPromise;
				}
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}

	async startBackground(code: string, cwd: string, signal?: AbortSignal, notifyOn?: string): Promise<JobMetadata> {
		signal?.throwIfAborted();
		if (notifyOn !== undefined && (notifyOn.length === 0 || Buffer.byteLength(notifyOn, "utf8") > MAX_NOTIFY_PATTERN_BYTES)) {
			throw new Error("python: notifyOn must contain 1 to 256 UTF-8 bytes");
		}
		await this.cleanupExpired();
		const interpreter = await this.interpreter();
		signal?.throwIfAborted();
		await mkdir(this.jobDir, { recursive: true });
		let id = "";
		let directory = "";
		for (let attempt = 0; attempt < 5; attempt++) {
			id = `py-${randomUUID().slice(0, 8)}`;
			directory = join(this.jobDir, id);
			try {
				await mkdir(directory);
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
		const now = new Date().toISOString();
		const initial: JobMetadata = {
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
				writeFile(codePath, code, "utf8"),
				writeFile(logPath, "", "utf8"),
				writeFile(join(directory, "cursor"), "0", "utf8"),
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
			});
			signal?.throwIfAborted();
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
					signal?.removeEventListener("abort", onAbort);
					supervisor.removeListener("error", onError);
					supervisor.removeListener("exit", onExit);
					supervisor.removeListener("message", onMessage);
					if (error) reject(error);
					else resolve();
				};
				const onAbort = () => finish(new Error("python: cancelled while starting background job"));
				const onError = (error: Error) => finish(error);
				const onExit = (code: number | null) => finish(new Error(`python: background launcher exited during startup (${code})`));
				const onMessage = (message: unknown) => {
					if (typeof message !== "object" || message === null) return;
					const value = message as { type?: unknown; error?: unknown };
					if (value.type === "ready") finish();
					if (value.type === "error") finish(new Error(`python: ${String(value.error)}`));
				};
				const timer = setTimeout(() => finish(new Error("python: background launcher did not start within 5 seconds")), 5000);
				signal?.addEventListener("abort", onAbort, { once: true });
				supervisor.once("error", onError);
				supervisor.once("exit", onExit);
				supervisor.on("message", onMessage);
				if (signal?.aborted) onAbort();
			});
			const metadata = await this.readMetadata(id);
			signal?.throwIfAborted();
			supervisor.unref();
			return metadata;
		} catch (error) {
			let metadata: JobMetadata | undefined;
			try {
				metadata = JSON.parse(await readFile(metaPath, "utf8")) as JobMetadata;
			} catch {
				// Startup may have failed before metadata was fully created.
			}
			const ownedMetadata = metadata?.id === id && metadata.instanceId === instanceId ? metadata : undefined;
			await killProcessTree(supervisorPid || ownedMetadata?.supervisorPid || 0);
			if (process.platform === "win32" && ownedMetadata?.pid && isAlive(ownedMetadata.pid)) {
				await killProcessTree(ownedMetadata.pid);
			}
			await rm(directory, { recursive: true, force: true });
			throw error;
		}
	}

	async readJob(id: string, waitSeconds = 0, signal?: AbortSignal): Promise<JobResult> {
		this.assertJobId(id);
		signal?.throwIfAborted();
		const deadline = Date.now() + waitSeconds * 1000;
		let metadata = await this.refreshMetadata(id);
		let unread = await this.unreadBytes(id);
		while (unread === 0 && !isTerminal(metadata.status) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
			signal?.throwIfAborted();
			metadata = await this.refreshMetadata(id);
			unread = await this.unreadBytes(id);
		}
		const terminalBeforeRead = isTerminal(metadata.status);
		const { output, omittedBytes } = await this.consumeOutput(id);
		if (terminalBeforeRead) await this.markFinalOutputPresented(metadata);
		return { metadata, output, omittedBytes };
	}

	async stopJob(id: string): Promise<JobResult> {
		this.assertJobId(id);
		let metadata = await this.refreshMetadata(id);
		if (metadata.status === "running" || metadata.status === "starting") {
			await killProcessTree(metadata.supervisorPid);
			if (process.platform === "win32" && metadata.pid && isAlive(metadata.pid)) {
				await killProcessTree(metadata.pid);
			}
			metadata = await this.readMetadata(id);
			if (metadata.status === "running" || metadata.status === "starting") {
				const stopped: JobMetadata = {
					...metadata,
					status: "stopped",
					exitCode: null,
					updatedAt: new Date().toISOString(),
				};
				const current = await this.readMetadata(id);
				if (current.instanceId === metadata.instanceId && !isTerminal(current.status)) {
					await writeJsonAtomic(this.metaPath(id), stopped);
					metadata = stopped;
				} else {
					metadata = current;
				}
			}
		}
		const { output, omittedBytes } = await this.consumeOutput(id);
		if (isTerminal(metadata.status)) await this.markFinalOutputPresented(metadata);
		return { metadata, output, omittedBytes };
	}

	async listJobs(sessionId?: string): Promise<JobMetadata[]> {
		await mkdir(this.jobDir, { recursive: true });
		const entries = await readdir(this.jobDir, { withFileTypes: true });
		const jobs = await Promise.all(
			entries
				.filter((entry) => entry.isDirectory() && JOB_ID_PATTERN.test(entry.name))
				.map(async (entry) => {
					try {
						return await this.refreshMetadata(entry.name);
					} catch {
						return undefined;
					}
				}),
		);
		return jobs.filter(
			(metadata): metadata is JobMetadata => metadata !== undefined && (sessionId === undefined || metadata.sessionId === sessionId),
		);
	}

	async getJobMetadata(id: string): Promise<JobMetadata> {
		return this.refreshMetadata(id);
	}

	jobDirectoryPath(id: string): string {
		if (!JOB_ID_PATTERN.test(id)) throw new Error(`python: invalid jobId "${id}"`);
		return join(this.jobDir, id);
	}

	async cleanupExpired(): Promise<void> {
		await mkdir(this.jobDir, { recursive: true });
		const entries = await readdir(this.jobDir, { withFileTypes: true });
		await Promise.all(
			entries
				.filter((entry) => entry.isDirectory() && JOB_ID_PATTERN.test(entry.name))
				.map(async (entry) => {
					try {
						const metadata = await this.readMetadata(entry.name);
						if (
							metadata.status !== "running" &&
							metadata.status !== "starting" &&
							Date.now() - Date.parse(metadata.updatedAt) > JOB_RETENTION_MS
						) {
							await rm(join(this.jobDir, entry.name), { recursive: true, force: true });
						}
					} catch {
						// Leave malformed records untouched; they may be under active creation.
					}
				}),
		);
	}

	private directory(id: string): string {
		return this.jobDirectoryPath(id);
	}

	private metaPath(id: string): string {
		return join(this.directory(id), "meta.json");
	}

	private assertJobId(id: string): void {
		if (!JOB_ID_PATTERN.test(id)) throw new Error(`python: invalid jobId "${id}"`);
		if (!existsSync(this.directory(id))) throw new Error(`python: background job "${id}" was not found`);
	}

	private async readMetadata(id: string): Promise<JobMetadata> {
		this.assertJobId(id);
		try {
			return parseJobMetadata(JSON.parse(await readFile(this.metaPath(id), "utf8")), id);
		} catch (error) {
			throw new Error(`python: could not read background job "${id}": ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async refreshMetadata(id: string): Promise<JobMetadata> {
		let metadata = await this.readMetadata(id);
		if (
			metadata.status === "starting" &&
			metadata.supervisorPid === 0 &&
			Date.now() - Date.parse(metadata.updatedAt) > 10_000
		) {
			const failed: JobMetadata = {
				...metadata,
				status: "failed",
				exitCode: null,
				error: "Background supervisor did not finish starting",
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
				const failed: JobMetadata = {
					...metadata,
					status: "failed",
					exitCode: null,
					error: "Background supervisor exited without recording a final status",
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

	private async markFinalOutputPresented(metadata: JobMetadata): Promise<void> {
		if (!metadata.instanceId) return;
		const current = await this.readMetadata(metadata.id);
		if (current.instanceId !== metadata.instanceId || !isTerminal(current.status)) return;
		const path = join(this.directory(metadata.id), `${metadata.instanceId}.exit.presented`);
		try {
			const handle = await open(path, "wx");
			await handle.close();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}

	private async unreadBytes(id: string): Promise<number> {
		const directory = this.directory(id);
		const [cursorText, logStat] = await Promise.all([
			readFile(join(directory, "cursor"), "utf8"),
			stat(join(directory, "output.log")),
		]);
		const cursor = Number.parseInt(cursorText, 10) || 0;
		return Math.max(0, logStat.size - cursor);
	}

	private async consumeOutput(id: string): Promise<{ output: string; omittedBytes: number }> {
		const directory = this.directory(id);
		const cursorPath = join(directory, "cursor");
		const logPath = join(directory, "output.log");
		const [cursorText, logStat] = await Promise.all([readFile(cursorPath, "utf8"), stat(logPath)]);
		const cursor = Math.min(Number.parseInt(cursorText, 10) || 0, logStat.size);
		const unread = logStat.size - cursor;
		const omittedBytes = Math.max(0, unread - MAX_OUTPUT_BYTES);
		const start = cursor + omittedBytes;
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
		const cursorTemporary = `${cursorPath}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(cursorTemporary, String(logStat.size), "utf8");
		await rename(cursorTemporary, cursorPath);
		return { output, omittedBytes };
	}
}
