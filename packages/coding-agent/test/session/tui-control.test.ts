import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { startSessionsServer } from "@oh-my-pi/pi-coding-agent/cli/sessions-server";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	clearTuiControls,
	handleTuiControlInput,
	registerTuiControl,
} from "@oh-my-pi/pi-coding-agent/session/tui-control";
import { logger } from "@oh-my-pi/pi-utils";

afterEach(() => {
	clearTuiControls();
});

function fakeSettings(values: Record<string, boolean>): Settings {
	return { get: (key: string) => values[key] } as unknown as Settings;
}

const ENABLED = { "tui.control.enabled": true, "tui.control.requireToken": true, "tui.control.logInputs": false };

describe("tui control gating", () => {
	it("refuses injection when control is disabled by default", () => {
		const injected: string[] = [];
		registerTuiControl("run-1", { injectInput: data => injected.push(data), token: "secret" });
		const result = handleTuiControlInput({
			runId: "run-1",
			data: "rm -rf /\r",
			token: "secret",
			settings: fakeSettings({ "tui.control.enabled": false }),
		});
		expect(result.status).toBe("disabled");
		expect(injected).toHaveLength(0);
	});

	it("rejects a missing or wrong token when tokens are required", () => {
		const injected: string[] = [];
		registerTuiControl("run-1", { injectInput: data => injected.push(data), token: "secret" });
		expect(handleTuiControlInput({ runId: "run-1", data: "x", settings: fakeSettings(ENABLED) }).status).toBe(
			"forbidden",
		);
		expect(
			handleTuiControlInput({ runId: "run-1", data: "x", token: "wrong", settings: fakeSettings(ENABLED) }).status,
		).toBe("forbidden");
		expect(injected).toHaveLength(0);
	});

	it("reports not-found when no handler is registered", () => {
		const result = handleTuiControlInput({
			runId: "ghost",
			data: "x",
			settings: fakeSettings({ "tui.control.enabled": true, "tui.control.requireToken": false }),
		});
		expect(result.status).toBe("not-found");
	});

	it("injects input only when enabled, registered, and the token matches", () => {
		const injected: string[] = [];
		registerTuiControl("run-1", { injectInput: data => injected.push(data), token: "secret" });
		const result = handleTuiControlInput({
			runId: "run-1",
			data: "ls\r",
			token: "secret",
			settings: fakeSettings(ENABLED),
		});
		expect(result.status).toBe("ok");
		expect(injected).toEqual(["ls\r"]);
	});

	it("audits attempts without echoing the full raw input", () => {
		const infoSpy = spyOn(logger, "info").mockImplementation(() => {});
		try {
			registerTuiControl("run-1", { injectInput: () => {}, token: "secret" });
			const longInput = "a".repeat(500);
			handleTuiControlInput({
				runId: "run-1",
				data: longInput,
				token: "secret",
				settings: fakeSettings({
					"tui.control.enabled": true,
					"tui.control.requireToken": true,
					"tui.control.logInputs": true,
				}),
			});
			expect(infoSpy).toHaveBeenCalledTimes(1);
			const payload = infoSpy.mock.calls[0]?.[1] as { bytes: number; preview: string; status: string };
			expect(payload.status).toBe("ok");
			expect(payload.bytes).toBe(500);
			expect(payload.preview.length).toBeLessThan(longInput.length);
		} finally {
			infoSpy.mockRestore();
		}
	});
});

describe("sessions server control endpoint", () => {
	it("never injects without a registered handler and rejects non-POST", async () => {
		const server = startSessionsServer({ agentDir: "/tmp/omp-control-test" });
		try {
			const post = await fetch(`${server.url}/api/sessions/no-such-run/input`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ data: "ls\r" }),
			});
			const body = (await post.json()) as { status: string };
			expect(body.status).not.toBe("ok");
			expect([403, 404]).toContain(post.status);

			const get = await fetch(`${server.url}/api/sessions/no-such-run/input`);
			expect(get.status).toBe(405);
		} finally {
			server.stop();
		}
	});
});
