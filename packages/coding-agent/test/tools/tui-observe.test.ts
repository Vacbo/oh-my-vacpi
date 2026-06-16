import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { LiveSessionMetadata } from "@oh-my-pi/pi-coding-agent/session/live-session-registry";
import { TerminalSnapshotRecorder } from "@oh-my-pi/pi-coding-agent/session/terminal-snapshot";
import {
	buildRegionScreenshotCode,
	inlineScreenshotImage,
	parseScreenshotRegion,
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

	it("inlines a captured screenshot as a renderable image block, and never fails the capture over it", async () => {
		const dir = await makeTempDir();
		const dest = path.join(dir, "shot.png");
		const onePixelPng = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
			"base64",
		);
		await Bun.write(dest, onePixelPng);
		const block = await inlineScreenshotImage(dest);
		expect(block?.type).toBe("image");
		expect(block?.mimeType).toMatch(/^image\//);
		// The block must decode as a real image; that is what the TUI and model receive.
		const meta = await new Bun.Image(Buffer.from(block!.data, "base64")).metadata();
		expect(meta.width).toBe(1);
		expect(meta.height).toBe(1);

		expect(await inlineScreenshotImage(path.join(dir, "missing.png"))).toBeUndefined();
	});
});

describe("parseScreenshotRegion", () => {
	it("returns undefined when no region params are present", () => {
		expect(parseScreenshotRegion({})).toBeUndefined();
	});

	it("parses a single row and an inclusive row range", () => {
		expect(parseScreenshotRegion({ rows: "5" })).toEqual({ rows: [5, 5] });
		expect(parseScreenshotRegion({ rows: "4-9" })).toEqual({ rows: [4, 9] });
	});

	it("parses cols within rows and carries highlight", () => {
		expect(parseScreenshotRegion({ rows: "4-9", cols: "10-40", highlight: true })).toEqual({
			rows: [4, 9],
			cols: [10, 40],
			highlight: true,
		});
	});

	it("accepts a raw selector escape hatch", () => {
		expect(parseScreenshotRegion({ selector: '[data-terminal-row="3"]' })).toEqual({
			selector: '[data-terminal-row="3"]',
		});
	});

	it("rejects cols without rows", () => {
		expect(() => parseScreenshotRegion({ cols: "1-2" })).toThrow(/cols.*requires.*rows/i);
	});

	it("rejects rows and selector together", () => {
		expect(() => parseScreenshotRegion({ rows: "1", selector: ".x" })).toThrow(/either.*rows.*selector/i);
	});

	it("rejects highlight without a region", () => {
		expect(() => parseScreenshotRegion({ highlight: true })).toThrow(/highlight.*requires/i);
	});

	it("rejects malformed and inverted ranges", () => {
		expect(() => parseScreenshotRegion({ rows: "abc" })).toThrow(/Invalid rows range/);
		expect(() => parseScreenshotRegion({ rows: "9-4" })).toThrow(/start greater than end/);
	});
});

describe("buildRegionScreenshotCode", () => {
	it("crops to the selection overlay by default and carries the spec", () => {
		const region = parseScreenshotRegion({ rows: "4-9" })!;
		const code = buildRegionScreenshotCode(region, "/tmp/shot.png");
		expect(code).toContain('selector: "#__omp_sel_overlay"');
		expect(code).toContain('"rows":[4,9]');
		expect(code).not.toContain("fullPage: true");
	});

	it("captures full page when highlighting instead of cropping", () => {
		const region = parseScreenshotRegion({ rows: "4-9", highlight: true })!;
		const code = buildRegionScreenshotCode(region, "/tmp/shot.png");
		expect(code).toContain("fullPage: true");
		expect(code).not.toContain("#__omp_sel_overlay");
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
