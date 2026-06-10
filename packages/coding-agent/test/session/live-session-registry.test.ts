import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { inspectLiveSession, registerLiveSession } from "@oh-my-pi/pi-coding-agent/session/live-session-registry";

async function withTempAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-live-registry-"));
	try {
		await run(agentDir);
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}

describe("live session registry", () => {
	it("persists the cmux surface id recorded at registration", async () => {
		await withTempAgentDir(async agentDir => {
			const registration = await registerLiveSession({
				agentDir,
				cwd: "/tmp",
				agentId: "omp",
				sessionId: "session-1",
				mode: "interactive",
				cmuxSurfaceId: "surface-abc",
			});
			try {
				const summary = await inspectLiveSession(agentDir, registration.runId);
				expect(summary?.cmuxSurfaceId).toBe("surface-abc");
			} finally {
				await registration.dispose();
			}
		});
	});

	it("records no surface id unless the caller provides one", async () => {
		// The registry is a plain store: the surface id comes from the session
		// assembly (sdk), never implicitly from the test runner's own environment.
		await withTempAgentDir(async agentDir => {
			const registration = await registerLiveSession({
				agentDir,
				cwd: "/tmp",
				agentId: "omp",
				sessionId: "session-2",
				mode: "text",
			});
			try {
				const summary = await inspectLiveSession(agentDir, registration.runId);
				expect(summary?.cmuxSurfaceId).toBeUndefined();
			} finally {
				await registration.dispose();
			}
		});
	});
});
