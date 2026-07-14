/**
 * Shared MCP server normalization.
 *
 * Single `unknown` → canonical `MCPServer` seam used by every provider that
 * reads an `mcpServers` map from a JSON config (native `.omp` and the standalone
 * `mcp.json` / `.mcp.json` fallback). It owns env-var expansion, per-value
 * validation, and the projection of the documented server fields so the loaders
 * cannot drift apart or silently drop fields like `connectTimeoutMs`,
 * `launchApp`, or `auth.resource`.
 *
 * Validation problems are returned as `warnings` (never logged here) so each
 * loader keeps ownership of its `LoadResult.warnings` and both providers stay
 * observably identical.
 */
import type { MCPServer } from "../capability/mcp";
import type { SourceMeta } from "../capability/types";
import type { MCPLaunchApp } from "../mcp/types";
import { expandEnvVarsDeep } from "./helpers";

type MCPAuth = NonNullable<MCPServer["auth"]>;
type MCPOAuth = NonNullable<MCPServer["oauth"]>;

/** Canonical servers plus any per-value validation warnings. */
export interface NormalizedMCPServers {
	items: MCPServer[];
	warnings: string[];
}

/** Coerce a documented boolean flag, accepting the JSON string forms. */
function normalizeEnabled(name: string, raw: unknown, warnings: string[]): boolean | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw === "boolean") return raw;
	if (typeof raw === "string") {
		const lower = raw.toLowerCase();
		if (lower === "false" || lower === "0") return false;
		if (lower === "true" || lower === "1") return true;
		warnings.push(`MCP server "${name}": invalid enabled value "${raw}", ignoring`);
		return undefined;
	}
	warnings.push(`MCP server "${name}": invalid enabled type ${typeof raw}, ignoring`);
	return undefined;
}

/** Coerce a documented non-negative millisecond value; `0` disables per schema. */
function normalizeTimeoutField(name: string, field: string, raw: unknown, warnings: string[]): number | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw === "number") {
		if (Number.isFinite(raw) && raw >= 0) return raw;
		warnings.push(`MCP server "${name}": invalid ${field} ${raw}, ignoring`);
		return undefined;
	}
	if (typeof raw === "string") {
		const parsed = Number(raw);
		if (Number.isFinite(parsed) && parsed >= 0) return parsed;
		warnings.push(`MCP server "${name}": invalid ${field} "${raw}", ignoring`);
		return undefined;
	}
	warnings.push(`MCP server "${name}": invalid ${field} type ${typeof raw}, ignoring`);
	return undefined;
}

/** Project the documented launchApp descriptor, preserving the foreground flag. */
function normalizeLaunchApp(name: string, raw: unknown, warnings: string[]): MCPLaunchApp | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw === "string") {
		if (raw.length === 0) {
			warnings.push(`MCP server "${name}": launchApp string must not be empty, ignoring launchApp`);
			return undefined;
		}
		return raw;
	}
	if (typeof raw === "object" && !Array.isArray(raw)) {
		const obj = raw as Record<string, unknown>;
		if (typeof obj.path !== "string" || obj.path.length === 0) {
			warnings.push(`MCP server "${name}": launchApp.path must be a non-empty string, ignoring launchApp`);
			return undefined;
		}
		const app: { path: string; foreground?: boolean } = { path: obj.path };
		if (obj.foreground !== undefined) {
			if (typeof obj.foreground === "boolean") {
				app.foreground = obj.foreground;
			} else {
				warnings.push(`MCP server "${name}": launchApp.foreground must be a boolean, ignoring foreground`);
			}
		}
		return app;
	}
	warnings.push(`MCP server "${name}": invalid launchApp type ${typeof raw}, ignoring`);
	return undefined;
}

/** Project the documented auth config, preserving the OAuth resource indicator. */
function normalizeAuth(name: string, raw: unknown, warnings: string[]): MCPAuth | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== "object" || Array.isArray(raw)) {
		warnings.push(`MCP server "${name}": invalid auth type ${typeof raw}, ignoring auth`);
		return undefined;
	}
	const obj = raw as Record<string, unknown>;
	if (obj.type !== "oauth" && obj.type !== "apikey") {
		warnings.push(`MCP server "${name}": auth.type must be "oauth" or "apikey", ignoring auth`);
		return undefined;
	}
	const auth: MCPAuth = { type: obj.type };
	if (typeof obj.credentialId === "string") auth.credentialId = obj.credentialId;
	if (typeof obj.tokenUrl === "string") auth.tokenUrl = obj.tokenUrl;
	if (typeof obj.clientId === "string") auth.clientId = obj.clientId;
	if (typeof obj.clientSecret === "string") auth.clientSecret = obj.clientSecret;
	if (typeof obj.resource === "string") auth.resource = obj.resource;
	return auth;
}

/** Project the documented explicit-OAuth client settings. */
function normalizeOAuth(name: string, raw: unknown, warnings: string[]): MCPOAuth | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== "object" || Array.isArray(raw)) {
		warnings.push(`MCP server "${name}": invalid oauth type ${typeof raw}, ignoring oauth`);
		return undefined;
	}
	const obj = raw as Record<string, unknown>;
	const oauth: MCPOAuth = {};
	if (typeof obj.clientId === "string") oauth.clientId = obj.clientId;
	if (typeof obj.clientSecret === "string") oauth.clientSecret = obj.clientSecret;
	if (typeof obj.redirectUri === "string") oauth.redirectUri = obj.redirectUri;
	if (typeof obj.callbackPort === "number" && Number.isFinite(obj.callbackPort)) {
		oauth.callbackPort = obj.callbackPort;
	}
	if (typeof obj.callbackPath === "string") oauth.callbackPath = obj.callbackPath;
	if (typeof obj.prompt === "string") oauth.prompt = obj.prompt;
	return oauth;
}

/** Project the documented transport type, dropping unknown values. */
function normalizeTransport(name: string, raw: unknown, warnings: string[]): "stdio" | "sse" | "http" | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (raw === "stdio" || raw === "sse" || raw === "http") return raw;
	warnings.push(`MCP server "${name}": invalid transport type "${String(raw)}", ignoring`);
	return undefined;
}

/**
 * Normalize one raw `mcpServers` entry into a canonical `MCPServer`.
 *
 * Env vars are expanded across the whole entry first (so every string value —
 * including nested `auth.resource`, `launchApp.path`, `headers`, and `env` — is
 * resolved once), then the documented fields are projected and validated.
 */
export function normalizeMCPServer(name: string, raw: unknown, source: SourceMeta, warnings: string[]): MCPServer {
	const isObject = raw !== null && typeof raw === "object" && !Array.isArray(raw);
	if (!isObject) {
		warnings.push(`MCP server "${name}": server config must be an object, ignoring fields`);
	}
	const config = (isObject ? expandEnvVarsDeep(raw as Record<string, unknown>) : {}) as Record<string, unknown>;

	return {
		name,
		enabled: normalizeEnabled(name, config.enabled, warnings),
		timeout: normalizeTimeoutField(name, "timeout", config.timeout, warnings),
		connectTimeoutMs: normalizeTimeoutField(name, "connectTimeoutMs", config.connectTimeoutMs, warnings),
		command: typeof config.command === "string" ? config.command : undefined,
		args: Array.isArray(config.args) ? (config.args as string[]) : undefined,
		env: config.env as Record<string, string> | undefined,
		cwd: typeof config.cwd === "string" ? config.cwd : undefined,
		launchApp: normalizeLaunchApp(name, config.launchApp, warnings),
		url: typeof config.url === "string" ? config.url : undefined,
		headers: config.headers as Record<string, string> | undefined,
		auth: normalizeAuth(name, config.auth, warnings),
		oauth: normalizeOAuth(name, config.oauth, warnings),
		transport: normalizeTransport(name, config.type, warnings),
		_source: source,
	};
}

/** Normalize a whole `mcpServers` map into canonical servers plus warnings. */
export function normalizeMCPServers(rawServers: unknown, source: SourceMeta): NormalizedMCPServers {
	const items: MCPServer[] = [];
	const warnings: string[] = [];
	if (rawServers === undefined || rawServers === null) {
		return { items, warnings };
	}
	if (typeof rawServers !== "object" || Array.isArray(rawServers)) {
		warnings.push("mcpServers must be an object mapping server name to config, ignoring");
		return { items, warnings };
	}
	for (const [name, raw] of Object.entries(rawServers)) {
		items.push(normalizeMCPServer(name, raw, source, warnings));
	}
	return { items, warnings };
}
