import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { NothingToCompactError } from "@oh-my-pi/pi-agent-core/compaction";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession.compact with nothing to summarize", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let tempDir: TempDir | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
		await tempDir?.remove();
		tempDir = undefined;
	});

	it("rejects with the typed NothingToCompactError sentinel", async () => {
		// The UI maps NothingToCompactError to a benign notice (instead of
		// "Compaction failed"); a plain Error here would silently break that
		// classification, so the typed class is the contract under test. The
		// throw happens before any LLM call — no API key involved.
		tempDir = TempDir.createSync("@omp-nothing-to-compact-");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			initialState: { model, systemPrompt: ["test"], tools: [] },
		});
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
		});

		const err = await session.compact().then(
			() => undefined,
			(e: unknown) => e,
		);

		expect(err).toBeInstanceOf(NothingToCompactError);
		if (!(err instanceof NothingToCompactError)) {
			throw new Error(`expected NothingToCompactError, got ${String(err)}`);
		}
		expect(err.message).toBe("Nothing to compact (session too small)");
	});
});
