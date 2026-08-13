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

	it("refreshes the same run entry in place and leaves `stopped` as the final state", async () => {
		// The registry is keyed by runId, so a session-id/model change must rewrite
		// the existing entry rather than add a second one. refresh() is
		// fire-and-forget: dispose() has to land AFTER any queued refresh write, or
		// the row reports `running` for a session that already exited.
		await withTempAgentDir(async agentDir => {
			const registration = await registerLiveSession({
				agentDir,
				cwd: "/tmp/project",
				agentId: "0-Main",
				sessionId: "session-before",
				mode: "interactive",
				model: "provider/first",
			});
			registration.refresh({ sessionId: "session-after", model: "provider/second", sessionFile: "/tmp/s.jsonl" });
			await registration.dispose("stopped");

			const runs = await fs.readdir(path.join(agentDir, "runs"));
			expect(runs).toEqual([registration.runId]);
			const summary = await inspectLiveSession(agentDir, registration.runId);
			expect(summary?.sessionId).toBe("session-after");
			expect(summary?.model).toBe("provider/second");
			expect(summary?.sessionFile).toBe("/tmp/s.jsonl");
			expect(summary?.status).toBe("stopped");
			expect(summary?.isRunning).toBe(false);

			// A refresh after dispose is a synchronous no-op — it must not revive the entry.
			registration.refresh({ model: "provider/third" });
			const afterDispose = await inspectLiveSession(agentDir, registration.runId);
			expect(afterDispose?.status).toBe("stopped");
			expect(afterDispose?.model).toBe("provider/second");
		});
	});

	it("keeps concurrent registrations on separate run entries", async () => {
		// tui_observe/tui_drive and `omp sessions` target a specific run; two live
		// sessions in one agent dir must stay independently addressable, and
		// stopping one must not change the other's status.
		await withTempAgentDir(async agentDir => {
			const first = await registerLiveSession({
				agentDir,
				cwd: "/tmp/a",
				agentId: "0-Main",
				sessionId: "session-a",
				mode: "interactive",
			});
			const second = await registerLiveSession({
				agentDir,
				cwd: "/tmp/b",
				agentId: "1-Sub",
				sessionId: "session-b",
				mode: "rpc",
			});
			try {
				expect(second.runId).not.toBe(first.runId);
				await first.dispose("stopped");
				expect((await inspectLiveSession(agentDir, first.runId))?.status).toBe("stopped");
				expect((await inspectLiveSession(agentDir, second.runId))?.status).toBe("running");
			} finally {
				await second.dispose();
			}
		});
	});
});
