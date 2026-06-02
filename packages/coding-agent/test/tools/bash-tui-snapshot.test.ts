import { afterEach, describe, expect, it } from "bun:test";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import {
	clearBashTuiSnapshots,
	getBashTuiSnapshot,
	listBashTuiSnapshots,
	recordBashTuiSnapshot,
} from "@oh-my-pi/pi-coding-agent/session/bash-tui-snapshots";
import {
	createTerminalSnapshotFromText,
	type TerminalSnapshot,
} from "@oh-my-pi/pi-coding-agent/session/terminal-snapshot";
import { TuiObserveTool } from "@oh-my-pi/pi-coding-agent/tools/tui-observe";

afterEach(() => {
	clearBashTuiSnapshots();
});

async function snapshotFromText(text: string): Promise<TerminalSnapshot> {
	return await createTerminalSnapshotFromText(text, { cols: 40, rows: 6 });
}

function fakeSession(): ToolSession {
	return { cwd: "/tmp", settings: { get: () => undefined } } as unknown as ToolSession;
}

function firstText(content: Array<{ type: string; text?: string }>): string {
	const text = content.find(part => part.type === "text")?.text;
	if (!text) throw new Error("no text content");
	return text;
}

describe("bash TUI snapshot ring", () => {
	it("records snapshots newest-first and bounds the ring", async () => {
		const snapshot = await snapshotFromText("hello");
		const first = recordBashTuiSnapshot({ command: "omp --help", cwd: "/repo", exitCode: 0, snapshot });
		const second = recordBashTuiSnapshot({ command: "omp doctor", cwd: "/repo", exitCode: 1, snapshot });

		const listed = listBashTuiSnapshots();
		expect(listed[0]?.id).toBe(second.id);
		expect(listed[1]?.id).toBe(first.id);
		expect(getBashTuiSnapshot(first.id)?.command).toBe("omp --help");

		for (let i = 0; i < 25; i++) {
			recordBashTuiSnapshot({ command: `cmd-${i}`, cwd: "/repo", snapshot });
		}
		const bounded = listBashTuiSnapshots();
		expect(bounded.length).toBe(20);
		expect(bounded[0]?.command).toBe("cmd-24");
		expect(getBashTuiSnapshot(first.id)).toBeUndefined();
	});

	it("exposes recorded snapshots through tui_observe bash_snapshots", async () => {
		const snapshot = await snapshotFromText("child omp ready");
		const record = recordBashTuiSnapshot({ command: "omp", cwd: "/repo", exitCode: 0, snapshot });
		const tool = new TuiObserveTool(fakeSession());

		const listResult = await tool.execute("c1", { action: "bash_snapshots" });
		const listed = JSON.parse(firstText(listResult.content)) as {
			snapshots: Array<{ id: string; command: string; preview: string }>;
		};
		expect(listed.snapshots[0]?.id).toBe(record.id);
		expect(listed.snapshots[0]?.preview).toContain("child omp ready");

		const oneResult = await tool.execute("c2", { action: "bash_snapshots", run: record.id });
		const one = JSON.parse(firstText(oneResult.content)) as { id: string; text: string };
		expect(one.id).toBe(record.id);
		expect(one.text).toContain("child omp ready");
	});
});
