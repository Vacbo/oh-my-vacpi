import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { FIREPASS_SELECTOR, LEGACY_FIREPASS_SELECTOR } from "@oh-my-pi/pi-coding-agent/config/firepass-selector";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * A session already at CURRENT_SESSION_VERSION whose recorded model selector
 * still names the pre-provider Fire Pass router entry, plus an assistant turn
 * served by that same endpoint. Version-gated migrations skip this file, so the
 * selector rewrite has to be version-independent.
 */
function legacySessionLines(cwd: string): string {
	const timestamp = "2026-08-01T00:00:00.000Z";
	return [
		JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: "hdr", cwd, timestamp }),
		JSON.stringify({
			type: "model_change",
			id: "a1",
			parentId: null,
			timestamp,
			model: LEGACY_FIREPASS_SELECTOR,
			role: "default",
		}),
		JSON.stringify({
			type: "message",
			id: "a2",
			parentId: "a1",
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
				provider: "fireworks",
				model: "routers/kimi-k2.6-turbo",
				api: "openai-completions",
			},
		}),
		"",
	].join("\n");
}

describe("legacy Fire Pass selector migration", () => {
	it("canonicalizes an explicit model_change on load and persists the rewrite", async () => {
		const tempDir = TempDir.createSync("@pi-firepass-session-");
		try {
			const cwd = tempDir.path();
			const sessionDir = path.join(cwd, "sessions");
			const sessionFile = path.join(sessionDir, "legacy-firepass.jsonl");
			await Bun.write(sessionFile, legacySessionLines(cwd));

			const manager = SessionManager.create(cwd, sessionDir);
			await manager.setSessionFile(sessionFile);

			// Resume derivation selects the canonical selector, so the session reopens
			// on a model that still resolves instead of falling back silently.
			expect(manager.buildSessionContext().models.default).toBe(FIREPASS_SELECTOR);

			// Provenance is history: the assistant turn keeps naming the endpoint that
			// actually served it.
			const assistant = manager
				.getEntries()
				.find(entry => entry.type === "message" && entry.message.role === "assistant");
			if (assistant?.type !== "message" || assistant.message.role !== "assistant") {
				throw new Error("expected an assistant message entry");
			}
			expect(assistant.message.provider).toBe("fireworks");
			expect(assistant.message.model).toBe("routers/kimi-k2.6-turbo");

			// The load marked the session for rewrite, so the canonical selector also
			// reaches disk for the next reader.
			await manager.ensureOnDisk();
			await manager.flush();
			const persisted = await Bun.file(sessionFile).text();
			expect(persisted).toContain(FIREPASS_SELECTOR);
			expect(persisted).not.toContain(LEGACY_FIREPASS_SELECTOR);
			expect(persisted).toContain('"model":"routers/kimi-k2.6-turbo"');
		} finally {
			tempDir.removeSync();
		}
	});
});
