import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { AgentStorage, SCHEMA_VERSION } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

const LEGACY_TIMESTAMP = 1_700_000_000;
/** meta marker upstream sets once stats.db history has been imported into model_perf. */
const MODEL_PERF_BACKFILL_KEY = "model_perf_backfill";

function readSchemaVersion(dbPath: string): number | null {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").get() as
			| { version?: number }
			| undefined;
		return typeof row?.version === "number" ? row.version : null;
	} finally {
		db.close();
	}
}

function readSettingsRows(dbPath: string): Array<{ key: string; value: string; updated_at: number }> {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db.prepare("SELECT key, value, updated_at FROM settings ORDER BY key ASC").all() as Array<{
			key: string;
			value: string;
			updated_at: number;
		}>;
	} finally {
		db.close();
	}
}

/** Observable schema metadata: is a table present in the database? */
function tableExists(dbPath: string, tableName: string): boolean {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) != null;
	} finally {
		db.close();
	}
}

function readMetaValue(dbPath: string, key: string): string | null {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value?: string } | undefined;
		return row?.value ?? null;
	} finally {
		db.close();
	}
}

/**
 * Behaviorally verifies a timestamp column's default: inserts a row that omits
 * the column (supplying only the other required columns) and returns the value
 * SQLite filled in. Exercises the default *expression* against the bundled
 * SQLite — a default it cannot evaluate would throw here. The probe row is
 * removed before returning so callers' data assertions stay untouched.
 */
function probeTimestampDefault(
	dbPath: string,
	table: string,
	tsColumn: string,
	provided: Record<string, string | number>,
): number {
	const db = new Database(dbPath);
	try {
		db.run("PRAGMA busy_timeout = 5000");
		const columns = Object.keys(provided);
		const values = Object.values(provided);
		const placeholders = columns.map(() => "?").join(", ");
		db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`).run(...values);
		const row = db.prepare(`SELECT ${tsColumn} AS ts FROM ${table} WHERE ${columns[0]} = ?`).get(values[0]) as
			| { ts?: number }
			| undefined;
		db.prepare(`DELETE FROM ${table} WHERE ${columns[0]} = ?`).run(values[0]);
		return typeof row?.ts === "number" ? row.ts : Number.NaN;
	} finally {
		db.close();
	}
}

/** Asserts a value is an integer unix-seconds timestamp within a few seconds of now. */
function expectRecentUnixSeconds(value: number): void {
	const nowSec = Math.floor(Date.now() / 1000);
	expect(Number.isInteger(value)).toBe(true);
	expect(value).toBeGreaterThanOrEqual(nowSec - 5);
	expect(value).toBeLessThanOrEqual(nowSec + 5);
}

describe("AgentStorage SQLite compatibility", () => {
	let tempDir: TempDir;

	afterEach(async () => {
		AgentStorage.resetInstance();
		if (tempDir) {
			try {
				await tempDir.remove();
			} catch {}
			tempDir = undefined as unknown as TempDir;
		}
	});

	it("creates fresh storage at the current schema version with working timestamp defaults", async () => {
		tempDir = TempDir.createSync("@omp-agent-storage-fresh-");
		const dbPath = path.join(tempDir.path(), "agent.db");

		const storage = await AgentStorage.open(dbPath);
		storage.recordModelUsage("openai/gpt-5");

		expect(storage.getModelUsageOrder()).toEqual(["openai/gpt-5"]);
		expect(readSchemaVersion(dbPath)).toBe(SCHEMA_VERSION);

		// Timestamp columns must carry a default the bundled SQLite can evaluate:
		// inserting a row without the timestamp must succeed and persist a sane
		// unix-seconds integer.
		expectRecentUnixSeconds(
			probeTimestampDefault(dbPath, "settings", "updated_at", { key: "__probe__", value: '"x"' }),
		);
		expectRecentUnixSeconds(
			probeTimestampDefault(dbPath, "model_usage", "last_used_at", { model_key: "__probe__/model" }),
		);
	});

	it("migrates a legacy v4 database to the current schema, preserving data and defaults", async () => {
		tempDir = TempDir.createSync("@omp-agent-storage-legacy-");
		const dbPath = path.join(tempDir.path(), "agent.db");
		const legacyDb = new Database(dbPath);
		legacyDb.exec(`
			CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
			INSERT INTO schema_version(version) VALUES (4);
			CREATE TABLE settings (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				updated_at INTEGER NOT NULL DEFAULT (unixepoch())
			);
			CREATE TABLE model_usage (
				model_key TEXT PRIMARY KEY,
				last_used_at INTEGER NOT NULL DEFAULT (unixepoch())
			);
		`);
		legacyDb
			.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
			.run("theme", '"dark"', LEGACY_TIMESTAMP);
		legacyDb
			.prepare("INSERT INTO model_usage (model_key, last_used_at) VALUES (?, ?)")
			.run("anthropic/claude-sonnet-4-5", LEGACY_TIMESTAMP);
		legacyDb.close();

		const storage = await AgentStorage.open(dbPath);

		// Legacy databases remain readable and are migrated to the merged schema.
		expect(readSchemaVersion(dbPath)).toBe(SCHEMA_VERSION);
		expect(storage.getSettings()).toEqual({ theme: "dark" });
		expect(storage.getModelUsageOrder()).toEqual(["anthropic/claude-sonnet-4-5"]);
		expect(readSettingsRows(dbPath)).toEqual([{ key: "theme", value: '"dark"', updated_at: LEGACY_TIMESTAMP }]);

		// The full v4 -> current chain provisions both feature tables and leaves
		// them usable.
		expect(tableExists(dbPath, "slash_command_usage")).toBe(true);
		expect(tableExists(dbPath, "model_perf")).toBe(true);
		expect(storage.getSlashCommandUsageOrder()).toEqual([]);
		expect(storage.getModelPerf().size).toBe(0);

		// Recreated tables carry evaluable timestamp defaults (not the legacy
		// unixepoch() default the migration replaces).
		expectRecentUnixSeconds(
			probeTimestampDefault(dbPath, "settings", "updated_at", { key: "__probe__", value: '"x"' }),
		);
		expectRecentUnixSeconds(
			probeTimestampDefault(dbPath, "model_usage", "last_used_at", { model_key: "__probe__/model" }),
		);
	});

	it("resets stale model_perf when upgrading a v5 database with pre-fix aggregates", async () => {
		tempDir = TempDir.createSync("@omp-agent-storage-v5-perf-");
		const dbPath = path.join(tempDir.path(), "agent.db");
		// An intermediate upstream build shipped model_perf at schema v5 with the
		// old post-TTFT-decode-window TPS. The v5 -> v6 step must purge those
		// aggregates and clear the backfill marker so history is re-imported
		// through the corrected fold; user data (model_usage) must survive.
		const v5Db = new Database(dbPath);
		v5Db.exec(`
			CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
			INSERT INTO schema_version(version) VALUES (5);
			CREATE TABLE settings (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
			);
			CREATE TABLE model_usage (
				model_key TEXT PRIMARY KEY,
				last_used_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
			);
			CREATE TABLE model_perf (
				model_key TEXT PRIMARY KEY,
				samples REAL NOT NULL DEFAULT 0,
				output_tokens REAL NOT NULL DEFAULT 0,
				gen_ms REAL NOT NULL DEFAULT 0,
				ttft_samples REAL NOT NULL DEFAULT 0,
				ttft_ms REAL NOT NULL DEFAULT 0,
				updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
			);
			CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		`);
		v5Db
			.prepare("INSERT INTO model_usage (model_key, last_used_at) VALUES (?, ?)")
			.run("anthropic/claude-sonnet-4-5", LEGACY_TIMESTAMP);
		v5Db
			.prepare(
				"INSERT INTO model_perf (model_key, samples, output_tokens, gen_ms, ttft_samples, ttft_ms, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run("anthropic/claude-sonnet-4-5", 99, 9999, 1000, 99, 5000, LEGACY_TIMESTAMP);
		v5Db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(MODEL_PERF_BACKFILL_KEY, "complete");
		v5Db.close();

		const storage = await AgentStorage.open(dbPath);

		expect(readSchemaVersion(dbPath)).toBe(SCHEMA_VERSION);
		// Stale aggregates are purged and the backfill marker is cleared.
		expect(storage.getModelPerf().size).toBe(0);
		expect(readMetaValue(dbPath, MODEL_PERF_BACKFILL_KEY)).toBeNull();
		// Targeted reset: user data is untouched and slash_command_usage arrives.
		expect(storage.getModelUsageOrder()).toEqual(["anthropic/claude-sonnet-4-5"]);
		expect(tableExists(dbPath, "slash_command_usage")).toBe(true);
		expect(storage.getSlashCommandUsageOrder()).toEqual([]);
	});

	it("upgrades an upstream v6 database, adding slash_command_usage without purging model_perf", async () => {
		tempDir = TempDir.createSync("@omp-agent-storage-upstream-v6-");
		const dbPath = path.join(tempDir.path(), "agent.db");
		// Upstream v16.5.0 shipped schema v6 with model_perf + meta but no
		// slash_command_usage. Its perf aggregates already use the corrected
		// total-duration TPS, so the merge must NOT discard them.
		const upstreamDb = new Database(dbPath);
		upstreamDb.exec(`
			CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
			INSERT INTO schema_version(version) VALUES (6);
			CREATE TABLE settings (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
			);
			CREATE TABLE model_usage (
				model_key TEXT PRIMARY KEY,
				last_used_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
			);
			CREATE TABLE model_perf (
				model_key TEXT PRIMARY KEY,
				samples REAL NOT NULL DEFAULT 0,
				output_tokens REAL NOT NULL DEFAULT 0,
				gen_ms REAL NOT NULL DEFAULT 0,
				ttft_samples REAL NOT NULL DEFAULT 0,
				ttft_ms REAL NOT NULL DEFAULT 0,
				updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
			);
			CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		`);
		upstreamDb
			.prepare(
				"INSERT INTO model_perf (model_key, samples, output_tokens, gen_ms, ttft_samples, ttft_ms, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run("anthropic/claude-sonnet-4-5", 12, 6000, 30000, 12, 3600, LEGACY_TIMESTAMP);
		upstreamDb.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(MODEL_PERF_BACKFILL_KEY, "complete");
		upstreamDb.close();

		const storage = await AgentStorage.open(dbPath);

		expect(readSchemaVersion(dbPath)).toBe(SCHEMA_VERSION);

		// model_perf survives the upgrade with its aggregates intact
		// (tps = output_tokens*1000/gen_ms = 200, ttft = ttft_ms/ttft_samples = 300).
		const perf = storage.getModelPerf();
		expect(perf.get("anthropic/claude-sonnet-4-5")).toEqual({ samples: 12, tps: 200, ttftMs: 300 });
		// The backfill marker is preserved, so history is not needlessly re-imported.
		expect(readMetaValue(dbPath, MODEL_PERF_BACKFILL_KEY)).toBe("complete");

		// slash_command_usage is provisioned and usable.
		expect(tableExists(dbPath, "slash_command_usage")).toBe(true);
		expect(storage.getSlashCommandUsageOrder()).toEqual([]);
		storage.recordSlashCommandUsage("commit");
		expect(storage.getSlashCommandUsageOrder()).toEqual(["commit"]);
	});

	it("upgrades a fork v6 database, adding model_perf without dropping slash_command_usage", async () => {
		tempDir = TempDir.createSync("@omp-agent-storage-fork-v6-");
		const dbPath = path.join(tempDir.path(), "agent.db");
		// The fork shipped schema v6 with slash_command_usage but no model_perf/meta.
		const forkDb = new Database(dbPath);
		forkDb.exec(`
			CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
			INSERT INTO schema_version(version) VALUES (6);
			CREATE TABLE settings (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
			);
			CREATE TABLE model_usage (
				model_key TEXT PRIMARY KEY,
				last_used_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
			);
			CREATE TABLE slash_command_usage (
				command_name TEXT PRIMARY KEY,
				last_used_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
			);
		`);
		forkDb
			.prepare("INSERT INTO slash_command_usage (command_name, last_used_at) VALUES (?, ?)")
			.run("commit", LEGACY_TIMESTAMP);
		forkDb
			.prepare("INSERT INTO slash_command_usage (command_name, last_used_at) VALUES (?, ?)")
			.run("diff", LEGACY_TIMESTAMP + 100);
		forkDb.close();

		const storage = await AgentStorage.open(dbPath);

		expect(readSchemaVersion(dbPath)).toBe(SCHEMA_VERSION);

		// slash_command_usage rows survive, still ordered most-recent-first.
		expect(storage.getSlashCommandUsageOrder()).toEqual(["diff", "commit"]);

		// model_perf + meta are provisioned and usable.
		expect(tableExists(dbPath, "model_perf")).toBe(true);
		expect(tableExists(dbPath, "meta")).toBe(true);
		expect(storage.getModelPerf().size).toBe(0);
		await storage.recordModelPerf("openai/gpt-5", { outputTokens: 500, durationMs: 2500, ttftMs: 500 });
		const perf = storage.getModelPerf();
		expect(perf.get("openai/gpt-5")).toEqual({ samples: 1, tps: 200, ttftMs: 500 });
	});
});
