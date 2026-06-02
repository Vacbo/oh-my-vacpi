import { Snowflake } from "@oh-my-pi/pi-utils";
import type { TerminalSnapshot } from "./terminal-snapshot";

/**
 * Process-local ring of recent interactive (pty) bash terminal snapshots.
 *
 * When the agent launches an interactive program through `bash` with `pty: true`
 * (e.g. a child `omp` build), its final TUI state is captured here so the model
 * can inspect it afterwards via the `tui_observe` tool's `bash_snapshots` action.
 */

export interface BashTuiSnapshotRecord {
	id: string;
	command: string;
	cwd: string;
	exitCode?: number;
	cancelled: boolean;
	timedOut: boolean;
	capturedAt: string;
	snapshot: TerminalSnapshot;
}

export interface RecordBashTuiSnapshotInput {
	command: string;
	cwd: string;
	exitCode?: number;
	cancelled?: boolean;
	timedOut?: boolean;
	snapshot: TerminalSnapshot;
}

const MAX_RECORDS = 20;
const records: BashTuiSnapshotRecord[] = [];

export function recordBashTuiSnapshot(input: RecordBashTuiSnapshotInput): BashTuiSnapshotRecord {
	const record: BashTuiSnapshotRecord = {
		id: `bash-${Snowflake.next()}`,
		command: input.command,
		cwd: input.cwd,
		exitCode: input.exitCode,
		cancelled: input.cancelled ?? false,
		timedOut: input.timedOut ?? false,
		capturedAt: input.snapshot.capturedAt,
		snapshot: input.snapshot,
	};
	records.push(record);
	if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
	return record;
}

/** Recent snapshots, newest first. */
export function listBashTuiSnapshots(): BashTuiSnapshotRecord[] {
	return [...records].reverse();
}

export function getBashTuiSnapshot(id: string): BashTuiSnapshotRecord | undefined {
	return records.find(record => record.id === id);
}

export function clearBashTuiSnapshots(): void {
	records.length = 0;
}
