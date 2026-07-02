/**
 * Restart tool: model-invoked in-place process restart (fork feature).
 *
 * Lets the model adopt a freshly rebuilt omp into its OWN session: boot-probe
 * the relaunch artifact, end the current turn through the host mode's restart
 * handler (which aborts the run once this tool's result is collected), re-exec
 * via the `/restart` rails, resume this session, and auto-submit a
 * confirmation message through the `initialMessages` path. Receiving the
 * confirmation is the proof of a successful restart; a build that cannot boot
 * fails the preflight and surfaces as a tool error with the session intact.
 *
 * Gated off by default (`restart.toolEnabled`) and offered only to top-level
 * interactive sessions: print/ACP/subagent sessions never register a restart
 * handler, and `createIf` excludes subagents outright.
 */
import * as fs from "node:fs/promises";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import * as z from "zod/v4";
import restartConfirmationTemplate from "../prompts/restart-confirmation.md" with { type: "text" };
import restartDescription from "../prompts/tools/restart.md" with { type: "text" };
import { preflightRelaunch, relaunchArtifact } from "../utils/relaunch";
import type { ToolSession } from ".";
import type { OutputMeta } from "./output-meta";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const restartSchema = z.object({
	reason: z.string().describe("one line: why the restart is needed (e.g. 'adopt rebuilt tui_observe')"),
});

type RestartParams = z.infer<typeof restartSchema>;

export interface RestartToolDetails {
	reason: string;
	version?: string;
	artifact: string;
	meta?: OutputMeta;
}

/** Best-effort artifact build time for the confirmation message. */
async function artifactMtime(path: string): Promise<string | undefined> {
	try {
		const stat = await fs.stat(path);
		return stat.mtime.toISOString();
	} catch {
		// Metadata only: a missing stat degrades the message, never the restart.
		return undefined;
	}
}

export class RestartTool implements AgentTool<typeof restartSchema, RestartToolDetails> {
	readonly name = "restart";
	readonly approval = "exec" as const;
	readonly label = "Restart";
	readonly summary = "Restart omp in place and resume this session on the rebuilt code";
	readonly loadMode = "discoverable" as const;
	readonly description: string;
	readonly parameters = restartSchema;
	readonly strict = true;
	readonly concurrency = "exclusive" as const;
	readonly intent = (args: Partial<RestartParams>) =>
		args.reason ? `restarting omp: ${args.reason}` : "restarting omp";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(restartDescription, {});
	}

	static createIf(session: ToolSession): RestartTool | null {
		if ((session.taskDepth ?? 0) > 0) return null;
		if (!session.settings.get("restart.toolEnabled")) return null;
		return new RestartTool(session);
	}

	async execute(
		_toolCallId: string,
		params: RestartParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<RestartToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<RestartToolDetails>> {
		if (!this.session.requestRestart) {
			throw new ToolError("Restart is unavailable in this mode: only the interactive omp TUI can re-exec in place.");
		}
		const sessionFile = this.session.getSessionFile();
		if (!sessionFile) {
			throw new ToolError("Restart requires a persisted session to resume; this session has no file on disk.");
		}
		const preflight = await preflightRelaunch();
		if (!preflight.ok) {
			throw new ToolError(
				`Restart refused: the relaunch artifact failed its boot probe (${preflight.detail ?? "unknown error"}). ` +
					"The session continues on the current build. Fix or rebuild, then try again.",
			);
		}
		const artifact = relaunchArtifact();
		const confirmation = prompt.render(restartConfirmationTemplate, {
			reason: params.reason,
			version: preflight.version || "unknown version",
			artifact,
			builtAt: await artifactMtime(artifact),
		});
		const accepted = this.session.requestRestart({ confirmation });
		if (!accepted) {
			throw new ToolError("Restart is unavailable in this mode: only the interactive omp TUI can re-exec in place.");
		}
		return toolResult<RestartToolDetails>({ reason: params.reason, version: preflight.version, artifact })
			.text(
				`Preflight passed (${preflight.version || "version unknown"}). Restarting now: this process re-execs in place and resumes the session. ` +
					"No further tool calls run in this process; the next user message is the automated restart confirmation from the relaunched process.",
			)
			.done();
	}
}
