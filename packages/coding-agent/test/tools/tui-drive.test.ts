import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { disposeAllTuiDriveSessions, TuiDriveTool } from "@oh-my-pi/pi-coding-agent/tools/tui-drive";
import * as piUtils from "@oh-my-pi/pi-utils";

const tempDirs: string[] = [];

afterEach(async () => {
	disposeAllTuiDriveSessions();
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tui-drive-test-"));
	tempDirs.push(dir);
	return dir;
}

function fakeSession(): ToolSession {
	const settings = {
		get: () => undefined,
		getShellConfig: () => ({ shell: undefined }),
	} as unknown as Settings;
	return { cwd: os.tmpdir(), settings } as unknown as ToolSession;
}

interface ScreenPayload {
	session: string;
	status: "running" | "exited";
	text: string;
	timedOut?: boolean;
	exitCode?: number;
	cols?: number;
	rows?: number;
}

function payloadOf<T = ScreenPayload>(result: { content: Array<{ type: string; text?: string }> }): T {
	const text = result.content.find(part => part.type === "text")?.text;
	if (!text) throw new Error("no text content in tool result");
	return JSON.parse(text) as T;
}

/** Raw-mode echo fixture: prints READY, then `got:<json>` per stdin chunk; "q" prints BYE and exits. */
const ECHO_FIXTURE = `bun -e 'process.stdin.setRawMode(true); process.stdout.write("READY\\n"); process.stdin.on("data", b => { const s = b.toString(); if (s === "q") { process.stdout.write("BYE\\n"); process.exit(0); } process.stdout.write("got:" + JSON.stringify(s) + "\\n"); });'`;

/** Emits a DSR cursor-position query and echoes whatever reply arrives on stdin. */
const DSR_FIXTURE = `bun -e 'process.stdin.setRawMode(true); process.stdout.write("\\u001b[6n"); process.stdin.on("data", b => { process.stdout.write("reply:" + JSON.stringify(b.toString()) + "\\n"); if (b.toString().includes("R")) process.exit(0); });'`;

describe("tui_drive tool", () => {
	it("classifies read vs exec actions for approval gating", () => {
		const tool = new TuiDriveTool(fakeSession());
		const approval = tool.approval;
		if (typeof approval !== "function") throw new Error("approval should be dynamic");
		expect(approval({ action: "screen" })).toBe("read");
		expect(approval({ action: "list" })).toBe("read");
		expect(approval({ action: "wait" })).toBe("read");
		expect(approval({ action: "diff" })).toBe("read");
		expect(approval({ action: "start" })).toBe("exec");
		expect(approval({ action: "input" })).toBe("exec");
		expect(approval({ action: "resize" })).toBe("exec");
		expect(approval({ action: "kill" })).toBe("exec");
		expect(approval({ action: "screenshot" })).toBe("exec");
	});

	it("drives a PTY fixture through its full lifecycle", async () => {
		const agentDir = await makeTempDir();
		const spy = spyOn(piUtils, "getAgentDir").mockReturnValue(agentDir);
		try {
			const tool = new TuiDriveTool(fakeSession());
			const debounceMs = 50;

			// start: spawned screen shows the fixture's READY banner
			const started = payloadOf(await tool.execute("t1", { action: "start", command: ECHO_FIXTURE, debounceMs }));
			expect(started.status).toBe("running");
			expect(started.text).toContain("READY");
			const session = started.session;

			// input text: raw-mode child reports the literal bytes it received
			const typed = payloadOf(await tool.execute("t2", { action: "input", session, text: "ab", debounceMs }));
			expect(typed.text).toContain('got:"ab"');

			// input keys: enter encodes as CR, up as the CSI arrow sequence
			const entered = payloadOf(await tool.execute("t3", { action: "input", session, keys: ["enter"], debounceMs }));
			expect(entered.text).toContain('got:"\\r"');
			const arrowed = payloadOf(await tool.execute("t4", { action: "input", session, keys: ["up"], debounceMs }));
			expect(arrowed.text).toContain('got:"\\u001b[A"');

			// unknown key: rejected with the key named, session stays usable
			await expect(
				tool.execute("t5", { action: "input", session, keys: ["definitely+bogus"], debounceMs }),
			).rejects.toThrow(/definitely\+bogus/);

			// "\n" in text is translated to Enter (CR)
			const newline = payloadOf(await tool.execute("t6", { action: "input", session, text: "\n", debounceMs }));
			expect(newline.text).toContain('got:"\\r"');

			// quit: wait observes BYE, then the exit is recorded
			await tool.execute("t7", { action: "input", session, text: "q", debounceMs });
			const waited = payloadOf(
				await tool.execute("t8", { action: "wait", session, waitText: "BYE", timeoutMs: 3000 }),
			);
			expect(waited.timedOut).toBe(false);
			expect(waited.text).toContain("BYE");
			// Real-PTY integration: the exit notification arrives from the kernel
			// asynchronously and the tool surface exposes no completion promise, so
			// poll the observable contract (bounded; fake timers cannot drive a PTY).
			const deadline = Date.now() + 3000;
			let screen = payloadOf(await tool.execute("t9", { action: "screen", session }));
			while (screen.status !== "exited" && Date.now() < deadline) {
				await Bun.sleep(50);
				screen = payloadOf(await tool.execute("t9", { action: "screen", session }));
			}
			expect(screen.status).toBe("exited");
			expect(screen.exitCode).toBe(0);

			// input/resize after exit are rejected
			await expect(tool.execute("t10", { action: "input", session, text: "x" })).rejects.toThrow(/has exited/);
			await expect(tool.execute("t11", { action: "resize", session, cols: 80, rows: 24 })).rejects.toThrow(
				/has exited/,
			);

			// screenshot of a non-omp child: correlation fails with the documented error
			await expect(tool.execute("t12", { action: "screenshot", session })).rejects.toThrow(
				/No registered omp session/,
			);

			// kill on an exited session removes the record
			await tool.execute("t13", { action: "kill", session });
			const listed = payloadOf<{ sessions: unknown[] }>(await tool.execute("t14", { action: "list" }));
			expect(listed.sessions).toHaveLength(0);
		} finally {
			spy.mockRestore();
		}
	});

	it("answers terminal queries (DSR) through the recorder onData loop", async () => {
		const tool = new TuiDriveTool(fakeSession());
		const started = payloadOf(await tool.execute("d1", { action: "start", command: DSR_FIXTURE, debounceMs: 50 }));
		const waited = payloadOf(
			await tool.execute("d2", { action: "wait", session: started.session, waitText: "reply:", timeoutMs: 5000 }),
		);
		expect(waited.timedOut).toBe(false);
		// xterm answers CSI 6n with CSI <row>;<col>R, forwarded into the PTY
		expect(waited.text).toMatch(/reply:"\\u001b\[\d+;\d+R"/);
	});

	it("caps concurrent sessions at four", async () => {
		const tool = new TuiDriveTool(fakeSession());
		for (let i = 0; i < 4; i++) {
			await tool.execute(`c${i}`, { action: "start", command: "sleep 30", debounceMs: 50 });
		}
		await expect(tool.execute("c5", { action: "start", command: "sleep 30", debounceMs: 50 })).rejects.toThrow(
			/Too many drive sessions/,
		);
	});

	it("resizes the PTY and reports the new geometry", async () => {
		const tool = new TuiDriveTool(fakeSession());
		const started = payloadOf(
			await tool.execute("r1", { action: "start", command: ECHO_FIXTURE, cols: 100, rows: 30, debounceMs: 50 }),
		);
		const resized = payloadOf(
			await tool.execute("r2", { action: "resize", session: started.session, cols: 80, rows: 24, debounceMs: 50 }),
		);
		expect(resized.cols).toBe(80);
		expect(resized.rows).toBe(24);
	});
});
