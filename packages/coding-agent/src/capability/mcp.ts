/**
 * MCP (Model Context Protocol) Servers Capability
 *
 * Canonical shape for MCP server configurations, regardless of source format.
 * All providers translate their native format to this shape.
 */

import type { MCPLaunchApp } from "../mcp/types";
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * Canonical MCP server configuration.
 */
export interface MCPServer {
	/** Server name (unique key) */
	name: string;
	/** Whether this server is enabled (default: true) */
	enabled?: boolean;
	/** Per-tool-call timeout in milliseconds (default: 30000). */
	timeout?: number;
	/** Hard cap on the startup handshake (default: 30000). Separate from `timeout`. */
	connectTimeoutMs?: number;
	/** Command to run (for stdio transport) */
	command?: string;
	/** Command arguments */
	args?: string[];
	/** Environment variables */
	env?: Record<string, string>;
	/** Working directory for stdio transport */
	cwd?: string;
	/**
	 * macOS-only: ensure a macOS app is running before spawning the stdio command.
	 * Forwarded to `MCPStdioServerConfig.launchApp` when transport === "stdio".
	 */
	launchApp?: MCPLaunchApp;
	/** URL (for HTTP/SSE transport) */
	url?: string;
	/** HTTP headers (for HTTP transport) */
	headers?: Record<string, string>;
	/** Authentication configuration */
	auth?: {
		type: "oauth" | "apikey";
		credentialId?: string;
		tokenUrl?: string;
		clientId?: string;
		clientSecret?: string;
		resource?: string;
	};
	/** OAuth configuration (clientId, clientSecret, redirectUri, callbackPort, callbackPath, prompt) for servers requiring explicit client credentials */
	oauth?: {
		clientId?: string;
		clientSecret?: string;
		redirectUri?: string;
		callbackPort?: number;
		callbackPath?: string;
		prompt?: string;
	};
	/** Transport type */
	transport?: "stdio" | "sse" | "http";
	/** Source metadata (added by loader) */
	_source: SourceMeta;
}

export const mcpCapability = defineCapability<MCPServer>({
	id: "mcps",
	displayName: "MCP Servers",
	description: "Model Context Protocol server configurations for external tool integrations",
	key: server => server.name,
	toExtensionId: server => `mcp:${server.name}`,
	validate: server => {
		if (!server.name) return "Missing server name";
		if (!server.command && !server.url) return "Must have command or url";

		// Validate transport-endpoint pairing
		if (server.transport === "stdio" && !server.command) {
			return "stdio transport requires command field";
		}
		if ((server.transport === "http" || server.transport === "sse") && !server.url) {
			return "http/sse transport requires url field";
		}

		// launchApp is stdio-only
		if (server.launchApp !== undefined) {
			const inferredStdio = server.transport === "stdio" || (!server.transport && !!server.command);
			if (!inferredStdio) {
				return "launchApp is only valid for stdio transport";
			}
			if (typeof server.launchApp === "string") {
				if (server.launchApp.length === 0) return "launchApp string must not be empty";
			} else {
				if (typeof server.launchApp.path !== "string" || server.launchApp.path.length === 0) {
					return "launchApp.path must be a non-empty string";
				}
			}
		}

		return undefined;
	},
});
