import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { Text, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

describe("tool transcript rendering", () => {
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

			const scrollText = term
				.getScrollBuffer()
				.map(row => Bun.stripANSI(row).trimEnd())
				.join("\n");
			const viewportText = term
				.getViewport()
				.map(row => Bun.stripANSI(row).trimEnd())
				.join("\n");

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
});
