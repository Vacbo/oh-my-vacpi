import { getAgentDir } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import {
	cleanupStaleLiveSessions,
	inspectLiveSession,
	type LiveSessionSummary,
	listLiveSessions,
	listOmpProcessSessions,
} from "../session/live-session-registry";
import { readTerminalSnapshot } from "../session/terminal-snapshot";
import { startSessionsServer } from "./sessions-server";

export type SessionsAction = "list" | "inspect" | "watch" | "serve" | "cleanup";

export interface SessionsCommandArgs {
	action: SessionsAction;
	runId?: string;
	flags: {
		json?: boolean;
		running?: boolean;
		agentDir?: string;
		limit?: number;
		port?: number;
	};
}

interface EventLine {
	sequence: number;
	timestamp: string;
	type: string;
	data?: unknown;
}

const WATCH_POLL_MS = 500;

export async function runSessionsCommand(cmd: SessionsCommandArgs): Promise<void> {
	const agentDir = cmd.flags.agentDir ?? getAgentDir();
	switch (cmd.action) {
		case "list":
			await runList(agentDir, cmd.flags);
			return;
		case "inspect":
			await runInspect(await resolveInspectTarget(agentDir, cmd.runId));
			return;
		case "watch":
			await runWatch(await resolveWatchTarget(agentDir, cmd.runId), cmd.flags);
			return;
		case "serve":
			await runServe(agentDir, cmd.flags.port ?? 0);
			return;
		case "cleanup":
			await runCleanup(agentDir, cmd.flags.json === true);
			return;
	}
}

async function runList(agentDir: string, flags: SessionsCommandArgs["flags"]): Promise<void> {
	const sessions = await listLiveSessions({ agentDir, runningOnly: flags.running });
	if (flags.json) {
		writeLine(JSON.stringify(sessions, null, 2));
		return;
	}
	if (sessions.length === 0) {
		writeLine(chalk.dim("No live sessions found"));
		return;
	}
	for (const session of sessions) {
		writeLine(formatSessionSummary(session));
	}
}

async function runInspect(session: LiveSessionSummary): Promise<void> {
	const terminal = session.terminalSnapshotPath ? await readTerminalSnapshot(session.terminalSnapshotPath) : null;
	writeLine(JSON.stringify({ session, terminal }, null, 2));
}

async function runWatch(session: LiveSessionSummary, flags: SessionsCommandArgs["flags"]): Promise<void> {
	let offset = 0;
	let printed = 0;
	const limit = flags.limit && flags.limit > 0 ? flags.limit : undefined;
	while (limit === undefined || printed < limit) {
		const result = await readNewEventLines(session.eventStreamPath, offset);
		offset = result.offset;
		for (const event of result.events) {
			writeLine(flags.json ? JSON.stringify(event) : formatEvent(event));
			printed += 1;
			if (limit !== undefined && printed >= limit) return;
		}
		await Bun.sleep(WATCH_POLL_MS);
	}
}

async function runServe(agentDir: string, port: number): Promise<void> {
	const server = startSessionsServer({ agentDir, port });
	writeLine(`OMP sessions browser mirror: ${server.url}`);
	const shutdown = Promise.withResolvers<void>();
	const stop = () => shutdown.resolve();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	await shutdown.promise;
	server.stop();
}

async function runCleanup(agentDir: string, json: boolean): Promise<void> {
	const removed = await cleanupStaleLiveSessions({ agentDir });
	if (json) {
		writeLine(JSON.stringify({ removed }, null, 2));
		return;
	}
	writeLine(`Removed ${removed.length} stale session run${removed.length === 1 ? "" : "s"}`);
}

async function readNewEventLines(filePath: string, offset: number): Promise<{ offset: number; events: EventLine[] }> {
	let data: ArrayBuffer;
	try {
		data = await Bun.file(filePath).arrayBuffer();
	} catch (error) {
		if (isEnoentError(error)) return { offset, events: [] };
		throw error;
	}
	const bytes = new Uint8Array(data);
	if (offset > bytes.byteLength) offset = 0;
	const text = new TextDecoder().decode(bytes.subarray(offset));
	const events: EventLine[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		const parsed = parseEventLine(line);
		if (parsed) events.push(parsed);
	}
	return { offset: bytes.byteLength, events };
}

function parseEventLine(line: string): EventLine | null {
	try {
		const value = JSON.parse(line) as unknown;
		if (!value || typeof value !== "object") return null;
		const record = value as { sequence?: unknown; timestamp?: unknown; type?: unknown; data?: unknown };
		if (
			typeof record.sequence !== "number" ||
			typeof record.timestamp !== "string" ||
			typeof record.type !== "string"
		) {
			return null;
		}
		return { sequence: record.sequence, timestamp: record.timestamp, type: record.type, data: record.data };
	} catch {
		return null;
	}
}

export class SessionsCommandError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SessionsCommandError";
	}
}

async function resolveInspectTarget(agentDir: string, runId: string | undefined): Promise<LiveSessionSummary> {
	if (!runId) {
		throw new SessionsCommandError("inspect requires a run id. Run `omp sessions list` to see available run ids.");
	}
	const session = await resolveSession(agentDir, runId);
	if (!session) {
		throw new SessionsCommandError(`Session ${runId} not found. Run \`omp sessions list\` to see available run ids.`);
	}
	return session;
}

async function resolveWatchTarget(agentDir: string, runId: string | undefined): Promise<LiveSessionSummary> {
	if (runId) {
		const session = await resolveSession(agentDir, runId);
		if (!session) {
			throw new SessionsCommandError(
				`Session ${runId} not found. Run \`omp sessions list\` to see available run ids.`,
			);
		}
		if (session.source === "process" || !session.eventStreamPath) {
			throw new SessionsCommandError(
				`Session ${runId} is a process-only session without an event stream; watch is unavailable. Use \`omp sessions inspect ${runId}\` for a point-in-time view.`,
			);
		}
		return session;
	}
	const streamable = (await listLiveSessions({ agentDir, runningOnly: true, includeProcessFallback: false })).filter(
		session => session.eventStreamPath,
	);
	if (streamable.length === 1) return streamable[0]!;
	if (streamable.length > 1) {
		throw new SessionsCommandError(
			`Multiple running sessions found; specify a run id: ${streamable.map(session => session.runId).join(", ")}`,
		);
	}
	const processSessions = await listOmpProcessSessions();
	if (processSessions.length > 0) {
		throw new SessionsCommandError(
			`No registry-backed sessions with an event stream are running. Detected process-only OMP sessions without event streams: ${processSessions
				.map(session => session.runId)
				.join(", ")}. Watch is unavailable for process-only sessions.`,
		);
	}
	throw new SessionsCommandError("No running OMP sessions found.");
}

async function resolveSession(agentDir: string, runId: string): Promise<LiveSessionSummary | null> {
	const registered = await inspectLiveSession(agentDir, runId);
	if (registered) return registered;
	const processSessions = await listOmpProcessSessions();
	return processSessions.find(session => session.runId === runId) ?? null;
}

function formatSessionSummary(session: LiveSessionSummary): string {
	const status = session.isRunning
		? chalk.green(session.status)
		: session.isStale
			? chalk.yellow(session.status)
			: session.status;
	const location = session.cwd || session.command || "";
	return `${session.runId}  ${status}  ${session.source}  pid=${session.pid}  ${location}`;
}

function formatEvent(event: EventLine): string {
	return `${event.sequence} ${event.timestamp} ${event.type}`;
}

function writeLine(line: string): void {
	process.stdout.write(`${line}\n`);
}

function isEnoentError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
