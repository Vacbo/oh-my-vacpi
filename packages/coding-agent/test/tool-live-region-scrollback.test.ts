import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { type Component, Text, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

class MutableLiveBlock implements Component {
	#lines: string[];
	#finalized: boolean;

	constructor(lines: string[], finalized = false) {
		this.#lines = [...lines];
		this.#finalized = finalized;
	}

	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}

	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}
}

// A live block that declares a prefix of settled rows through the
// FinalizableBlock seam (getTranscriptBlockSettledRows). The container extends
// the live-region seam through exactly this declared count; the block owns it
// and may grow or retreat it as streaming resolves.
class SettledLiveBlock implements Component {
	#lines: string[];
	#settledRows: number;

	constructor(lines: string[], settledRows: number) {
		this.#lines = [...lines];
		this.#settledRows = settledRows;
	}

	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}

	update(lines: string[], settledRows: number): void {
		this.#lines = [...lines];
		this.#settledRows = settledRows;
	}

	isTranscriptBlockFinalized(): boolean {
		return false;
	}

	getTranscriptBlockSettledRows(): number {
		return this.#settledRows;
	}
}

// A finalized block whose render() returns the SAME array reference every
// frame, so the container's segment-reuse recognizes it as a byte-stable
// prefix (MutableLiveBlock re-maps a fresh array each call and is never
// reused). Gives the transcript a stable head above a mutating tail.
class StableHeadBlock implements Component {
	#rows: string[];

	constructor(rows: string[]) {
		this.#rows = rows;
	}

	render(_width: number): string[] {
		return this.#rows;
	}

	isTranscriptBlockFinalized(): boolean {
		return true;
	}
}

function markerLines(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_unused, i) => `${prefix}${i}`);
}

function stripRows(rows: string[]): string {
	return rows.map(row => Bun.stripANSI(row).trimEnd()).join("\n");
}

describe("transcript live-region seam", () => {
	// The live-region seam (getNativeScrollbackLiveRegionStart) is the local
	// line index that splits the most recent render: rows with index < seam are
	// final and commit-eligible (the leading finalized blocks plus the first
	// live block's declared settled rows), rows with index >= seam are the live
	// region and may still be rewritten. TUI commits only the final rows to
	// native scrollback. The container reads the settled count from the block
	// each render — it applies no append-only classifier of its own.

	it("reports undefined with no live block and 0 for a live block declaring no settled rows", () => {
		// Every block finalized => no mutable region => the seam is absent.
		const finalizedOnly = new TranscriptContainer();
		finalizedOnly.addChild(new MutableLiveBlock(markerLines("done-", 4), true));
		finalizedOnly.render(80);
		expect(finalizedOnly.getNativeScrollbackLiveRegionStart()).toBeUndefined();

		// A live block that never implements getTranscriptBlockSettledRows()
		// commits nothing mid-stream: the seam sits at its first row.
		const live = new TranscriptContainer();
		live.addChild(new MutableLiveBlock(markerLines("live-", 6)));
		live.render(80);
		expect(live.getNativeScrollbackLiveRegionStart()).toBe(0);
	});

	it("extends the seam through the block's declared settled rows, tracking growth and retreat", () => {
		const chat = new TranscriptContainer();
		const block = new SettledLiveBlock(markerLines("row-", 5), 3);
		chat.addChild(block);

		// The seam is exactly the declared settled prefix.
		chat.render(80);
		expect(chat.getNativeScrollbackLiveRegionStart()).toBe(3);

		// Streaming freezes more of the head: the seam advances with the larger
		// declaration.
		block.update(markerLines("row-", 8), 5);
		chat.render(80);
		expect(chat.getNativeScrollbackLiveRegionStart()).toBe(5);

		// An interior rewrite unsettles rows the block previously froze; it
		// retracts the count and the seam retreats with it. The container keeps
		// no monotonic ratchet — it trusts the block's live declaration.
		block.update(["row-0", "rewritten", ...markerLines("row-", 8).slice(2)], 2);
		chat.render(80);
		expect(chat.getNativeScrollbackLiveRegionStart()).toBe(2);

		// A declaration beyond the rendered body is clamped to the line count:
		// the seam can never point past the transcript.
		block.update(markerLines("row-", 4), 99);
		chat.render(80);
		expect(chat.getNativeScrollbackLiveRegionStart()).toBe(4);
	});

	it("offsets the seam by the rows of finalized blocks above the live block", () => {
		const chat = new TranscriptContainer();
		chat.addChild(new MutableLiveBlock(markerLines("fin-", 3), true));
		chat.addChild(new SettledLiveBlock(markerLines("live-", 4), 2));

		chat.render(80);
		// 3 finalized head rows + 1 inter-block separator + 2 declared settled
		// rows = 6: all sit above the seam and are commit-eligible. Ignoring the
		// finalized prefix would collapse the seam to 2 and strand the head.
		expect(chat.getNativeScrollbackLiveRegionStart()).toBe(6);
	});

	it("consumes and rebases the render stable prefix on each read", () => {
		const chat = new TranscriptContainer();
		// A byte-stable finalized head (3 rows) above a mutating live tail.
		const head = new StableHeadBlock(markerLines("head-", 3));
		const tail = new MutableLiveBlock(["tail-0", "tail-1"]);
		chat.addChild(head);
		chat.addChild(tail);

		// Frame 1: the engine renders then reads once per frame. The first
		// frame has no prior baseline, so the stable prefix is 0; the read
		// rebases the floor to the full line count.
		chat.render(80);
		expect(chat.getRenderStablePrefixRows()).toBe(0);

		// Frame 2: the head is unchanged (same render array reference) while the
		// tail re-renders. The read reports only the stable head — 3 rows.
		tail.setLines(["tail-0", "tail-1-grown"]);
		const total = chat.render(80).length; // 3 head + 1 gap + 2 tail
		expect(chat.getRenderStablePrefixRows()).toBe(3);

		// getRenderStablePrefixRows is consumptive/rebasing: a second read with
		// no intervening render returns the full current line count, because the
		// prior read re-based the baseline to it.
		expect(chat.getRenderStablePrefixRows()).toBe(total);
	});
});

describe("tool live-region scrollback", () => {
	beforeAll(async () => {
		await initTheme();
		// The task progress renderer reads settings (resolved-model badge).
		await Settings.init({ inMemory: true, cwd: process.cwd() });
	});

	it("does not splice stale pending eval preview above the running eval viewport", async () => {
		if (process.platform === "win32") return;

		const term = new VirtualTerminal(120, 12);
		const tui = new TUI(term);
		const chat = new TranscriptContainer();
		const code = Array.from({ length: 20 }, (_unused, i) => `const line${i} = ${i};`).join("\n");
		const title = "call model with new prompt + check box heights";
		const args = { cells: [{ language: "js", title, code }] };
		const component = new ToolExecutionComponent("eval", args, {}, undefined, tui, process.cwd());

		try {
			chat.addChild(
				new Text("Now let me verify by calling the model and checking the box heights it produces:", 0, 0),
			);
			chat.addChild(new Text("prior filler\n".repeat(8).trimEnd(), 0, 0));
			tui.addChild(chat);
			tui.start();
			await term.waitForRender();

			chat.addChild(component);
			tui.requestRender();
			await term.waitForRender();

			component.updateResult(
				{
					content: [{ type: "text", text: "" }],
					details: { cells: [{ index: 0, title, code, language: "js", output: "", status: "running" }] },
				},
				true,
			);
			tui.requestRender();
			await term.waitForRender();

			const bufferText = term
				.getScrollBuffer()
				.map(row => Bun.stripANSI(row).trimEnd())
				.join("\n");
			expect(bufferText).not.toContain("pending [1/1]");
			expect(bufferText).toContain("… 10 earlier lines");
			expect(bufferText).toContain("const line10 = 10;");
			expect(bufferText).toContain("const line19 = 19;");
		} finally {
			component.stopAnimation();
			tui.stop();
			await term.flush();
		}
	});

	it("drops partial updates on a frozen background-async block (render must not drift)", async () => {
		const term = new VirtualTerminal(120, 12);
		const tui = new TUI(term);
		const component = new ToolExecutionComponent("bash", { command: "sleep 600" }, {}, undefined, tui, process.cwd());
		// The async handoff shape from the event controller: the call's own
		// result is the background-start notice, routed with isPartial=true
		// (isBackgroundRunning) and async.state="running" — the accepted-freeze.
		component.updateResult(
			{
				content: [{ type: "text", text: "Background job bg_9 started: sleep 600" }],
				details: { timeoutSeconds: 1800, async: { state: "running", jobId: "bg_9", type: "bash" } },
			},
			true,
		);
		expect(component.isTranscriptBlockFinalized()).toBe(true);
		const frozen = component.render(100).slice();

		// Background output ticks arrive as partial updates; a frozen block
		// must ignore them — its rows may already be in native scrollback.
		component.updateResult(
			{
				content: [{ type: "text", text: "tick-1\ntick-2\ntick-3" }],
				details: { timeoutSeconds: 1800, async: { state: "running", jobId: "bg_9", type: "bash" } },
			},
			true,
		);
		expect(component.render(100)).toEqual(frozen);
		expect(component.isTranscriptBlockFinalized()).toBe(true);

		// The completion is a real late result (non-partial): it may rewrite
		// the block once — the engine's accepted late-result repaint.
		component.updateResult(
			{
				content: [{ type: "text", text: "done output" }],
				details: { timeoutSeconds: 1800, async: { state: "completed", jobId: "bg_9", type: "bash" } },
			},
			false,
		);
		expect(component.render(100).join("\n")).toContain("done output");
		component.stopAnimation();
	});

	it("never resprays native scrollback from background-bash progress ticks", async () => {
		if (process.platform === "win32") return;

		// Field shape (2026-06-11 report): an async bash job ticking output while
		// the assistant streams below it. Pre-fix, every tick mutated the frozen
		// box, tripped the committed-prefix audit, and recommitted [box, thinking]
		// into the tape — one near-identical copy per tick.
		const term = new VirtualTerminal(120, 12);
		const tui = new TUI(term);
		const chat = new TranscriptContainer();
		const component = new ToolExecutionComponent(
			"bash",
			{ command: "bun install --frozen-lockfile" },
			{},
			undefined,
			tui,
			process.cwd(),
		);
		const thinking = new MutableLiveBlock(["thinking-0"]);

		try {
			chat.addChild(new Text("prior filler", 0, 0));
			tui.addChild(chat);
			tui.start();
			await term.waitForRender();

			chat.addChild(component);
			tui.requestRender();
			await term.waitForRender();

			component.updateResult(
				{
					content: [{ type: "text", text: "Background job bg_5 started: bun install --frozen-lockfile" }],
					details: { timeoutSeconds: 1800, async: { state: "running", jobId: "bg_5", type: "bash" } },
				},
				true,
			);
			chat.addChild(thinking);
			tui.requestRender();
			await term.waitForRender();

			// Shifting 10-row tail window (every visible row changes per tick)
			// while the live block below grows one row per tick.
			for (let tick = 1; tick <= 8; tick++) {
				const tail = Array.from({ length: 10 }, (_unused, i) => `compile-tick-${tick + i}`).join("\n");
				component.updateResult(
					{
						content: [{ type: "text", text: tail }],
						details: { timeoutSeconds: 1800, async: { state: "running", jobId: "bg_5", type: "bash" } },
					},
					true,
				);
				thinking.setLines(Array.from({ length: tick + 1 }, (_unused, i) => `thinking-${i}`));
				tui.requestRender();
				await term.waitForRender();
			}

			const tape = term.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
			const tapeText = tape.join("\n");
			const rowsContaining = (needle: string) => tape.filter(row => row.includes(needle)).length;

			// The frozen start notice reached history exactly once.
			expect(rowsContaining("Background job bg_5 started")).toBe(1);
			// No progress tick ever entered the tape: the frozen render never drifted.
			expect(tapeText).not.toContain("compile-tick-");
			// Nothing below the box was resprayed: each thinking row appears once.
			expect(rowsContaining("thinking-0")).toBe(1);
			expect(rowsContaining("thinking-3")).toBe(1);
		} finally {
			component.stopAnimation();
			tui.stop();
			await term.flush();
		}
	});

	it("scroll-appends a tall expanded streaming write into native scrollback mid-stream", async () => {
		if (process.platform === "win32") return;

		// Regression for "streaming previews replace instead of appending": a
		// tall expanded write preview must reach pane history WHILE args are
		// still streaming — not only after the result lands. Two ingredients:
		// the commit classifier tolerating streaming-edge jitter, and the
		// renderer keeping the animated glyph out of the block's head row.
		const term = new VirtualTerminal(120, 12);
		const tui = new TUI(term);
		const chat = new TranscriptContainer();
		const fullContent = Array.from({ length: 60 }, (_unused, i) => `const streamed_line_${i} = ${i};`).join("\n");
		const component = new ToolExecutionComponent(
			"write",
			{ file_path: "packages/coding-agent/test/probe.ts", content: "" },
			{},
			undefined,
			tui,
			process.cwd(),
		);
		component.setExpanded(true);

		try {
			chat.addChild(new Text("prior filler", 0, 0));
			tui.addChild(chat);
			tui.start();
			await term.waitForRender();

			chat.addChild(component);
			tui.requestRender();
			await term.waitForRender();

			const chunk = Math.ceil(fullContent.length / 12);
			for (let off = chunk; off < fullContent.length; off += chunk) {
				component.updateArgs({
					file_path: "packages/coding-agent/test/probe.ts",
					content: fullContent.slice(0, off),
				});
				tui.requestRender();
				await term.waitForRender();
			}

			// Still streaming: no result, args incomplete. The head of the
			// preview must already be in the buffer (committed above the
			// window), not cut off — and the viewport itself only shows the
			// streaming tail.
			const rows = term.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
			const bufferText = rows.join("\n");
			expect(bufferText).toContain("const streamed_line_0 = 0;");
			expect(bufferText).toContain("const streamed_line_30 = 30;");
			expect(rows.length).toBeGreaterThan(term.rows);
			const viewportText = term
				.getViewport()
				.map(row => Bun.stripANSI(row).trimEnd())
				.join("\n");
			expect(viewportText).not.toContain("const streamed_line_0 = 0;");
		} finally {
			component.stopAnimation();
			tui.stop();
			await term.flush();
		}
	});

	it("repaints a finalized write whose result lands after a card was appended below it", async () => {
		if (process.platform === "win32") return;

		const term = new VirtualTerminal(120, 20);
		const tui = new TUI(term);
		const chat = new TranscriptContainer();
		const content = Array.from({ length: 5 }, (_unused, i) => `const line${i} = ${i};`).join("\n");
		const args = { file_path: "packages/coding-agent/test/probe.ts", content };
		const component = new ToolExecutionComponent("write", args, {}, undefined, tui, process.cwd());

		try {
			chat.addChild(new Text("prior filler", 0, 0));
			tui.addChild(chat);
			tui.start();
			await term.waitForRender();

			// The write streams its preview while it is the live block.
			chat.addChild(component);
			tui.requestRender();
			await term.waitForRender();

			// An out-of-band card (e.g. a TTSR rule notification) is appended below
			// the still-in-flight write. Previously this froze the write on its
			// streaming preview, so the eventual result never repainted.
			chat.addChild(new Text("⚠ Injecting rule: ts-set-map", 0, 0));
			tui.requestRender();
			await term.waitForRender();

			const beforeResult = term
				.getScrollBuffer()
				.map(row => Bun.stripANSI(row).trimEnd())
				.join("\n");
			expect(beforeResult).toContain("(streaming)");

			// The write finishes after the card is already below it.
			component.updateResult({ content: [{ type: "text", text: "" }], details: { path: args.file_path } }, false);
			tui.requestRender();
			await term.waitForRender();

			const afterResult = term
				.getScrollBuffer()
				.map(row => Bun.stripANSI(row).trimEnd())
				.join("\n");
			// The streaming preview is gone and the finalized header repainted in place.
			expect(afterResult).not.toContain("(streaming)");
			expect(afterResult).toContain("· 5 lines");
		} finally {
			component.stopAnimation();
			tui.stop();
			await term.flush();
		}
	});

	it("commits the scrolled-off head of an over-tall expanded streaming write to scrollback", async () => {
		if (process.platform === "win32") return;

		const term = new VirtualTerminal(120, 20);
		const tui = new TUI(term);
		const chat = new TranscriptContainer();
		const body = (n: number) => Array.from({ length: n }, (_unused, i) => `MARK-${i}`).join("\n");
		const filePath = "packages/coding-agent/test/probe.txt";
		// Expanded (Ctrl+O) lifts the tail-window cap, so the preview renders the
		// whole content top-anchored — append-only growth as chunks stream in.
		const component = new ToolExecutionComponent(
			"write",
			{ file_path: filePath, content: body(12) },
			{},
			undefined,
			tui,
			process.cwd(),
		);
		component.setExpanded(true);

		try {
			chat.addChild(component);
			tui.addChild(chat);
			tui.start();
			await term.waitForRender();

			for (const lineCount of [24, 40]) {
				component.updateArgs({ file_path: filePath, content: body(lineCount) });
				tui.requestRender();
				await term.waitForRender();
			}

			const scrollText = stripRows(term.getScrollBuffer());
			const viewportText = stripRows(term.getViewport());

			// MARK-0 scrolled above the viewport: it must live in native scrollback
			// (committed), not nowhere. Before the fix the tool block was not
			// append-only, so its scrolled-off head was dropped — a yanked stream.
			expect(viewportText).not.toContain("MARK-0");
			expect(scrollText).toContain("MARK-0");
			// The streaming tail stays on screen, and nothing went missing between.
			expect(viewportText).toContain("MARK-39");
			expect(viewportText).toContain("(streaming)");
			expect(scrollText).toContain("MARK-20");
		} finally {
			component.stopAnimation();
			tui.stop();
			await term.flush();
		}
	});

	it("commits the scrolled-off head of an over-tall pending eval cell to scrollback", async () => {
		if (process.platform === "win32") return;

		// The single-spawn task renderer bounds its pending preview (the old
		// uncapped multi-task `context` field is gone), so the eval tool —
		// whose pending code preview is intentionally never capped — now
		// carries the over-tall pending content.
		const term = new VirtualTerminal(120, 12);
		const tui = new TUI(term);
		const chat = new TranscriptContainer();
		const code = (n: number) => Array.from({ length: n }, (_unused, i) => `// - CTX-${i}`).join("\n");
		const args = (n: number) => ({
			cells: [{ language: "js", title: "probe", code: code(n) }],
		});
		const component = new ToolExecutionComponent("eval", args(4), {}, undefined, tui, process.cwd());

		try {
			chat.addChild(component);
			tui.addChild(chat);
			tui.start();
			await term.waitForRender();

			for (const lineCount of [12, 24, 40]) {
				component.updateArgs(args(lineCount));
				tui.requestRender();
				await term.waitForRender();
			}

			const scrollText = stripRows(term.getScrollBuffer());
			const viewportText = stripRows(term.getViewport());

			expect(viewportText).not.toContain("CTX-0");
			expect(scrollText).toContain("… 30 earlier lines");
			expect(scrollText).toContain("CTX-30");
			expect(viewportText).toContain("CTX-39");
		} finally {
			component.stopAnimation();
			tui.stop();
			await term.flush();
		}
	});

	it("keeps the static task assignment reachable in scrollback while progress ticks below it", async () => {
		if (process.platform === "win32") return;

		const term = new VirtualTerminal(120, 12);
		const tui = new TUI(term);
		const chat = new TranscriptContainer();
		const assignment = Array.from({ length: 40 }, (_unused, i) => `- CTX-${i}`).join("\n");
		const args = { agent: "explore", id: "alpha", description: "probe", assignment };
		const component = new ToolExecutionComponent("task", args, {}, undefined, tui, process.cwd());
		// The multi-line assignment section only renders expanded; shimmer
		// would repaint the status line above it every frame, capping the
		// stable prefix above the assignment, so pin it off for the run.
		component.setExpanded(true);
		settings.override("display.shimmer", "disabled");
		const progressAt = (tick: number) => ({
			index: 0,
			id: "alpha",
			agent: "explore",
			agentSource: "bundled" as const,
			status: "running" as const,
			task: assignment,
			description: "probe",
			currentTool: "read",
			currentToolArgs: `probe-step-${tick}`,
			recentTools: [],
			recentOutput: [],
			toolCount: 5,
			requests: 0,
			tokens: 0,
			cost: 0,
			durationMs: 1000,
		});
		const partial = (tick: number) =>
			component.updateResult(
				{
					content: [{ type: "text", text: "" }],
					details: {
						projectAgentsDir: null,
						results: [],
						totalDurationMs: 0,
						progress: [progressAt(tick)],
					},
				},
				true,
			);

		try {
			chat.addChild(component);
			tui.addChild(chat);
			tui.start();
			await term.waitForRender();

			// A running task rewrites its current-tool line (the ticking tail)
			// below the static assignment section for the whole run. The
			// assignment head that scrolled above the viewport must still reach
			// native scrollback — previously the ticking tail suspended commits
			// for the entire block, leaving the assignment neither in history
			// nor on screen. Two full promotion windows: the call→result
			// transition frame poisons the first window's minimum, the second
			// promotes the head.
			for (let i = 1; i <= 70; i++) {
				partial(i);
				tui.requestRender();
				await term.waitForRender();
			}

			const scrollText = stripRows(term.getScrollBuffer());
			const viewportText = stripRows(term.getViewport());

			expect(viewportText).not.toContain("CTX-0");
			expect(scrollText).toContain("CTX-0");
			expect(scrollText).toContain("CTX-5");
		} finally {
			settings.clearOverride("display.shimmer");
			component.stopAnimation();
			tui.stop();
			await term.flush();
		}
	}, 20000);

	it("stops growing scrollback once slow-ticking rows are floored (no recommit storm)", async () => {
		if (process.platform === "win32") return;

		// The duplication-storm shape from the field: a live block whose head is
		// static context, whose tail is a slowly-ticking agent tree plus a
		// spinner, with finalized content (IRC cards) piled below it. The pile
		// pushes the ticker rows above the window top, so any over-promotion
		// commits them; every later tick would then make the engine audit
		// recommit — native scrollback gains a stale snapshot of the tree per
		// tick for the entire run. With the rewrite floor the ratchet converges
		// after the first promoted-row re-tick and scrollback stops growing.
		const term = new VirtualTerminal(80, 10);
		const tui = new TUI(term);
		const chat = new TranscriptContainer();
		const head = markerLines("CTX-", 20);
		const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"];
		let frameSeq = 0;
		const liveLines = (a: number, b: number) => [
			...head,
			`agent-one · ${a} tools`,
			`agent-two · ${b} tools`,
			`${spinner[frameSeq % spinner.length]} running`,
		];
		const block = new MutableLiveBlock(liveLines(0, 0));
		chat.addChild(block);
		chat.addChild(new MutableLiveBlock(markerLines("IRC-", 15), true));

		const counters: [number, number] = [0, 0];
		const renderFrames = async (frames: number) => {
			for (let i = 0; i < frames; i++) {
				frameSeq++;
				block.setLines(liveLines(...counters));
				tui.requestRender();
				await term.waitForRender();
			}
		};
		const tick = async (which: 0 | 1, frames: number) => {
			counters[which] += 1;
			await renderFrames(frames);
		};

		try {
			tui.addChild(chat);
			tui.start();
			await term.waitForRender();

			// Overshoot: a quiet stretch longer than the promotion window lets
			// the ratchet promote (and the engine commit) the ticker rows.
			await renderFrames(35);
			// First post-promotion tick of the topmost ticker arms the floor.
			await tick(0, 35);
			const settled = stripRows(term.getScrollBuffer());

			// Further slow ticks must not grow native scrollback at all.
			await tick(1, 12);
			await tick(0, 12);
			await tick(1, 12);
			expect(stripRows(term.getScrollBuffer())).toBe(settled);

			// The static head still reached scrollback. The ticker rows sit in
			// the hidden gap between the commit boundary and the window top
			// (the accepted cost while finalized content is piled below a live
			// block) — but history holds exactly one stale snapshot of them
			// instead of one per tick.
			expect(settled).toContain("CTX-0");
			const staleSnapshots = settled.split("\n").filter(row => row.startsWith("agent-one ·")).length;
			expect(staleSnapshots).toBeLessThanOrEqual(2);
		} finally {
			tui.stop();
			await term.flush();
		}
	}, 30000);

	it("commits the scrolled-off head of a tall finalized bottom tool result", async () => {
		if (process.platform === "win32") return;

		const term = new VirtualTerminal(120, 12);
		const tui = new TUI(term);
		const chat = new TranscriptContainer();
		const content = markerLines("FINAL-", 40).join("\n");
		const args = { path: "packages/coding-agent/test/finalized.txt" };
		const component = new ToolExecutionComponent("read", args, {}, undefined, tui, process.cwd());
		component.setExpanded(true);
		component.updateResult(
			{
				content: [{ type: "text", text: content }],
				details: { displayContent: { text: content, startLine: 1 } },
			},
			false,
		);

		try {
			chat.addChild(component);
			tui.addChild(chat);
			tui.start();
			await term.waitForRender();

			const scrollText = stripRows(term.getScrollBuffer());
			const viewportText = stripRows(term.getViewport());

			expect(viewportText).not.toContain("FINAL-0");
			expect(scrollText).toContain("FINAL-0");
			expect(scrollText).toContain("FINAL-20");
			expect(viewportText).toContain("FINAL-39");
		} finally {
			component.stopAnimation();
			tui.stop();
			await term.flush();
		}
	});

	it("allows a re-layouting live block's durable head to reach scrollback once promoted", async () => {
		if (process.platform === "win32") return;

		const term = new VirtualTerminal(120, 12);
		const tui = new TUI(term);
		const chat = new TranscriptContainer();
		const block = new MutableLiveBlock(markerLines("OLD-", 8));

		try {
			chat.addChild(block);
			tui.addChild(chat);
			tui.start();
			await term.waitForRender();

			block.setLines(markerLines("NEW-", 40));
			tui.requestRender();
			await term.waitForRender();

			const scrollText = stripRows(term.getScrollBuffer());
			const viewportText = stripRows(term.getViewport());

			expect(viewportText).not.toContain("NEW-0");
			expect(scrollText).toContain("NEW-0");
			expect(scrollText).toContain("NEW-20");
			expect(viewportText).toContain("NEW-39");
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("commits the scrolled-off head of an expanded eval whose output streams past the viewport", async () => {
		if (process.platform === "win32") return;

		const term = new VirtualTerminal(120, 12);
		const tui = new TUI(term);
		const chat = new TranscriptContainer();
		const title = "stream lots of output";
		const code = "for (let i = 0; i < 40; i++) console.log('MARK-' + i);";
		const args = { cells: [{ language: "js", title, code }] };
		const component = new ToolExecutionComponent("eval", args, {}, undefined, tui, process.cwd());
		component.setExpanded(true);
		const out = (n: number) => Array.from({ length: n }, (_unused, i) => `MARK-${i}`).join("\n");
		const partial = (output: string) =>
			component.updateResult(
				{
					content: [{ type: "text", text: "" }],
					details: { cells: [{ index: 0, title, code, language: "js", output, status: "running" }] },
				},
				true,
			);

		partial(out(4));

		try {
			chat.addChild(component);
			tui.addChild(chat);
			tui.start();
			await term.waitForRender();

			for (const lineCount of [12, 24, 40]) {
				partial(out(lineCount));
				tui.requestRender();
				await term.waitForRender();
			}

			const scrollText = stripRows(term.getScrollBuffer());
			const viewportText = stripRows(term.getViewport());

			// The streamed output head scrolled above the viewport: it must live in
			// native scrollback (committed), not nowhere. The fixed code cell rides
			// along as the stable prefix above it.
			expect(viewportText).not.toContain("MARK-0");
			expect(scrollText).toContain("MARK-0");
			expect(scrollText).toContain("MARK-20");
			// The streaming tail stays on screen, and nothing went missing between.
			expect(viewportText).toContain("MARK-39");
		} finally {
			component.stopAnimation();
			tui.stop();
			await term.flush();
		}
	});
});

function makeAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function makeThinkingMessage(thinking: string): AssistantMessage {
	const message = makeAssistantMessage("");
	message.content = [{ type: "thinking", thinking }];
	return message;
}

describe("assistant live-region scrollback", () => {
	beforeAll(async () => {
		await initTheme();
		await Settings.init({ inMemory: true, cwd: process.cwd() });
	});

	it("commits a streamed reply's scrolled-off head to scrollback instead of dropping it", async () => {
		if (process.platform === "win32") return;

		const term = new VirtualTerminal(120, 12);
		const tui = new TUI(term);
		const chat = new TranscriptContainer();
		// A streaming assistant reply, mid-stream (no message in the ctor → live).
		// A markdown list yields one stable row per item, so growth is append-only.
		const component = new AssistantMessageComponent(undefined, false);
		const markers = Array.from({ length: 40 }, (_unused, i) => `- MARK-${i}`);

		try {
			chat.addChild(component);
			tui.addChild(chat);
			tui.start();
			await term.waitForRender();

			component.updateContent(makeAssistantMessage(markers.slice(0, 4).join("\n")));
			tui.requestRender();
			await term.waitForRender();

			for (const lineCount of [12, 24, 40]) {
				component.updateContent(makeAssistantMessage(markers.slice(0, lineCount).join("\n")));
				tui.requestRender();
				await term.waitForRender();
			}

			const scrollText = stripRows(term.getScrollBuffer());
			const viewportText = stripRows(term.getViewport());

			// MARK-0 scrolled above the viewport: with the fix it lives in native
			// scrollback (committed), not nowhere. The regression dropped it.
			expect(viewportText).not.toContain("MARK-0");
			expect(scrollText).toContain("MARK-0");
			// The tail is still on screen, and nothing went missing in between.
			expect(viewportText).toContain("MARK-39");
			expect(scrollText).toContain("MARK-20");
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("commits scrolled-off styled thinking paragraphs to scrollback while streaming", async () => {
		if (process.platform === "win32") return;

		const term = new VirtualTerminal(120, 12);
		const tui = new TUI(term);
		const chat = new TranscriptContainer();
		const component = new AssistantMessageComponent(undefined, false);
		// Word-wrapped italic/colored paragraphs — the styled streaming shape the
		// raw-byte append detector mis-classified as volatile (the span-closing
		// SGR moves rows as the paragraph wraps), which froze the commit boundary
		// and dropped every later paragraph that scrolled past the viewport top.
		const paragraphs = Array.from(
			{ length: 8 },
			(_unused, i) =>
				`PARA-${i} considering the resolver path and the descriptor defaults, the policy layer must keep the ` +
				`reasoning flag intact while discovery maps an unknown model entry onto the bundled reference shape ` +
				`so the runtime request stays correct across upstream metadata shifts.`,
		);
		const fullText = paragraphs.join("\n\n");
		const words = fullText.split(" ");

		try {
			chat.addChild(component);
			tui.addChild(chat);
			tui.start();
			await term.waitForRender();

			// Stream a few words per frame so the in-flight bottom line extends,
			// wraps, and sheds words onto new rows across many coalesced frames.
			for (let i = 5; i <= words.length; i += 5) {
				component.updateContent(makeThinkingMessage(words.slice(0, i).join(" ")));
				tui.requestRender();
				await term.waitForRender();
			}

			const scrollText = stripRows(term.getScrollBuffer());
			const viewportText = stripRows(term.getViewport());

			// Early paragraphs scrolled above the viewport: they must live in
			// native scrollback, not vanish into the dropped gap.
			expect(viewportText).not.toContain("PARA-0");
			expect(scrollText).toContain("PARA-0");
			expect(scrollText).toContain("PARA-4");
			// The tail is still on screen.
			expect(viewportText).toContain("PARA-7");
		} finally {
			tui.stop();
			await term.flush();
		}
	});
});
