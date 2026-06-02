import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { LiveSessionMetadata } from "@oh-my-pi/pi-coding-agent/session/live-session-registry";
import { TerminalSnapshotRecorder } from "@oh-my-pi/pi-coding-agent/session/terminal-snapshot";
import {
	resolveTuiScreenshotDest,
	stopSharedMirror,
	TuiObserveTool,
} from "@oh-my-pi/pi-coding-agent/tools/tui-observe";
import * as piUtils from "@oh-my-pi/pi-utils";
import { Snowflake } from "@oh-my-pi/pi-utils";

const tempDirs: string[] = [];

afterEach(async () => {
	stopSharedMirror();
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

function fakeSettings(values: Record<string, string | undefined>): Settings {
	return { get: (key: string) => values[key] } as unknown as Settings;
}

function fakeSession(values: Record<string, string | undefined> = {}): ToolSession {
	return { cwd: "/tmp", settings: fakeSettings(values) } as unknown as ToolSession;
}

function firstText(content: Array<{ type: string; text?: string }>): string {
	const text = content.find(part => part.type === "text")?.text;
	if (!text) throw new Error("no text content");
	return text;
}

describe("tui_observe tool", () => {
	it("classifies read vs exec actions for approval gating", () => {
		const tool = new TuiObserveTool(fakeSession());
		const approval = tool.approval;
		if (typeof approval !== "function") throw new Error("approval should be dynamic");
		expect(approval({ action: "snapshot" })).toBe("read");
		expect(approval({ action: "list" })).toBe("read");
		expect(approval({ action: "screenshot" })).toBe("exec");
		expect(approval({ action: "native_screenshot" })).toBe("exec");
	});

	it("resolves screenshot destinations with the documented precedence", () => {
		const now = () => new Date("2026-06-02T03:04:05.000Z");
		const mirror = resolveTuiScreenshotDest(
			fakeSettings({ "tui.screenshotDir": "/shots", "browser.screenshotDir": "/browser" }),
			"mirror",
			"run-1",
			now,
		);
		expect(mirror).toBe(path.join("/shots", "omp-tui-run-1-mirror-20260602030405.png"));

		const mirrorBrowserFallback = resolveTuiScreenshotDest(
			fakeSettings({ "browser.screenshotDir": "/browser" }),
			"mirror",
			"run-1",
			now,
		);
		expect(mirrorBrowserFallback).toBe(path.join("/browser", "omp-tui-run-1-mirror-20260602030405.png"));

		const native = resolveTuiScreenshotDest(
			fakeSettings({ "tui.nativeCapture.screenshotDir": "/native", "tui.screenshotDir": "/shots" }),
			"native",
			"run-1",
			now,
		);
		expect(native).toBe(path.join("/native", "omp-tui-run-1-native-20260602030405.png"));

		const tempFallback = resolveTuiScreenshotDest(fakeSettings({}), "mirror", "run/with:bad*chars", now);
		expect(tempFallback.startsWith(os.tmpdir())).toBe(true);
		expect(path.basename(tempFallback)).toBe("omp-tui-run-with-bad-chars-mirror-20260602030405.png");
	});

	it("lists, snapshots, and reads events for the current session", async () => {
		const agentDir = await makeTempDir();
		const spy = spyOn(piUtils, "getAgentDir").mockReturnValue(agentDir);
		try {
			const now = new Date().toISOString();
			const metadata = await writeFixtureRun(agentDir, {
				runId: "observe-run",
				pid: process.pid,
				cwd: "/tmp/observe",
				agentId: "0-Main",
				sessionId: "session-observe",
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
			recorder.write("observe ready");
			await Bun.sleep(60);
			await recorder.persist();
			recorder.dispose();
			await Bun.write(
				metadata.eventStreamPath,
				`${JSON.stringify({ sequence: 1, timestamp: now, type: "notice", data: { message: "hi" } })}\n`,
			);

			const tool = new TuiObserveTool(fakeSession());

			const listResult = await tool.execute("c1", { action: "list", running: true });
			const listed = JSON.parse(firstText(listResult.content)) as { sessions: Array<{ runId: string }> };
			expect(listed.sessions.some(session => session.runId === "observe-run")).toBe(true);

			const snapshotResult = await tool.execute("c2", { action: "snapshot" });
			const snapshot = JSON.parse(firstText(snapshotResult.content)) as {
				runId: string;
				terminal: { text: string; cursor: { visible: boolean } } | null;
			};
			expect(snapshot.runId).toBe("observe-run");
			expect(snapshot.terminal?.text).toContain("observe ready");

			const eventsResult = await tool.execute("c3", { action: "events" });
			const events = JSON.parse(firstText(eventsResult.content)) as { events: Array<{ type: string }> };
			expect(events.events.some(event => event.type === "notice")).toBe(true);

			const mirrorResult = await tool.execute("c4", { action: "mirror" });
			const mirror = JSON.parse(firstText(mirrorResult.content)) as { mirrorUrl: string };
			expect(mirror.mirrorUrl).toContain("127.0.0.1");
			expect(mirror.mirrorUrl).toContain("observe-run");
		} finally {
			spy.mockRestore();
		}
	});
});

async function makeTempDir(): Promise<string> {
	const dir = path.join(os.tmpdir(), `omp-observe-${Snowflake.next()}`);
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
