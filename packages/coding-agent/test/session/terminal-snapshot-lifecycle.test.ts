import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readTerminalSnapshot, TerminalSnapshotRecorder } from "@oh-my-pi/pi-coding-agent/session/terminal-snapshot";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

async function makeSnapshotPath(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-terminal-snapshot-"));
	tempDirs.push(dir);
	return path.join(dir, "terminal.json");
}

/** Drain the promise (microtask) queue without touching the wall clock. */
async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("terminal snapshot recorder teardown", () => {
	it("persists queued terminal output that has not yet drained when finalized", async () => {
		const snapshotPath = await makeSnapshotPath();
		const recorder = new TerminalSnapshotRecorder({ path: snapshotPath, cols: 40, rows: 6 });
		// Do not await flush: the write sits in the recorder's queue because
		// xterm.write drains on a later tick. A bare persist() would snapshot an
		// empty terminal — flushAndPersist must drain the queue first.
		recorder.write("queued-final-output");
		await recorder.flushAndPersist();
		recorder.dispose();

		const persisted = await readTerminalSnapshot(snapshotPath);
		expect(persisted?.text).toContain("queued-final-output");
	});

	it("serializes persists so a stale in-flight snapshot cannot overwrite the final one", async () => {
		const snapshotPath = await makeSnapshotPath();
		const recorder = new TerminalSnapshotRecorder({ path: snapshotPath, cols: 40, rows: 6 });
		const writes: Array<{ payload: string; resolve: () => void }> = [];
		const writeSpy = spyOn(Bun, "write").mockImplementation(((_dest: unknown, payload: unknown) => {
			const { promise, resolve } = Promise.withResolvers<void>();
			writes.push({ payload: String(payload), resolve });
			return promise.then(() => String(payload).length);
		}) as unknown as typeof Bun.write);

		try {
			recorder.write("STALE");
			await recorder.flush();
			// A scheduled persist is just a persist() call — simulate one in-flight
			// that captured the stale terminal state and is still writing.
			const inflight = recorder.persist();
			await flushMicrotasks();
			expect(writes).toHaveLength(1);
			expect(writes[0]!.payload).toContain("STALE");
			expect(writes[0]!.payload).not.toContain("FRESH");

			recorder.write("FRESH");
			await recorder.flush();
			// The final teardown persist must chain behind the blocked in-flight
			// write; it cannot be issued until that resolves.
			const final = recorder.flushAndPersist();
			await flushMicrotasks();
			expect(writes).toHaveLength(1);

			writes[0]!.resolve();
			await inflight;
			await flushMicrotasks();
			// Only now is the final write issued — last, and with the fresh state,
			// so the stale in-flight snapshot never wins.
			expect(writes).toHaveLength(2);
			expect(writes[1]!.payload).toContain("FRESH");

			writes[1]!.resolve();
			await final;
		} finally {
			writeSpy.mockRestore();
			recorder.dispose();
		}
	});

	it("cancels a pending scheduled persist when finalizing so it cannot overwrite the final snapshot", async () => {
		vi.useFakeTimers();
		const snapshotPath = await makeSnapshotPath();
		const recorder = new TerminalSnapshotRecorder({ path: snapshotPath, cols: 40, rows: 6 });
		const writeSpy = spyOn(Bun, "write").mockImplementation((() =>
			Promise.resolve(0)) as unknown as typeof Bun.write);
		try {
			// resize() arms the debounced persist timer without any xterm write, so
			// only the fake clock (not xterm's async parser) is in play here.
			recorder.resize(80, 10);
			await recorder.flushAndPersist();
			expect(writeSpy).toHaveBeenCalledTimes(1);
			// The scheduled timer must have been cancelled; advancing past its delay
			// fires nothing, so no stale scheduled persist lands after the final one.
			vi.advanceTimersByTime(100);
			expect(writeSpy).toHaveBeenCalledTimes(1);
		} finally {
			writeSpy.mockRestore();
			recorder.dispose();
			vi.useRealTimers();
		}
	});

	it("tracks dimensions beyond the legacy 240x200 cap so snapshots match wide terminals", () => {
		const recorder = new TerminalSnapshotRecorder({ path: "", cols: 400, rows: 300 });
		let snapshot = recorder.snapshot();
		expect(snapshot.cols).toBe(400);
		expect(snapshot.rows).toBe(300);

		recorder.resize(512, 220);
		snapshot = recorder.snapshot();
		expect(snapshot.cols).toBe(512);
		expect(snapshot.rows).toBe(220);
		recorder.dispose();
	});
});
