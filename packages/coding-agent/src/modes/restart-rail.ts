/**
 * Host rail for the `restart` tool.
 *
 * Registering the rail is what makes the tool available at all: only the
 * interactive TUI can re-exec this process in place, so print, ACP, SDK hosts
 * without a TUI, and subagents leave it unregistered and the tool reports itself
 * unavailable. Factored out of `InteractiveMode.init` (like
 * {@link createSessionTeardown}) so the registration and the confirmation
 * handoff are exercisable without standing up a terminal.
 */
import { logger } from "@oh-my-pi/pi-utils";

/** The single AgentSession capability the rail needs. */
interface RestartRailSession {
	setRestartHandler(handler: ((request: { confirmation: string }) => void) | null): void;
}

/**
 * Route accepted restart requests into `teardown`, which must relaunch this
 * process and arrange for `confirmation` to be auto-submitted in the resumed
 * session. Requests arrive after the `restart` tool result is finalized, so the
 * teardown is free to start immediately.
 *
 * The returned disposer unregisters the rail. Hosts MUST call it when they tear
 * down: an AgentSession can outlive its mode (parked or handed-off sessions),
 * and a dead closure would let the tool claim a restart nothing can perform.
 */
export function installRestartRail(
	session: RestartRailSession,
	teardown: (confirmation: string) => Promise<void>,
): () => void {
	session.setRestartHandler(({ confirmation }) => {
		void teardown(confirmation).catch(error => {
			logger.error("Restart requested by the restart tool failed", { error: String(error) });
		});
	});
	return () => session.setRestartHandler(null);
}
