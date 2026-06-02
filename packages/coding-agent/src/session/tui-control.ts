import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";

/**
 * Gated, loopback-only TUI input control.
 *
 * Lets the local sessions server inject input into a live session's TUI. This is
 * a security-sensitive capability and is therefore:
 *   - disabled by default (`tui.control.enabled`),
 *   - token-protected by default (`tui.control.requireToken`),
 *   - audited by default (`tui.control.logInputs`).
 *
 * Injection only works in-process: a control handler must be registered for the
 * run (interactive mode registers the live TUI). A separate `omp sessions serve`
 * process holds no handler, so cross-process injection returns `not-found`.
 */

export interface TuiControlHandler {
	injectInput(data: string): void;
	token: string;
}

export type TuiControlStatus = "ok" | "disabled" | "forbidden" | "not-found";

export interface TuiControlResult {
	status: TuiControlStatus;
	message: string;
}

export interface HandleTuiControlInputOptions {
	runId: string;
	data: string;
	token?: string;
	settings: Settings;
}

const MAX_AUDIT_CHARS = 80;
const handlers = new Map<string, TuiControlHandler>();

export function registerTuiControl(runId: string, handler: TuiControlHandler): () => void {
	handlers.set(runId, handler);
	return () => {
		if (handlers.get(runId) === handler) handlers.delete(runId);
	};
}

export function getTuiControl(runId: string): TuiControlHandler | undefined {
	return handlers.get(runId);
}

export function clearTuiControls(): void {
	handlers.clear();
}

export function createControlToken(): string {
	return crypto.randomUUID();
}

/**
 * Apply a gated control-input request. Returns a typed status; the caller maps
 * it to a transport response. Never injects unless control is enabled, the token
 * matches (when required), and a handler is registered for the run.
 */
export function handleTuiControlInput(options: HandleTuiControlInputOptions): TuiControlResult {
	const { settings, runId, data } = options;
	if (!settings.get("tui.control.enabled")) {
		audit(settings, runId, data, "disabled");
		return {
			status: "disabled",
			message: "TUI input control is disabled. Set tui.control.enabled to true to allow it.",
		};
	}
	const handler = handlers.get(runId);
	if (settings.get("tui.control.requireToken") && (!handler || !options.token || options.token !== handler.token)) {
		audit(settings, runId, data, "forbidden");
		return { status: "forbidden", message: "Invalid or missing control token." };
	}
	if (!handler) {
		audit(settings, runId, data, "not-found");
		return { status: "not-found", message: `No controllable TUI is registered for run ${runId}.` };
	}
	audit(settings, runId, data, "ok");
	handler.injectInput(data);
	return { status: "ok", message: "Input injected." };
}

function audit(settings: Settings, runId: string, data: string, status: TuiControlStatus): void {
	if (!settings.get("tui.control.logInputs")) return;
	const clipped = data.length > MAX_AUDIT_CHARS ? data.slice(0, MAX_AUDIT_CHARS) : data;
	// Sanitize control characters and bound length so the audit never echoes the full raw input.
	const preview = clipped.replace(/[\u0000-\u001f\u007f]/gu, "·");
	logger.info("TUI control input attempt", { runId, status, bytes: data.length, preview });
}
