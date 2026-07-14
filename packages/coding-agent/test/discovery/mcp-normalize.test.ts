/**
 * The two canonical MCP JSON shapes — native `<cwd>/.omp/mcp.json` and the
 * standalone `<cwd>/mcp.json` fallback — share one `unknown → MCPServer`
 * normalizer. These tests prove both loaders round-trip the documented
 * `launchApp` (incl. the `foreground` flag), `connectTimeoutMs`, and
 * `auth.resource` fields into runtime config, produce identical canonical
 * output, and surface real per-value validation warnings.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { type MCPServer, mcpCapability } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { loadAllMCPConfigs, validateServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/config";
import type { MCPServerConfig, MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { getConfigRootDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

/** native reads <cwd>/.omp/mcp.json; the standalone fallback reads <cwd>/mcp.json. */
const NATIVE_REL = path.join(".omp", "mcp.json");
const STANDALONE_REL = "mcp.json";

const SHAPES = [
	{ provider: "native", relPath: NATIVE_REL },
	{ provider: "mcp-json", relPath: STANDALONE_REL },
] as const;

const FULL_CONFIG = {
	mcpServers: {
		repo: {
			command: "repo-cli",
			args: ["--serve"],
			timeout: 60000,
			connectTimeoutMs: 5000,
			launchApp: { path: "Repo Prompt", foreground: true },
			auth: {
				type: "oauth",
				tokenUrl: "https://provider.example/token",
				resource: "https://mcp.example/resource",
			},
		},
	},
};

async function writeConfig(cwd: string, relPath: string, config: unknown): Promise<void> {
	const file = path.join(cwd, relPath);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, JSON.stringify(config));
}

async function loadCanonical(provider: string, cwd: string): Promise<MCPServer[]> {
	clearFsCache();
	const result = await loadCapability<MCPServer>(mcpCapability.id, { cwd, providers: [provider] });
	return result.items;
}

/** Canonical server fields minus source metadata (which differs by provider/path). */
function canonicalFields(server: MCPServer): Record<string, unknown> {
	const copy: Record<string, unknown> = { ...server };
	delete copy._source;
	return copy;
}

describe("shared MCP normalizer preserves documented fields across both JSON shapes", () => {
	let agentDir = "";
	let cwd = "";

	beforeEach(async () => {
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-norm-agent-"));
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-norm-cwd-"));
		// Point native user-scope discovery at an empty temp dir so real user
		// config cannot leak into these assertions.
		setAgentDir(agentDir);
		clearFsCache();
	});

	afterEach(async () => {
		clearFsCache();
		if (originalAgentDirEnv) {
			setAgentDir(originalAgentDirEnv);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await removeWithRetries(agentDir);
		await removeWithRetries(cwd);
	});

	for (const { provider, relPath } of SHAPES) {
		test(`${provider}: preserves launchApp, connectTimeoutMs, and auth.resource`, async () => {
			await writeConfig(cwd, relPath, FULL_CONFIG);

			const [server] = await loadCanonical(provider, cwd);

			expect(server).toBeDefined();
			expect(server?.name).toBe("repo");
			expect(server?.connectTimeoutMs).toBe(5000);
			expect(server?.launchApp).toEqual({ path: "Repo Prompt", foreground: true });
			expect(server?.auth).toEqual({
				type: "oauth",
				tokenUrl: "https://provider.example/token",
				resource: "https://mcp.example/resource",
			});
		});
	}

	test("both JSON shapes produce identical canonical output", async () => {
		const nativeCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-norm-native-"));
		const standaloneCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-norm-standalone-"));
		try {
			await writeConfig(nativeCwd, NATIVE_REL, FULL_CONFIG);
			await writeConfig(standaloneCwd, STANDALONE_REL, FULL_CONFIG);

			const [nativeServer] = await loadCanonical("native", nativeCwd);
			const [standaloneServer] = await loadCanonical("mcp-json", standaloneCwd);

			expect(nativeServer).toBeDefined();
			expect(standaloneServer).toBeDefined();
			expect(canonicalFields(standaloneServer)).toEqual(canonicalFields(nativeServer));
		} finally {
			await removeWithRetries(nativeCwd);
			await removeWithRetries(standaloneCwd);
		}
	});

	for (const { provider, relPath } of SHAPES) {
		test(`${provider}: preserved fields round-trip into runtime MCPServerConfig via loadAllMCPConfigs`, async () => {
			await writeConfig(cwd, relPath, FULL_CONFIG);
			clearFsCache();

			const { configs } = await loadAllMCPConfigs(cwd);
			const config = configs.repo as MCPStdioServerConfig;

			expect(config).toBeDefined();
			expect(config.type).toBe("stdio");
			expect(config.connectTimeoutMs).toBe(5000);
			expect(config.launchApp).toEqual({ path: "Repo Prompt", foreground: true });
			expect(config.auth).toEqual({
				type: "oauth",
				tokenUrl: "https://provider.example/token",
				resource: "https://mcp.example/resource",
			});
		});
	}

	test("connectTimeoutMs: 0 (disables) round-trips instead of being dropped", async () => {
		await writeConfig(cwd, NATIVE_REL, {
			mcpServers: { zero: { command: "x", connectTimeoutMs: 0 } },
		});
		clearFsCache();

		const { configs } = await loadAllMCPConfigs(cwd);
		expect(configs.zero?.connectTimeoutMs).toBe(0);
		expect(validateServerConfig("zero", configs.zero as MCPServerConfig)).toEqual([]);
	});

	test("surfaces validation warnings for invalid documented values", async () => {
		await writeConfig(cwd, NATIVE_REL, {
			mcpServers: {
				bad: {
					command: "x",
					launchApp: { path: "App", foreground: "yes" },
					connectTimeoutMs: -5,
				},
			},
		});
		clearFsCache();

		const result = await loadCapability<MCPServer>(mcpCapability.id, { cwd, providers: ["native"] });
		const [server] = result.items;

		// Non-boolean foreground is dropped but the valid path descriptor survives.
		expect(server?.launchApp).toEqual({ path: "App" });
		expect(server?.connectTimeoutMs).toBeUndefined();

		const warnings = result.warnings.join("\n");
		expect(warnings).toContain("launchApp.foreground must be a boolean");
		expect(warnings).toContain("invalid connectTimeoutMs");
	});

	test("warns when mcpServers is not an object map", async () => {
		await writeConfig(cwd, NATIVE_REL, { mcpServers: [] });
		clearFsCache();

		const result = await loadCapability<MCPServer>(mcpCapability.id, { cwd, providers: ["native"] });

		expect(result.items).toHaveLength(0);
		expect(result.warnings.join("\n")).toContain("mcpServers must be an object");
	});
});

describe("validateServerConfig connectTimeoutMs bounds", () => {
	const base: MCPStdioServerConfig = { type: "stdio", command: "x" };

	test("accepts 0 and positive, rejects negative and non-finite", () => {
		expect(validateServerConfig("s", { ...base, connectTimeoutMs: 0 })).toEqual([]);
		expect(validateServerConfig("s", { ...base, connectTimeoutMs: 5000 })).toEqual([]);
		expect(validateServerConfig("s", { ...base, connectTimeoutMs: -1 })).toEqual([
			`Server "s": "connectTimeoutMs" must be a non-negative number`,
		]);
		expect(validateServerConfig("s", { ...base, connectTimeoutMs: Number.POSITIVE_INFINITY })).toEqual([
			`Server "s": "connectTimeoutMs" must be a non-negative number`,
		]);
	});
});
