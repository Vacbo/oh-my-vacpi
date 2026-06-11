/**
 * Compaction error types.
 *
 * `CompactionCancelledError` is the canonical signal raised when a compaction
 * is explicitly aborted — operator Esc, extension hook returning `cancel`,
 * programmatic `session.abortCompaction()` call, or any other deliberate
 * abort source. Downstream callers (e.g. `executeCompaction`) discriminate
 * cancellation from other failures via `instanceof CompactionCancelledError`
 * rather than introspecting error messages or `name` fields — the typed
 * sentinel makes classification source-agnostic and refactor-stable.
 */

export class CompactionCancelledError extends Error {
	readonly name = "CompactionCancelledError" as const;

	constructor(message = "Compaction cancelled") {
		super(message);
	}
}

/**
 * Raised when a compaction request finds nothing to summarize — the branch is
 * below the minimum size or already ends in a compaction entry. This is a
 * benign no-op, not a failure: callers that compact opportunistically (idle
 * compaction racing a manual request, plan approval's "compact context"
 * branch) discriminate it via `instanceof` and proceed without surfacing an
 * error.
 */
export class NothingToCompactError extends Error {
	readonly name = "NothingToCompactError" as const;

	constructor(message = "Nothing to compact") {
		super(message);
	}
}

/**
 * Outcome of a compaction attempt, surfaced by `CommandController.executeCompaction`
 * so callers (e.g. the plan-mode approval flow) can distinguish a deliberate abort
 * from an unrelated failure.
 *
 *   "ok"        — compaction completed; transcript was summarized.
 *   "cancelled" — `CompactionCancelledError` was raised. Operator Esc, extension
 *                 hook, programmatic abort — all source-agnostic.
 *   "failed"    — any other rejection from `session.compact()`.
 */
export type CompactionOutcome = "ok" | "cancelled" | "failed";
