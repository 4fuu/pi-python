import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import type { TaskCoordinator, TaskNotificationKind, TaskWithdrawalReason } from "@4fu/pi-task-coordinator";
import { PythonRuntime, type TaskMetadata } from "./runtime.ts";

const DEFAULT_POLL_INTERVAL_MS = 400;
const MAX_TAIL_BYTES = 32 * 1024;
const MAX_OUTPUT_CHARS = 4_000;
const MAX_OUTPUT_LINES = 20;
const CLAIM_LEASE_MS = 30_000;

type MarkerKind = "ready" | "exit";
type NotificationTask = TaskMetadata & { instanceId: string; sessionId: string };
type ClaimState = "claimed" | "busy" | "settled" | "retry";

export interface TaskNotificationOptions {
	pollIntervalMs?: number;
}

function cleanOutput(text: string): string {
	return text
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1bP[\s\S]*?\x1b\\/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b[@-_]/g, "")
		.replace(/\r\n?/g, "\n")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function tailOutput(text: string): string {
	return cleanOutput(text).trimEnd().split("\n").slice(-MAX_OUTPUT_LINES).join("\n").slice(-MAX_OUTPUT_CHARS);
}

function isNotificationTask(metadata: TaskMetadata, sessionId: string): metadata is NotificationTask {
	return metadata.version === 2 && typeof metadata.instanceId === "string" &&
		/^[0-9a-f]{32}$/i.test(metadata.instanceId) && metadata.sessionId === sessionId;
}

/** Observes persistent tasks; the shared coordinator owns presentation only. */
export class TaskNotificationManager {
	private readonly coordinator: TaskCoordinator;
	private readonly runtime: PythonRuntime;
	private readonly sessionId: string;
	private readonly offered = new Set<string>();
	private readonly pollIntervalMs: number;
	private pollTimer: NodeJS.Timeout | undefined;
	private scanPromise: Promise<void> | undefined;
	private closed = true;

	constructor(
		coordinator: TaskCoordinator,
		runtime: PythonRuntime,
		sessionId: string,
		options: TaskNotificationOptions = {},
	) {
		this.coordinator = coordinator;
		this.runtime = runtime;
		this.sessionId = sessionId;
		this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	}

	async start(): Promise<void> {
		if (!this.closed) return;
		this.closed = false;
		try {
			await this.scanNow();
		} catch (error) {
			this.closed = true;
			throw error;
		}
		if (this.pollIntervalMs > 0) {
			this.pollTimer = setInterval(() => void this.scanNow().catch(() => {}), this.pollIntervalMs);
			this.pollTimer.unref?.();
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		if (this.pollTimer) clearInterval(this.pollTimer);
		this.pollTimer = undefined;
		await this.scanPromise?.catch(() => {});
		this.offered.clear();
		this.coordinator.updateActiveTasks([]);
	}

	holdTask(taskId: string): () => void {
		return this.coordinator.holdTask(`python:${taskId}`);
	}

	holdSource(): () => void {
		return this.coordinator.holdSource();
	}

	/** Remove notification noise only after a successful explicit result. */
	withdrawPresented(result: { metadata: TaskMetadata; ready?: boolean }): void {
		const taskKey = `python:${result.metadata.id}`;
		if (result.metadata.status === "completed" || result.metadata.status === "failed" || result.metadata.status === "cancelled") {
			this.coordinator.withdrawTask(taskKey, ["ready", "terminal"], "presented");
		} else if (result.ready) {
			this.coordinator.withdrawTask(taskKey, ["ready"], "presented");
		}
	}

	async scanNow(): Promise<void> {
		if (this.closed) return;
		if (this.scanPromise) return this.scanPromise;
		const scan = this.performScan();
		this.scanPromise = scan;
		try {
			await scan;
		} finally {
			if (this.scanPromise === scan) this.scanPromise = undefined;
		}
	}

	private async performScan(): Promise<void> {
		const tasks = (await this.runtime.listTasks(this.sessionId)).filter((task) => isNotificationTask(task, this.sessionId));
		if (this.closed) return;
		for (const task of tasks) {
			if (this.closed) return;
			if (task.status === "starting" || task.status === "running") {
				await this.scanReady(task);
			} else {
				this.coordinator.withdrawTask(`python:${task.id}`, ["ready"], "superseded");
				if (existsSync(join(this.runtime.taskDirectoryPath(task.id), `${task.instanceId}.ready.detected`))) {
					await this.settleNotified(task, "ready");
				}
				await this.offer(task, "exit");
			}
		}
		if (this.closed) return;
		this.coordinator.updateActiveTasks(tasks
			.filter((task) => task.status === "starting" || task.status === "running")
			.map((task) => ({
				taskKey: `python:${task.id}`, source: "python", taskId: task.id,
				status: existsSync(join(this.runtime.taskDirectoryPath(task.id), `${task.instanceId}.ready.detected`)) ? "ready" : task.status,
				startedAt: Date.parse(task.createdAt), summary: (task.codeSummary ?? "(source unavailable)").slice(0, 500),
			})));
	}

	private async scanReady(task: NotificationTask): Promise<void> {
		if (!task.notifyOn || !existsSync(join(this.runtime.taskDirectoryPath(task.id), `${task.instanceId}.ready.detected`))) return;
		await this.offer(task, "ready");
	}

	private async offer(task: NotificationTask, kind: MarkerKind): Promise<void> {
		const event: TaskNotificationKind = kind === "exit" ? "terminal" : "ready";
		const eventId = `python:${task.instanceId}:${event}`;
		if (this.offered.has(eventId) || existsSync(this.presentedPath(task, kind))) return;
		if (await this.metadataState(task) !== "match") return;
		if (this.closed) return;
		const claimState = await this.claim(task, kind);
		if (claimState !== "claimed") return;
		if (this.closed) {
			await rm(this.path(task, kind, "notifying"), { force: true });
			return;
		}
		const output = await this.readTail(join(this.runtime.taskDirectoryPath(task.id), "output.log"));
		if (this.closed) {
			await rm(this.path(task, kind, "notifying"), { force: true });
			return;
		}
		this.offered.add(eventId);
		this.coordinator.offer({
			eventId,
			taskKey: `python:${task.id}`,
			source: "python",
			taskId: task.id,
			event,
			status: kind === "ready" ? "ready" : task.status,
			durationMs: Math.max(0, Date.now() - Date.parse(task.createdAt)),
			summary: (task.codeSummary ?? "(source unavailable)").slice(0, 500),
			output: tailOutput(output),
			ok: kind === "ready" || task.status === "completed",
		}, {
			onSubmitted: async () => this.moveToSubmitted(task, kind),
			onDelivered: async () => this.settleNotified(task, kind),
			onWithdrawn: async (reason) => this.withdraw(task, kind, eventId, reason),
		});
	}

	private path(task: NotificationTask, kind: MarkerKind, state: "notifying" | "submitted" | "notified"): string {
		return join(this.runtime.taskDirectoryPath(task.id), `${task.instanceId}.${kind}.${state}`);
	}

	private presentedPath(task: NotificationTask, kind: MarkerKind): string {
		return join(this.runtime.taskDirectoryPath(task.id), `${task.instanceId}.${kind}.presented`);
	}

	private async moveToSubmitted(task: NotificationTask, kind: MarkerKind): Promise<void> {
		const submitted = this.path(task, kind, "submitted");
		if (existsSync(this.path(task, kind, "notified"))) return;
		if (existsSync(submitted)) {
			try {
				const now = new Date();
				await utimes(submitted, now, now);
				return;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		try {
			await rename(this.path(task, kind, "notifying"), submitted);
			const now = new Date();
			await utimes(submitted, now, now);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	private async settleNotified(task: NotificationTask, kind: MarkerKind): Promise<void> {
		const notified = this.path(task, kind, "notified");
		const handle = await open(notified, "a", 0o600);
		await handle.close();
		await this.release(task, kind);
	}

	private async release(task: NotificationTask, kind: MarkerKind): Promise<void> {
		await Promise.all([
			rm(this.path(task, kind, "submitted"), { force: true }),
			rm(this.path(task, kind, "notifying"), { force: true }),
		]);
	}

	private async withdraw(
		task: NotificationTask,
		kind: MarkerKind,
		eventId: string,
		reason: TaskWithdrawalReason,
	): Promise<void> {
		if (reason === "superseded") {
			await this.settleNotified(task, kind);
			return;
		}
		if (reason === "retry-exhausted") {
			this.offered.delete(eventId);
			const claim = this.path(task, kind, "notifying");
			const submitted = this.path(task, kind, "submitted");
			if (existsSync(submitted)) {
				try {
					await rename(submitted, claim);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
					await rm(submitted, { force: true });
				}
			}
			if (!existsSync(claim)) {
				const handle = await open(claim, "a", 0o600);
				await handle.close();
			}
			const now = new Date();
			await utimes(claim, now, now);
			return;
		}
		await this.release(task, kind);
	}

	private async claim(task: NotificationTask, kind: MarkerKind): Promise<ClaimState> {
		if (existsSync(this.path(task, kind, "notified"))) return "settled";
		const submitted = this.path(task, kind, "submitted");
		if (existsSync(submitted)) {
			try {
				if (Date.now() - (await stat(submitted)).mtimeMs <= CLAIM_LEASE_MS) return "busy";
				const stale = `${submitted}.${randomUUID()}.stale`;
				await rename(submitted, stale);
				await rm(stale, { force: true });
				return this.claim(task, kind);
			} catch {
				return existsSync(this.path(task, kind, "notified")) ? "settled" : "busy";
			}
		}
		const claim = this.path(task, kind, "notifying");
		try {
			const handle = await open(claim, "wx", 0o600);
			await handle.close();
			return "claimed";
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return "retry";
		}
		try {
			if (Date.now() - (await stat(claim)).mtimeMs <= CLAIM_LEASE_MS) return "busy";
			const stale = `${claim}.${randomUUID()}.stale`;
			await rename(claim, stale);
			await rm(stale, { force: true });
			return this.claim(task, kind);
		} catch {
			return "busy";
		}
	}

	private async metadataState(task: NotificationTask): Promise<"match" | "stale"> {
		try {
			const value = JSON.parse((await readFile(join(this.runtime.taskDirectoryPath(task.id), "meta.json"), "utf8")).replace(/^\uFEFF/, ""));
			return value.instanceId === task.instanceId && value.sessionId === this.sessionId ? "match" : "stale";
		} catch { return "stale"; }
	}

	private async readTail(path: string): Promise<string> {
		try {
			const size = (await stat(path)).size;
			const start = Math.max(0, size - MAX_TAIL_BYTES);
			const handle = await open(path, "r");
			try {
				const buffer = Buffer.alloc(size - start);
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
				return buffer.subarray(0, bytesRead).toString("utf8");
			} finally { await handle.close(); }
		} catch { return ""; }
	}
}
