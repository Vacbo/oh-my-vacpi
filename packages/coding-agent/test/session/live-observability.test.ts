import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runSessionsCommand, SessionsCommandError } from "@oh-my-pi/pi-coding-agent/cli/sessions-cli";
import { startSessionsServer } from "@oh-my-pi/pi-coding-agent/cli/sessions-server";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { LiveEventStream } from "@oh-my-pi/pi-coding-agent/session/live-event-stream";
import {
	inspectLiveSession,
	type LiveSessionMetadata,
	listLiveSessions,
	parseOmpProcesses,
	registerLiveSession,
} from "@oh-my-pi/pi-coding-agent/session/live-session-registry";
import { TerminalSnapshotRecorder } from "@oh-my-pi/pi-coding-agent/session/terminal-snapshot";
import { Snowflake } from "@oh-my-pi/pi-utils";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

describe("live session observability", () => {
	it("registers metadata, refreshes heartbeat state, and marks dead PIDs stale", async () => {
		const agentDir = await makeTempDir();
		const registration = await registerLiveSession({
			agentDir,
			cwd: "/tmp/project",
			agentId: "0-Main",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			mode: "interactive",
			model: "provider/model",
		});
		registration.refresh({ model: "provider/other" });

		const running = await listLiveSessions({ agentDir, runningOnly: true, includeProcessFallback: false });
		expect(running).toHaveLength(1);
		expect(running[0]?.isRunning).toBe(true);
		expect(running[0]?.model).toBe("provider/other");

		await registration.dispose();
		const stopped = await inspectLiveSession(agentDir, registration.runId);
		expect(stopped?.status).toBe("stopped");

		await writeFixtureRun(agentDir, {
			runId: "stale-run",
			pid: 99_999_999,
			cwd: "/tmp/stale",
			agentId: "0-Stale",
			sessionId: "stale-session",
			sessionFile: null,
			startedAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			status: "running",
			mode: "text",
			eventStreamPath: "",
			terminalSnapshotPath: "",
		});
		const sessions = await listLiveSessions({ agentDir, includeProcessFallback: false });
		expect(sessions.find(session => session.runId === "stale-run")?.status).toBe("stale");
	});

	it("detects running OMP processes when registry files are absent", () => {
		const processes = parseOmpProcesses(`
  101 bun /Users/vacbo/.local/bin/omp -r
  102 /Users/vacbo/.local/bin/omp --print hello
  103 bun /Users/vacbo/.local/bin/omp sessions list
  104 node /Users/vacbo/.bun/bin/codex app-server
`);
		expect(processes.map(processInfo => processInfo.pid)).toEqual([101, 102, 103]);
	});

	it("writes bounded JSONL event records in emission order", async () => {
		const agentDir = await makeTempDir();
		const streamPath = path.join(agentDir, "events.jsonl");
		const stream = new LiveEventStream({ path: streamPath });
		const longText = "x".repeat(800);
		stream.append({ type: "notice", level: "warning", message: longText } satisfies AgentSessionEvent);
		stream.append({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "bash",
			args: { secret: longText },
		} satisfies AgentSessionEvent);
		await stream.flush();

		const lines = (await Bun.file(streamPath).text()).trim().split("\n");
		expect(lines).toHaveLength(2);
		const first = JSON.parse(lines[0]!) as { sequence: number; type: string; data: { message: string } };
		const second = JSON.parse(lines[1]!) as { sequence: number; type: string; data: { argsPreview: string } };
		expect(first.sequence).toBe(1);
		expect(first.type).toBe("notice");
		expect(first.data.message.length).toBeLessThan(longText.length);
		expect(second.sequence).toBe(2);
		expect(second.data.argsPreview.length).toBeLessThan(longText.length + 20);
	});

	it("captures ANSI terminal text and cell attributes", async () => {
		const agentDir = await makeTempDir();
		const recorder = new TerminalSnapshotRecorder({ path: path.join(agentDir, "terminal.json"), cols: 20, rows: 4 });
		recorder.write("hello\r\n\x1b[1mbright\x1b[0m");
		await Bun.sleep(60);
		const snapshot = recorder.snapshot();
		expect(snapshot.text).toContain("hello");
		expect(snapshot.text).toContain("bright");
		expect(snapshot.lines.flatMap(line => line.cells).some(cell => cell.text === "b" && cell.bold)).toBe(true);
		recorder.dispose();
	});

	it("captures extended cell attributes, color modes, and cursor visibility", async () => {
		const agentDir = await makeTempDir();
		const recorder = new TerminalSnapshotRecorder({ path: path.join(agentDir, "terminal.json"), cols: 40, rows: 6 });
		recorder.write("\x1b[2mdim\x1b[0m \x1b[9mss\x1b[0m \x1b[31mred\x1b[0m \x1b[38;2;10;20;30mrgb\x1b[0m");
		await Bun.sleep(60);
		let snapshot = recorder.snapshot();
		const cells = snapshot.lines.flatMap(line => line.cells);
		expect(cells.some(cell => cell.text === "d" && cell.dim)).toBe(true);
		expect(cells.some(cell => cell.text === "s" && cell.strikethrough)).toBe(true);
		const palette = cells.find(cell => cell.text === "r" && cell.fg?.mode === "palette");
		expect(palette?.fg?.value).toBe(1);
		const rgb = cells.find(cell => cell.fg?.mode === "rgb");
		expect(rgb?.fg?.value).toBe(0x0a141e);
		expect(snapshot.cursorVisible).toBe(true);

		recorder.write("\x1b[?25l");
		await Bun.sleep(40);
		snapshot = recorder.snapshot();
		expect(snapshot.cursorVisible).toBe(false);
		recorder.dispose();
	});

	it("lists and inspects fixture runs through the sessions CLI", async () => {
		const agentDir = await makeTempDir();
		const metadata = await writeFixtureRun(agentDir, {
			runId: "fixture-run",
			pid: process.pid,
			cwd: "/tmp/project",
			agentId: "0-Main",
			sessionId: "session-fixture",
			sessionFile: null,
			startedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			status: "running",
			mode: "interactive",
			model: "provider/model",
			eventStreamPath: "",
			terminalSnapshotPath: "",
		});
		const lines = await captureStdout(async () => {
			await runSessionsCommand({ action: "list", flags: { json: true, running: true, agentDir } });
		});
		const listed = JSON.parse(lines.join("\n")) as LiveSessionMetadata[];
		expect(listed.some(session => session.runId === metadata.runId)).toBe(true);

		const inspectLines = await captureStdout(async () => {
			await runSessionsCommand({ action: "inspect", runId: metadata.runId, flags: { agentDir } });
		});
		const inspected = JSON.parse(inspectLines.join("\n")) as { session: LiveSessionMetadata };
		expect(inspected.session.cwd).toBe("/tmp/project");
	});

	it("serves a read-only browser mirror with queryable metadata and terminal text", async () => {
		const agentDir = await makeTempDir();
		const metadata = await writeFixtureRun(agentDir, {
			runId: "browser-run",
			pid: process.pid,
			cwd: "/tmp/browser-project",
			agentId: "0-Main",
			sessionId: "session-browser",
			sessionFile: null,
			startedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			status: "running",
			mode: "interactive",
			model: "provider/model",
			eventStreamPath: "",
			terminalSnapshotPath: "",
		});
		const recorder = new TerminalSnapshotRecorder({ path: metadata.terminalSnapshotPath, cols: 30, rows: 4 });
		recorder.write("browser ready");
		await Bun.sleep(60);
		await recorder.persist();
		recorder.dispose();

		const server = startSessionsServer({ agentDir });
		try {
			const html = await fetch(`${server.url}/sessions?run=${metadata.runId}`).then(response => response.text());
			expect(html).toContain("data-session-metadata");
			expect(html).toContain("data-terminal-snapshot");
			expect(html).toContain("browser ready");
		} finally {
			server.stop();
		}
	});

	it("exposes API endpoints, photo mode, and stable terminal selectors", async () => {
		const agentDir = await makeTempDir();
		const now = new Date().toISOString();
		const metadata = await writeFixtureRun(agentDir, {
			runId: "api-run",
			pid: process.pid,
			cwd: "/tmp/api-project",
			agentId: "0-Main",
			sessionId: "session-api",
			sessionFile: null,
			startedAt: now,
			updatedAt: now,
			status: "running",
			mode: "interactive",
			model: "provider/model",
			eventStreamPath: "",
			terminalSnapshotPath: "",
		});
		const recorder = new TerminalSnapshotRecorder({ path: metadata.terminalSnapshotPath, cols: 30, rows: 4 });
		recorder.write("api ready");
		await Bun.sleep(60);
		await recorder.persist();
		recorder.dispose();
		await Bun.write(
			metadata.eventStreamPath,
			`${JSON.stringify({ sequence: 1, timestamp: now, type: "notice", data: { message: "hi" } })}\n`,
		);

		const server = startSessionsServer({ agentDir });
		try {
			const html = await fetch(`${server.url}/sessions?run=${metadata.runId}`).then(response => response.text());
			expect(html).toContain("data-terminal-row");
			expect(html).toContain("data-terminal-cell");
			expect(html).toContain("data-cursor");

			const photo = await fetch(`${server.url}/sessions?run=${metadata.runId}&mode=photo`).then(response =>
				response.text(),
			);
			expect(photo).toContain("data-terminal-snapshot");
			expect(photo).toContain("api ready");
			expect(photo).not.toContain("data-session-metadata");

			const terminal = (await fetch(`${server.url}/api/sessions/${metadata.runId}/terminal`).then(response =>
				response.json(),
			)) as { terminal: { text: string } | null };
			expect(terminal.terminal?.text).toContain("api ready");

			const events = (await fetch(`${server.url}/api/sessions/${metadata.runId}/events`).then(response =>
				response.json(),
			)) as { events: Array<{ type: string }> };
			expect(events.events.some(event => event.type === "notice")).toBe(true);
		} finally {
			server.stop();
		}
	});

	it("injects the drag-select overlay on the mirror page but never the photo page", async () => {
		const agentDir = await makeTempDir();
		const now = new Date().toISOString();
		const metadata = await writeFixtureRun(agentDir, {
			runId: "overlay-run",
			pid: process.pid,
			cwd: "/tmp/overlay",
			agentId: "0-Main",
			sessionId: "session-overlay",
			sessionFile: null,
			startedAt: now,
			updatedAt: now,
			status: "running",
			mode: "interactive",
			model: "provider/model",
			eventStreamPath: "",
			terminalSnapshotPath: "",
		});
		const recorder = new TerminalSnapshotRecorder({ path: metadata.terminalSnapshotPath, cols: 20, rows: 3 });
		recorder.write("row one\r\nrow two\r\nrow three");
		await Bun.sleep(60);
		await recorder.persist();
		recorder.dispose();

		const server = startSessionsServer({ agentDir });
		try {
			const page = await fetch(`${server.url}/sessions?run=${metadata.runId}`).then(r => r.text());
			const photo = await fetch(`${server.url}/sessions?run=${metadata.runId}&mode=photo`).then(r => r.text());
			// The mirror page carries the selection overlay (style + the drag script).
			expect(page).toContain("omp-sel-box");
			expect(page).toContain("Selection: rows ");
			// The photo page must stay overlay-free so region screenshots crop clean.
			expect(photo).not.toContain("omp-sel-box");
			expect(photo).not.toContain("Selection: rows ");
		} finally {
			server.stop();
		}
	});

	it("streams terminal snapshots over server-sent events", async () => {
		const agentDir = await makeTempDir();
		const now = new Date().toISOString();
		const metadata = await writeFixtureRun(agentDir, {
			runId: "sse-run",
			pid: process.pid,
			cwd: "/tmp/sse-project",
			agentId: "0-Main",
			sessionId: "session-sse",
			sessionFile: null,
			startedAt: now,
			updatedAt: now,
			status: "running",
			mode: "interactive",
			eventStreamPath: "",
			terminalSnapshotPath: "",
		});
		const recorder = new TerminalSnapshotRecorder({ path: metadata.terminalSnapshotPath, cols: 20, rows: 3 });
		recorder.write("sse ready");
		await Bun.sleep(60);
		await recorder.persist();
		recorder.dispose();

		const server = startSessionsServer({ agentDir });
		const abort = new AbortController();
		try {
			const response = await fetch(`${server.url}/api/sessions/${metadata.runId}/stream`, { signal: abort.signal });
			expect(response.headers.get("content-type")).toContain("text/event-stream");
			const reader = (response.body as ReadableStream<Uint8Array>).getReader();
			const chunk = await readSseEvent(reader, "terminal");
			expect(chunk).toContain("sse ready");
		} finally {
			abort.abort();
			server.stop();
		}
	});

	it("defaults watch to the only running registry session and streams its events", async () => {
		const agentDir = await makeTempDir();
		const now = new Date().toISOString();
		const metadata = await writeFixtureRun(agentDir, {
			runId: "watch-default",
			pid: process.pid,
			cwd: "/tmp/project",
			agentId: "0-Main",
			sessionId: "session-watch",
			sessionFile: null,
			startedAt: now,
			updatedAt: now,
			status: "running",
			mode: "interactive",
			model: "provider/model",
			eventStreamPath: "",
			terminalSnapshotPath: "",
		});
		await Bun.write(
			metadata.eventStreamPath,
			`${JSON.stringify({ sequence: 1, timestamp: now, type: "notice", data: { message: "hi" } })}\n${JSON.stringify({ sequence: 2, timestamp: now, type: "turn_end", data: {} })}\n`,
		);

		const lines = await captureStdout(async () => {
			await runSessionsCommand({ action: "watch", flags: { json: true, limit: 2, agentDir } });
		});
		const events = lines.map(line => JSON.parse(line) as { sequence: number; type: string });
		expect(events.map(event => event.sequence)).toEqual([1, 2]);
		expect(events[0]?.type).toBe("notice");
	});

	it("rejects ambiguous watch with a concise error listing run ids", async () => {
		const agentDir = await makeTempDir();
		const now = new Date().toISOString();
		for (const runId of ["watch-a", "watch-b"]) {
			await writeFixtureRun(agentDir, {
				runId,
				pid: process.pid,
				cwd: "/tmp/project",
				agentId: runId,
				sessionId: runId,
				sessionFile: null,
				startedAt: now,
				updatedAt: now,
				status: "running",
				mode: "interactive",
				eventStreamPath: "",
				terminalSnapshotPath: "",
			});
		}
		const error = await captureRejection(() =>
			runSessionsCommand({ action: "watch", flags: { json: true, limit: 1, agentDir } }),
		);
		expect(error).toBeInstanceOf(SessionsCommandError);
		expect(error.message).toContain("watch-a");
		expect(error.message).toContain("watch-b");
	});

	it("surfaces typed errors for missing and unknown run ids instead of throwing raw exceptions", async () => {
		const agentDir = await makeTempDir();
		const missing = await captureRejection(() => runSessionsCommand({ action: "inspect", flags: { agentDir } }));
		expect(missing).toBeInstanceOf(SessionsCommandError);
		expect(missing.message).toContain("requires a run id");

		const notFound = await captureRejection(() =>
			runSessionsCommand({ action: "inspect", runId: "does-not-exist", flags: { agentDir } }),
		);
		expect(notFound).toBeInstanceOf(SessionsCommandError);
		expect(notFound.message).toContain("not found");
	});
});

async function makeTempDir(): Promise<string> {
	const dir = path.join(os.tmpdir(), `omp-live-${Snowflake.next()}`);
	await fs.mkdir(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

async function writeFixtureRun(agentDir: string, metadata: LiveSessionMetadata): Promise<LiveSessionMetadata> {
	const runDir = path.join(agentDir, "runs", metadata.runId);
	await fs.mkdir(runDir, { recursive: true });
	const eventStreamPath = metadata.eventStreamPath || path.join(runDir, "events.jsonl");
	const terminalSnapshotPath = metadata.terminalSnapshotPath || path.join(runDir, "terminal-snapshot.json");
	const fullMetadata = { ...metadata, eventStreamPath, terminalSnapshotPath };
	await Bun.write(path.join(runDir, "metadata.json"), `${JSON.stringify(fullMetadata, null, 2)}\n`);
	await Bun.write(
		path.join(runDir, "heartbeat.json"),
		`${JSON.stringify({ pid: metadata.pid, updatedAt: metadata.updatedAt }, null, 2)}\n`,
	);
	await Bun.write(eventStreamPath, "");
	return fullMetadata;
}

async function captureStdout(fn: () => Promise<void>): Promise<string[]> {
	const original = process.stdout.write;
	const chunks: string[] = [];
	process.stdout.write = ((chunk: string | Uint8Array) => {
		chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
		return true;
	}) as unknown as typeof process.stdout.write;
	try {
		await fn();
	} finally {
		process.stdout.write = original;
	}
	return chunks.join("").trim().split("\n").filter(Boolean);
}

async function captureRejection(fn: () => Promise<unknown>): Promise<Error> {
	try {
		await fn();
	} catch (error) {
		return error as Error;
	}
	throw new Error("expected the call to reject");
}

async function readSseEvent(
	reader: { read(): Promise<{ value?: Uint8Array; done: boolean }> },
	eventName: string,
	maxChunks = 16,
): Promise<string> {
	const decoder = new TextDecoder();
	let accumulated = "";
	for (let attempt = 0; attempt < maxChunks; attempt++) {
		const { value, done } = await Promise.race([
			reader.read(),
			Bun.sleep(2_000).then(() => {
				throw new Error(`timed out waiting for SSE event: ${eventName}`);
			}),
		]);
		if (done) break;
		accumulated += decoder.decode(value, { stream: true });
		if (accumulated.includes(`event: ${eventName}`)) return accumulated;
	}
	return accumulated;
}
