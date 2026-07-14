import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { TerminalSnapshotRecorder } from "@oh-my-pi/pi-coding-agent/session/terminal-snapshot";
import {
	BashInteractiveOverlayComponent,
	overlayPtyDimensions,
} from "@oh-my-pi/pi-coding-agent/tools/bash-interactive";
import type { PtySession } from "@oh-my-pi/pi-natives";
import xterm from "@xterm/headless";

/** Fake PTY recording the dimensions each overlay resize forwards to it. */
class RecordingPtySession {
	readonly resizes: Array<{ cols: number; rows: number }> = [];
	resize(cols: number, rows: number): void {
		this.resizes.push({ cols, rows });
	}
}

describe("interactive bash overlay snapshot dimensions", () => {
	beforeAll(async () => {
		await initTheme();
		await Settings.init({ inMemory: true, cwd: process.cwd() });
	});

	it("keeps the PTY and snapshot recorder at identical effective dimensions across resizes", async () => {
		let terminalRows = 40;
		const component = new BashInteractiveOverlayComponent("cat wide.txt", theme, () => terminalRows, xterm.Terminal);
		const pty = new RecordingPtySession();
		component.setSession(pty as unknown as PtySession);
		// Deliberately construct the recorder at the wrong size: only the resize
		// callback (the regression fix) can bring it in line with the live PTY.
		const recorder = new TerminalSnapshotRecorder({ path: "", cols: 1, rows: 1 });
		component.setOnResize((cols, rows) => {
			recorder.resize(cols, rows);
		});

		// Initial render at 40 rows / width 100.
		component.render(100);
		const initial = overlayPtyDimensions(100, terminalRows);
		expect(pty.resizes.at(-1)).toEqual(initial);

		// Feed a line far wider than the overlay so wrapping is observable at the
		// recorder's effective width.
		recorder.write("x".repeat(300));
		await recorder.flush();
		let snapshot = recorder.snapshot();
		expect({ cols: snapshot.cols, rows: snapshot.rows }).toEqual(initial);
		expect(snapshot.cols).toBe(pty.resizes.at(-1)!.cols);
		expect(snapshot.rows).toBe(pty.resizes.at(-1)!.rows);
		expect(snapshot.lines.some(line => line.isWrapped)).toBe(true);

		// Subsequent resize: fewer rows, narrower terminal.
		terminalRows = 24;
		component.render(60);
		const resized = overlayPtyDimensions(60, terminalRows);
		expect(pty.resizes.at(-1)).toEqual(resized);

		await recorder.flush();
		snapshot = recorder.snapshot();
		expect({ cols: snapshot.cols, rows: snapshot.rows }).toEqual(resized);
		// PTY and recorder observed exactly the same dimensions at every resize.
		expect(snapshot.cols).toBe(pty.resizes.at(-1)!.cols);
		expect(snapshot.rows).toBe(pty.resizes.at(-1)!.rows);

		recorder.dispose();
		component.dispose();
	});

	it("derives effective dimensions as floor(rows*0.8)-4 by (width-2), uncapped", () => {
		expect(overlayPtyDimensions(100, 40)).toEqual({ cols: 98, rows: 28 });
		expect(overlayPtyDimensions(60, 24)).toEqual({ cols: 58, rows: 15 });
		// Wide terminals are not clamped to the legacy 240/200 recorder caps.
		expect(overlayPtyDimensions(400, 300)).toEqual({ cols: 398, rows: 236 });
	});
});
