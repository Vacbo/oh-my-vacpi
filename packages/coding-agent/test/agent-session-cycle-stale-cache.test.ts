/**
 * Regression: when ModelRegistry's synchronous cache load returns a model whose
 * `thinking.levels` is stale (e.g. an older binary wrote `maxLevel: "xhigh"`
 * before `Effort.Max` existed), the session model pinned at startup must be
 * re-enriched against current inference rules so Shift+Tab can cycle into Max.
 *
 * Pre-fix symptom: Ctrl+L (model selector) showed Max because it awaited
 * `modelRegistry.refresh('offline')` which routed through `createModelManager`
 * (and the fixed `resolveProviderModels`), but `agent-session.cycleThinkingLevel`
 * read `this.model.thinking.levels` from the constructor-time cache load,
 * which bypassed refresh and surfaced the stale ladder.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Effort, type Model, writeModelCache } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("ModelRegistry refreshes stale cached thinking on synchronous startup load", () => {
	let tempDir: TempDir;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-cycle-stale-cache-");
	});

	afterEach(async () => {
		for (const authStorage of authStorages.splice(0)) {
			authStorage.close();
		}
		tempDir.removeSync();
	});

	it("re-infers thinking metadata for Opus 4.6 cached with the old xhigh ladder", async () => {
		// Simulate the SQLite row written by an older binary that capped Opus 4.6 at xhigh.
		const stale: Model<"anthropic-messages"> = {
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
			thinking: {
				mode: "anthropic-adaptive",
				minLevel: Effort.Minimal,
				maxLevel: Effort.XHigh,
			},
		};

		const cacheDbPath = path.join(tempDir.path(), "models.db");
		writeModelCache("anthropic", Date.now(), [stale], true, "fp-old", cacheDbPath);

		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		// The ModelRegistry constructor synchronously calls `#loadModels()` which reads
		// the cache row. After the fix, that path runs `refreshModelThinking` before
		// the model lands in `getAvailable()`.
		const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const available = registry.getAvailable();
		const opus = available.find(m => m.id === "claude-opus-4-6" && m.provider === "anthropic");

		expect(opus).toBeDefined();
		expect(opus?.thinking?.maxLevel).toBe(Effort.Max);
		expect(opus?.thinking?.levels).toEqual([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.Max]);
	});
});
