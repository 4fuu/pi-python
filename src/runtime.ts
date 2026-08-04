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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LAUNCHER_PATH = join(SOURCE_DIR, "launcher.mjs");
const DEFAULT_JOB_DIR = join(tmpdir(), "pi-python-jobs");
const JOB_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_TIMEOUT_MS = 2_147_483_647;
const JOB_ID_PATTERN = /^py-[0-9a-f]{8}$/;

export type JobStatus = "starting" | "running" | "completed" | "failed" | "stopped";

export interface JobMetadata {
	version: 1;
	id: string;
	supervisorPid: number;
	pid?: number;
	cwd: string;
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
}

interface ForegroundOptions {
	code: string;
	cwd: string;
	timeout?: number;
	signal?: AbortSignal;
	onData: (data: Buffer) => void;
}

function runtimeEnvironment(): NodeJS.ProcessEnv {
	return {
		...process.env,
		PYTHONIOENCODING: process.env.PYTHONIOENCODING ?? "utf-8",
		PYTHONUTF8: process.env.PYTHONUTF8 ?? "1",
		PYTHONUNBUFFERED: process.env.PYTHONUNBUFFERED ?? "1",
	};
}

function waitForExit(child: ChildProcess): Promise<number | null> {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
}

async function probe(executable: string, prefixArgs: string[]): Promise<Interpreter | undefined> {
	return new Promise((resolve) => {
		let output = "";
		let settled = false;
		const child = spawn(executable, [...prefixArgs, "--version"], {
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
		child.stdout?.on("data", (data: Buffer) => (output += data.toString("utf8")));
		child.stderr?.on("data", (data: Buffer) => (output += data.toString("utf8")));
		child.once("error", () => finish(undefined));
		child.once("close", (code) => {
			const version = output.trim();
			finish(code === 0 && /^Python 3(?:\.|\s|$)/.test(version) ? { executable, prefixArgs, version } : undefined);
		});
	});
}

async function findInterpreter(): Promise<Interpreter> {
	const candidates =
		process.platform === "win32"
			? [
					{ executable: "python", prefixArgs: [] },
					{ executable: "py", prefixArgs: ["-3"] },
				]
			: [
					{ executable: "python3", prefixArgs: [] },
					{ executable: "python", prefixArgs: [] },
				];
	for (const candidate of candidates) {
		const found = await probe(candidate.executable, candidate.prefixArgs);
		if (found) return found;
	}
	throw new Error("python: Python 3 was not found (tried python3/python, or python/py -3 on Windows)");
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

export class PythonRuntime {
	readonly jobDir: string;
	readonly launcherPath: string;
	readonly configuredInterpreter?: { executable: string; prefixArgs: string[] };
	#interpreter?: Promise<Interpreter>;

	constructor(options: RuntimeOptions = {}) {
		this.jobDir = options.jobDir ?? DEFAULT_JOB_DIR;
		this.launcherPath = options.launcherPath ?? DEFAULT_LAUNCHER_PATH;
		this.configuredInterpreter = options.interpreter
			? { executable: options.interpreter.executable, prefixArgs: options.interpreter.prefixArgs ?? [] }
			: undefined;
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
			const child = spawn(interpreter.executable, [...interpreter.prefixArgs, "-u", codePath], {
				cwd: options.cwd,
				env: runtimeEnvironment(),
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

	async startBackground(code: string, cwd: string, signal?: AbortSignal): Promise<JobMetadata> {
		signal?.throwIfAborted();
		await this.cleanupExpired();
		const interpreter = await this.interpreter();
		signal?.throwIfAborted();
		const id = `py-${randomUUID().slice(0, 8)}`;
		const directory = join(this.jobDir, id);
		const codePath = join(directory, "main.py");
		const logPath = join(directory, "output.log");
		const metaPath = join(directory, "meta.json");
		const configPath = join(directory, "config.json");
		await mkdir(directory, { recursive: true });
		const now = new Date().toISOString();
		const initial: JobMetadata = {
			version: 1,
			id,
			supervisorPid: 0,
			cwd,
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
				executable: interpreter.executable,
				prefixArgs: interpreter.prefixArgs,
				cwd,
				codePath,
				logPath,
				metaPath,
			});
			signal?.throwIfAborted();
			const supervisor = spawn(process.execPath, [this.launcherPath, configPath], {
				cwd,
				env: runtimeEnvironment(),
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
			supervisor.unref();
			return await this.readMetadata(id);
		} catch (error) {
			let metadata: JobMetadata | undefined;
			try {
				metadata = JSON.parse(await readFile(metaPath, "utf8")) as JobMetadata;
			} catch {
				// Startup may have failed before metadata was fully created.
			}
			await killProcessTree(metadata?.supervisorPid || supervisorPid);
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
		while (unread === 0 && metadata.status === "running" && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
			signal?.throwIfAborted();
			metadata = await this.refreshMetadata(id);
			unread = await this.unreadBytes(id);
		}
		const { output, omittedBytes } = await this.consumeOutput(id);
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
				metadata = {
					...metadata,
					status: "stopped",
					exitCode: null,
					updatedAt: new Date().toISOString(),
				};
				await writeJsonAtomic(this.metaPath(id), metadata);
			}
		}
		const { output, omittedBytes } = await this.consumeOutput(id);
		return { metadata, output, omittedBytes };
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
		return join(this.jobDir, id);
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
			const value = JSON.parse(await readFile(this.metaPath(id), "utf8")) as JobMetadata;
			if (value.version !== 1 || value.id !== id) throw new Error("invalid metadata");
			return value;
		} catch (error) {
			throw new Error(`python: could not read background job "${id}": ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async refreshMetadata(id: string): Promise<JobMetadata> {
		let metadata = await this.readMetadata(id);
		if ((metadata.status === "running" || metadata.status === "starting") && !isAlive(metadata.supervisorPid)) {
			await new Promise((resolve) => setTimeout(resolve, 50));
			metadata = await this.readMetadata(id);
			if ((metadata.status === "running" || metadata.status === "starting") && !isAlive(metadata.supervisorPid)) {
				metadata = {
					...metadata,
					status: "failed",
					exitCode: null,
					error: "Background supervisor exited without recording a final status",
					updatedAt: new Date().toISOString(),
				};
				await writeJsonAtomic(this.metaPath(id), metadata);
			}
		}
		return metadata;
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
