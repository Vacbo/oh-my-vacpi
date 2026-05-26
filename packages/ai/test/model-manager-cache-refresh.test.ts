/**
 * Regression test for the model-cache thinking-staleness bug.
 *
 * Background: when the static catalog (models.json) or the inference logic
 * (`inferAnthropicSupportedEfforts` etc.) changes between versions, cached
 * `model.thinking` rows from older binaries become inconsistent with current
 * code. `enrichModelThinking` preserves any pre-set thinking field, so cached
 * stale metadata would silently propagate forever. `resolveProviderModels`
 * must re-infer thinking via `refreshModelThinking` whenever it reads from
 * cache, so the freshly-installed binary surfaces the current ladder.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writeModelCache } from "../src/model-cache";
import { resolveProviderModels } from "../src/model-manager";
import { Effort, enrichModelThinking } from "../src/model-thinking";
import type { Model } from "../src/types";

function buildOpusModel(thinkingOverride: Model<"anthropic-messages">["thinking"]): Model<"anthropic-messages"> {
	const base: Model<"anthropic-messages"> = {
		id: "claude-opus-4-6",
		name: "Claude Opus 4.6",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	};
	return { ...base, thinking: thinkingOverride };
}

describe("resolveProviderModels cache refresh", () => {
	let tempDir = "";
	let dbPath = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-cache-refresh-"));
		dbPath = path.join(tempDir, "models.db");
	});

	afterEach(async () => {
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
			dbPath = "";
		}
	});

	it("re-infers thinking metadata when reading stale cached models on the fast path", async () => {
		// Simulate a row written by an older binary whose inference logic capped
		// Opus 4.6 at XHigh. The current code produces [..., Max].
		const staleCached = buildOpusModel({
			mode: "anthropic-adaptive",
			minLevel: Effort.Minimal,
			maxLevel: Effort.XHigh,
		});
		// The static catalog shipped in the new binary mirrors the same model
		// definition (so the fingerprint matches and the fast path engages),
		// but lets `inferAnthropicSupportedEfforts` re-derive the ladder.
		const freshStatic = enrichModelThinking(buildOpusModel(undefined));
		writeModelCache("anthropic-fixture", Date.now(), [staleCached], true, "fp-fixture", dbPath);

		const { models } = await resolveProviderModels<"anthropic-messages">(
			{
				providerId: "anthropic-fixture" as Model<"anthropic-messages">["provider"],
				cacheDbPath: dbPath,
				staticModels: [freshStatic],
			},
			"offline",
		);

		const opus = models.find(model => model.id === "claude-opus-4-6");
		expect(opus?.thinking?.maxLevel).toBe(Effort.Max);
		expect(opus?.thinking?.levels).toEqual([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.Max]);
	});

	it("re-infers thinking metadata when merging stale cached models on the slow path", async () => {
		// Force the slow path by using a static catalog whose fingerprint will
		// not match the cache row's stored fingerprint.
		const staleCached = buildOpusModel({
			mode: "anthropic-adaptive",
			minLevel: Effort.Minimal,
			maxLevel: Effort.XHigh,
		});
		writeModelCache("anthropic-fixture", Date.now(), [staleCached], true, "fp-stale", dbPath);

		const freshStatic = enrichModelThinking(buildOpusModel(undefined));
		const { models } = await resolveProviderModels<"anthropic-messages">(
			{
				providerId: "anthropic-fixture" as Model<"anthropic-messages">["provider"],
				cacheDbPath: dbPath,
				staticModels: [freshStatic],
			},
			"offline",
		);

		const opus = models.find(model => model.id === "claude-opus-4-6");
		expect(opus?.thinking?.maxLevel).toBe(Effort.Max);
	});
});
