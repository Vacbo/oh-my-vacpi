/**
 * Coverage for the `restart` tool's host rail, from tool execute to the callback
 * that re-execs the process:
 *
 *   RestartTool.execute
 *     -> ToolSession.requestRestart (what sdk.ts exposes off the AgentSession)
 *       -> AgentSession.requestRestart (records the accepted request)
 *         -> AgentSession.#afterToolCall (dispatches once the result is final)
 *           -> the handler installRestartRail registers
 *
 * An unwired callback leaves the tool reporting "unavailable"; a rail that never
 * dispatches never hands the confirmation over. `InteractiveMode.init` installs
 * the rail through `installRestartRail` and `shutdown()` disposes it, so driving
 * that helper covers the mode's registration without standing up a terminal.
 *
 * The boot probe is real (`Bun.spawn` of the relaunch artifact), so `argv[1]`
 * points at a stub entry that prints a version and exits 0: the same shape
 * `selfInvocation()` reconstructs for a source run.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool, type AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { installRestartRail } from "@oh-my-pi/pi-coding-agent/modes/restart-rail";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { RestartTool } from "@oh-my-pi/pi-coding-agent/tools/restart";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const STUB_VERSION = "42.0.0-restart-rail";
const REASON = "adopt rebuilt tui_observe";

describe("restart tool host rail", () => {
	let tempDir: string;
	let sessionFile: string;
	let stubEntry: string;
	let realEntry: string | undefined;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;
	let restartTool: RestartTool | null;
	let scripted: MockResponse[];
	/** Provider turns the loop dispatched: a second one means the run never stopped. */
	let modelCalls: number;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-restart-rail-${Snowflake.next()}-`));
		sessionFile = path.join(tempDir, "rollout.jsonl");
		fs.writeFileSync(sessionFile, "");
		// The artifact the preflight boot-probes and the confirmation names.
		stubEntry = path.join(tempDir, "fake-omp-entry.ts");
		fs.writeFileSync(stubEntry, `console.log(${JSON.stringify(STUB_VERSION)});\n`);
		realEntry = process.argv[1];
		process.argv[1] = stubEntry;

		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempDir });
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected claude-sonnet-4-5 to be bundled");
		const settings = Settings.isolated({
			"restart.toolEnabled": true,
			"compaction.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
			"async.enabled": false,
		});
		const sessionManager = SessionManager.inMemory(tempDir);

		// Mirrors the ToolSession sdk.ts builds: `requestRestart` is a live getter
		// off the session, absent until a host registers its rail.
		const toolSession: ToolSession = {
			cwd: tempDir,
			hasUI: true,
			settings,
			getSessionFile: () => sessionFile,
			getSessionSpawns: () => "*",
			get requestRestart() {
				return session?.requestRestart;
			},
		};
		restartTool = RestartTool.createIf(toolSession);
		if (!restartTool) throw new Error("expected restart tool with restart.toolEnabled");

		scripted = [];
		modelCalls = 0;
		const mock = createMockModel({
			handler: () => {
				modelCalls++;
				return scripted.shift() ?? { content: [{ type: "text", text: "done" }], stopReason: "stop" };
			},
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [restartTool as unknown as AgentTool],
				messages: [],
			},
			convertToLlm,
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
			toolRegistry: new Map([[restartTool.name, restartTool as unknown as AgentTool]]),
		});
	});

	afterEach(async () => {
		await session?.dispose().catch(() => {});
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
		if (realEntry === undefined) delete process.argv[1];
		else process.argv[1] = realEntry;
		if (fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	it("hands the rendered confirmation to the host rail and stops the run", async () => {
		const confirmations: string[] = [];
		let dispatched: (() => void) | undefined;
		const handlerFired = new Promise<void>(resolve => {
			dispatched = resolve;
		});
		// The registration InteractiveMode.init performs; its teardown callback
		// stashes the confirmation that InteractiveMode.restart() appends as the
		// sole positional of the rewritten launch argv before it re-execs.
		installRestartRail(session!, async confirmation => {
			confirmations.push(confirmation);
			dispatched?.();
		});

		scripted = [
			{
				content: [{ type: "toolCall", id: "call_restart", name: "restart", arguments: { reason: REASON } }],
				stopReason: "toolUse",
			},
		];
		await session!.prompt("adopt the rebuilt binary");
		await session!.waitForIdle();
		await handlerFired;

		expect(confirmations, "restart rail never dispatched: the callback is unwired").toHaveLength(1);
		const confirmation = confirmations[0]!;
		expect(confirmation).toContain(REASON);
		expect(confirmation).toContain(STUB_VERSION);
		expect(confirmation).toContain(stubEntry);
		// Nothing may run in a process about to be replaced, so the loop stops
		// instead of taking another provider turn.
		expect(modelCalls, "run continued past the restart tool result").toBe(1);
		// The relaunched process resumes from this transcript, so the aborted turn
		// still carries the result the confirmation refers to.
		const toolResult = session!.agent.state.messages.findLast(message => message.role === "toolResult");
		expect(toolResult?.toolName, "restart tool result missing from the resumed transcript").toBe("restart");
	});

	it("stays unavailable when no host registered a rail", async () => {
		const result: Promise<AgentToolResult<unknown>> = restartTool!.execute("call_restart", { reason: REASON });
		await expect(result).rejects.toThrow(/Restart is unavailable in this mode/);
	});

	it("stops claiming restart once the host disposes its rail", async () => {
		const dispose = installRestartRail(session!, async () => {});
		expect(session!.requestRestart).toBeDefined();

		dispose();

		expect(session!.requestRestart, "a torn-down mode still holds the rail").toBeUndefined();
		await expect(restartTool!.execute("call_restart", { reason: REASON })).rejects.toThrow(
			/Restart is unavailable in this mode/,
		);
	});

	it("is never offered to subagents or with the setting off", () => {
		const base: ToolSession = {
			cwd: tempDir,
			hasUI: true,
			settings: Settings.isolated({ "restart.toolEnabled": true }),
			getSessionFile: () => sessionFile,
			getSessionSpawns: () => "*",
			get requestRestart() {
				return session?.requestRestart;
			},
		};
		expect(RestartTool.createIf({ ...base, taskDepth: 1 })).toBeNull();
		expect(
			RestartTool.createIf({ ...base, settings: Settings.isolated({ "restart.toolEnabled": false }) }),
		).toBeNull();
	});
});
