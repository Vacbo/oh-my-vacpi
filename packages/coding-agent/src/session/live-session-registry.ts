import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSessionEvent } from "./agent-session";
import { LiveEventStream } from "./live-event-stream";

const HEARTBEAT_INTERVAL_MS = 2_000;
const STALE_AFTER_MS = 10_000;
const MAX_STRING_LENGTH = 1_000;

export type LiveSessionStatus = "running" | "stopped" | "stale";

export interface LiveSessionMetadata {
	runId: string;
	pid: number;
	cwd: string;
	agentId: string;
	sessionId: string;
	sessionFile: string | null;
	startedAt: string;
	updatedAt: string;
	status: LiveSessionStatus;
	mode: "interactive" | "text" | "rpc" | "rpc-ui" | "acp" | "unknown";
	model?: string;
	eventStreamPath: string;
	terminalSnapshotPath: string;
	/** cmux surface hosting this session's terminal, recorded at registration. */
	cmuxSurfaceId?: string;
}

export interface LiveSessionSummary extends LiveSessionMetadata {
	source: "registry" | "process";
	isRunning: boolean;
	isStale: boolean;
	heartbeatAt: string | null;
	runDir: string;
	command?: string;
}

export interface DetectedOmpProcess {
	pid: number;
	command: string;
}

export interface RegisterLiveSessionOptions {
	agentDir: string;
	cwd: string;
	agentId: string;
	sessionId: string;
	sessionFile?: string | null;
	mode: LiveSessionMetadata["mode"];
	model?: string;
	cmuxSurfaceId?: string;
	now?: () => Date;
}

export interface LiveSessionRegistration {
	runId: string;
	runDir: string;
	metadataPath: string;
	heartbeatPath: string;
	eventStreamPath: string;
	terminalSnapshotPath: string;
	recordEvent(event: AgentSessionEvent): void;
	refresh(extra?: Partial<Pick<LiveSessionMetadata, "model" | "sessionFile" | "sessionId" | "status">>): void;
	dispose(status?: Exclude<LiveSessionStatus, "stale">): Promise<void>;
}

interface HeartbeatFile {
	pid: number;
	updatedAt: string;
}

export function getLiveRunsDir(agentDir: string): string {
	return path.join(agentDir, "runs");
}

export async function registerLiveSession(options: RegisterLiveSessionOptions): Promise<LiveSessionRegistration> {
	const now = options.now ?? (() => new Date());
	const startedAt = now().toISOString();
	const runId = createRunId(options.agentId, process.pid, startedAt);
	const runDir = path.join(getLiveRunsDir(options.agentDir), runId);
	await fs.mkdir(runDir, { recursive: true });

	const metadataPath = path.join(runDir, "metadata.json");
	const heartbeatPath = path.join(runDir, "heartbeat.json");
	const eventStreamPath = path.join(runDir, "events.jsonl");
	const terminalSnapshotPath = path.join(runDir, "terminal-snapshot.json");
	const eventStream = new LiveEventStream({ path: eventStreamPath, now });
	let metadata: LiveSessionMetadata = {
		runId,
		pid: process.pid,
		cwd: boundString(options.cwd) ?? "",
		agentId: boundString(options.agentId) ?? "",
		sessionId: boundString(options.sessionId) ?? "",
		sessionFile: options.sessionFile ? (boundString(options.sessionFile) ?? "") : null,
		startedAt,
		updatedAt: startedAt,
		status: "running",
		mode: options.mode,
		model: boundString(options.model),
		cmuxSurfaceId: boundString(options.cmuxSurfaceId),
		eventStreamPath,
		terminalSnapshotPath,
	};

	await writeJson(metadataPath, metadata);
	await writeHeartbeat(heartbeatPath, now);
	const interval = setInterval(() => {
		void writeHeartbeat(heartbeatPath, now).catch(error => {
			logger.warn("Failed to refresh live session heartbeat", { error: String(error), path: heartbeatPath });
		});
	}, HEARTBEAT_INTERVAL_MS);
	interval.unref?.();

	let disposed = false;
	// All metadata/heartbeat writes go through one FIFO chain. `refresh()` is
	// fire-and-forget, so an unchained write could still be in flight when
	// dispose() writes `stopped` and land afterwards — resurrecting a `running`
	// entry for a session that already exited (a stale row `listLiveSessions`
	// reports as live until the heartbeat ages out). A rejected link is swallowed
	// so one failed write cannot poison the final `stopped` write.
	let pendingWrite: Promise<void> = Promise.resolve();
	const queueWrite = (snapshot: LiveSessionMetadata): Promise<void> => {
		pendingWrite = pendingWrite
			.catch(() => {})
			.then(async () => {
				await writeJson(metadataPath, snapshot);
				await writeHeartbeat(heartbeatPath, now);
			});
		return pendingWrite;
	};
	const refresh = (
		extra: Partial<Pick<LiveSessionMetadata, "model" | "sessionFile" | "sessionId" | "status">> = {},
	) => {
		if (disposed) return;
		metadata = {
			...metadata,
			...sanitizeMetadataPatch(extra),
			updatedAt: now().toISOString(),
		};
		void queueWrite(metadata).catch(error => {
			logger.warn("Failed to update live session metadata", { error: String(error), path: metadataPath });
		});
	};

	return {
		runId,
		runDir,
		metadataPath,
		heartbeatPath,
		eventStreamPath,
		terminalSnapshotPath,
		recordEvent(event) {
			if (disposed) return;
			eventStream.append(event);
		},
		refresh,
		async dispose(status: Exclude<LiveSessionStatus, "stale"> = "stopped") {
			if (disposed) return;
			disposed = true;
			clearInterval(interval);
			await eventStream.flush();
			// Drain queued refresh writes first so `stopped` is the LAST state on disk.
			await pendingWrite.catch(() => {});
			metadata = { ...metadata, status, updatedAt: now().toISOString() };
			await writeJson(metadataPath, metadata);
			await writeHeartbeat(heartbeatPath, now);
		},
	};
}

export async function listLiveSessions(options: {
	agentDir: string;
	runningOnly?: boolean;
	includeProcessFallback?: boolean;
	now?: () => Date;
}): Promise<LiveSessionSummary[]> {
	const now = options.now ?? (() => new Date());
	const runsDir = getLiveRunsDir(options.agentDir);
	let entries: string[];
	try {
		entries = await fs.readdir(runsDir);
	} catch (error) {
		if (!isEnoentError(error)) throw error;
		entries = [];
	}

	const summaries: LiveSessionSummary[] = [];
	for (const entry of entries) {
		const runDir = path.join(runsDir, entry);
		const summary = await readLiveSessionSummary(runDir, now);
		if (!summary) continue;
		if (options.runningOnly && !summary.isRunning) continue;
		summaries.push(summary);
	}
	if (options.includeProcessFallback !== false) {
		const registeredPids = new Set(summaries.map(summary => summary.pid));
		const processSessions = await listOmpProcessSessions({ now, excludePids: registeredPids });
		for (const session of processSessions) {
			if (options.runningOnly && !session.isRunning) continue;
			summaries.push(session);
		}
	}
	return summaries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function inspectLiveSession(agentDir: string, runId: string): Promise<LiveSessionSummary | null> {
	return await readLiveSessionSummary(path.join(getLiveRunsDir(agentDir), runId), () => new Date());
}

export async function cleanupStaleLiveSessions(options: {
	agentDir: string;
	olderThanMs?: number;
	now?: () => Date;
}): Promise<string[]> {
	const now = options.now ?? (() => new Date());
	const olderThanMs = options.olderThanMs ?? 24 * 60 * 60 * 1_000;
	const sessions = await listLiveSessions({ agentDir: options.agentDir, now, includeProcessFallback: false });
	const removed: string[] = [];
	for (const session of sessions) {
		if (!session.isStale) continue;
		const heartbeatMs = session.heartbeatAt ? Date.parse(session.heartbeatAt) : Date.parse(session.updatedAt);
		if (Number.isFinite(heartbeatMs) && now().getTime() - heartbeatMs < olderThanMs) continue;
		await fs.rm(session.runDir, { recursive: true, force: true });
		removed.push(session.runId);
	}
	return removed;
}

export async function listOmpProcessSessions(
	options: { now?: () => Date; excludePids?: ReadonlySet<number> } = {},
): Promise<LiveSessionSummary[]> {
	const now = options.now ?? (() => new Date());
	const detected = await detectOmpProcesses();
	return detected
		.filter(processInfo => processInfo.pid !== process.pid)
		.filter(processInfo => !options.excludePids?.has(processInfo.pid))
		.filter(processInfo => !isSessionsCommand(processInfo.command))
		.map(processInfo => processSummaryFromDetectedProcess(processInfo, now));
}

export async function detectOmpProcesses(): Promise<DetectedOmpProcess[]> {
	const proc = Bun.spawn(["ps", "-axo", "pid=,command="], { stdout: "pipe", stderr: "ignore" });
	const stdout = proc.stdout as ReadableStream<Uint8Array>;
	const text = await new Response(stdout).text();
	await proc.exited;
	return parseOmpProcesses(text);
}

export function parseOmpProcesses(psOutput: string): DetectedOmpProcess[] {
	const processes: DetectedOmpProcess[] = [];
	for (const line of psOutput.split("\n")) {
		const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
		if (!match) continue;
		const pid = Number(match[1]);
		if (!Number.isInteger(pid) || pid <= 0) continue;
		const command = match[2]!;
		if (!isOmpCommand(command)) continue;
		processes.push({ pid, command });
	}
	return processes;
}

function processSummaryFromDetectedProcess(processInfo: DetectedOmpProcess, now: () => Date): LiveSessionSummary {
	const timestamp = now().toISOString();
	return {
		source: "process",
		runId: `process:${processInfo.pid}`,
		pid: processInfo.pid,
		cwd: "",
		agentId: `process:${processInfo.pid}`,
		sessionId: "",
		sessionFile: null,
		startedAt: timestamp,
		updatedAt: timestamp,
		status: "running",
		mode: "unknown",
		eventStreamPath: "",
		terminalSnapshotPath: "",
		isRunning: true,
		isStale: false,
		heartbeatAt: null,
		runDir: "",
		command: processInfo.command,
	};
}

function isOmpCommand(command: string): boolean {
	const parts = command.trim().split(/\s+/u);
	if (parts.length === 0) return false;
	const executable = parts[0] ?? "";
	if (isOmpExecutable(executable)) return true;
	if ((executable === "bun" || executable.endsWith("/bun")) && parts[1] && isOmpExecutable(parts[1])) return true;
	return false;
}

function isOmpExecutable(value: string): boolean {
	return value === "omp" || value.endsWith("/omp");
}

function isSessionsCommand(command: string): boolean {
	const parts = command.trim().split(/\s+/u);
	return parts.includes("sessions");
}

async function readLiveSessionSummary(runDir: string, now: () => Date): Promise<LiveSessionSummary | null> {
	const metadataPath = path.join(runDir, "metadata.json");
	let metadata: LiveSessionMetadata;
	try {
		metadata = JSON.parse(await Bun.file(metadataPath).text()) as LiveSessionMetadata;
	} catch (error) {
		if (isEnoentError(error)) return null;
		logger.warn("Failed to read live session metadata", { error: String(error), path: metadataPath });
		return null;
	}

	const heartbeat = await readHeartbeat(path.join(runDir, "heartbeat.json"));
	const heartbeatAt = heartbeat?.updatedAt ?? null;
	const isRunning =
		metadata.status === "running" && isProcessAlive(metadata.pid) && !isHeartbeatStale(heartbeatAt, now);
	const isStale = metadata.status === "running" && !isRunning;
	return {
		source: "registry",
		...metadata,
		status: isStale ? "stale" : metadata.status,
		isRunning,
		isStale,
		heartbeatAt,
		runDir,
	};
}

function sanitizeMetadataPatch(
	patch: Partial<Pick<LiveSessionMetadata, "model" | "sessionFile" | "sessionId" | "status">>,
): Partial<Pick<LiveSessionMetadata, "model" | "sessionFile" | "sessionId" | "status">> {
	const sanitized: Partial<Pick<LiveSessionMetadata, "model" | "sessionFile" | "sessionId" | "status">> = {};
	if ("model" in patch) sanitized.model = boundString(patch.model);
	if ("sessionFile" in patch)
		sanitized.sessionFile = patch.sessionFile ? boundString(patch.sessionFile) : patch.sessionFile;
	if ("sessionId" in patch) sanitized.sessionId = patch.sessionId ? boundString(patch.sessionId) : patch.sessionId;
	if ("status" in patch) sanitized.status = patch.status;
	return sanitized;
}

function createRunId(agentId: string, pid: number, startedAt: string): string {
	const safeAgentId = agentId.replace(/[^a-zA-Z0-9_-]/gu, "-").slice(0, 32) || "agent";
	return `${startedAt.replace(/[^0-9TZ]/gu, "")}-${pid}-${safeAgentId}`;
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
	await Bun.write(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

async function writeHeartbeat(filePath: string, now: () => Date): Promise<void> {
	await writeJson(filePath, { pid: process.pid, updatedAt: now().toISOString() } satisfies HeartbeatFile);
}

async function readHeartbeat(filePath: string): Promise<HeartbeatFile | null> {
	try {
		return JSON.parse(await Bun.file(filePath).text()) as HeartbeatFile;
	} catch (error) {
		if (isEnoentError(error)) return null;
		logger.warn("Failed to read live session heartbeat", { error: String(error), path: filePath });
		return null;
	}
}

function isHeartbeatStale(heartbeatAt: string | null, now: () => Date): boolean {
	if (!heartbeatAt) return true;
	const updatedAtMs = Date.parse(heartbeatAt);
	if (!Number.isFinite(updatedAtMs)) return true;
	return now().getTime() - updatedAtMs > STALE_AFTER_MS;
}

export function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
		return code === "EPERM";
	}
}

function boundString(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value;
}

function isEnoentError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
