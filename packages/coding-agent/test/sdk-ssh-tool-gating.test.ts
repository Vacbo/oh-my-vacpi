import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { reset as resetCapabilities } from "@oh-my-pi/pi-coding-agent/capability";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type CreateAgentSessionOptions, createAgentSession, discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { addSSHHost } from "@oh-my-pi/pi-coding-agent/ssh/config-writer";
import { getConfigRootDir, getSSHConfigPath, removeSyncWithRetries, Snowflake, setAgentDir } from "@oh-my-pi/pi-utils";

describe("createAgentSession ssh device gating", () => {
	const tempDirs: string[] = [];

	// Shared across sessions: `ModelRegistry` eagerly loads bundled models and
	// `discoverAuthStorage` opens the auth DB, which dominates a cold boot and is
	// identical for both cases here.
	let modelRegistry!: ModelRegistry;
	let registryAuthDir: string;

	// SSH discovery merges user scope with project scope, so without an isolated
	// agent dir the developer's real ~/.omp/agent/ssh.json would register an `ssh`
	// device even when the project config has none - making the allowlist case pass
	// or fail for the wrong reason.
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
	let testAgentDir = "";

	const makeTempDir = (): string => {
		const tempDir = path.join(os.tmpdir(), `pi-sdk-ssh-gating-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });
		return tempDir;
	};

	beforeAll(async () => {
		registryAuthDir = path.join(os.tmpdir(), `pi-sdk-ssh-gating-auth-${Snowflake.next()}`);
		fs.mkdirSync(registryAuthDir, { recursive: true });
		modelRegistry = new ModelRegistry(await discoverAuthStorage(registryAuthDir));
	});

	beforeEach(() => {
		testAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-ssh-gating-agent-"));
		setAgentDir(testAgentDir);
		resetCapabilities();
	});

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
		resetCapabilities();
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		if (testAgentDir) fs.rmSync(testAgentDir, { recursive: true, force: true });
	});

	afterAll(() => {
		removeSyncWithRetries(registryAuthDir);
	});

	// `rules: []` plus a prebuilt `workspaceTree` short-circuit the two slow startup
	// scans that are irrelevant here; these tests assert only tool presentation.
	const baseOptions = (tempDir: string): CreateAgentSessionOptions => ({
		cwd: tempDir,
		agentDir: tempDir,
		modelRegistry,
		sessionManager: SessionManager.inMemory(tempDir),
		settings: Settings.isolated(),
		model: getBundledModel("openai", "gpt-4o-mini"),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		rules: [],
		workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	});

	it("registers a discovered ssh host as an xd:// device by default", async () => {
		const tempDir = makeTempDir();
		await addSSHHost(getSSHConfigPath("project", tempDir), "starship", { host: "198.51.100.5" });

		const { session } = await createAgentSession(baseOptions(tempDir));

		try {
			expect(session.getAllToolNames()).toContain("ssh");
			expect(session.getToolByName("ssh")?.description).toContain("starship (198.51.100.5)");
			// Discoverable tools are presented under `xd://`, not as top-level tools.
			expect(session.getXdevToolEntries().map(entry => entry.name)).toContain("ssh");
			expect(session.getActiveToolNames()).not.toContain("ssh");
		} finally {
			await session.dispose();
		}
	});

	it("omits the ssh device when an explicit tool allowlist excludes it", async () => {
		const tempDir = makeTempDir();
		await addSSHHost(getSSHConfigPath("project", tempDir), "starship", { host: "198.51.100.5" });

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			toolNames: ["read", "write"],
		});

		try {
			expect(session.getAllToolNames()).toContain("read");
			expect(session.getAllToolNames()).not.toContain("ssh");
			expect(session.getActiveToolNames()).not.toContain("ssh");
			expect(session.getXdevToolEntries().map(entry => entry.name)).not.toContain("ssh");
		} finally {
			await session.dispose();
		}
	});

	it("registers the ssh device when an explicit tool allowlist names it", async () => {
		const tempDir = makeTempDir();
		await addSSHHost(getSSHConfigPath("project", tempDir), "starship", { host: "198.51.100.5" });

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			toolNames: ["read", "write", "ssh"],
		});

		try {
			expect(session.getAllToolNames()).toContain("ssh");
			expect(session.getToolByName("ssh")?.description).toContain("starship (198.51.100.5)");
		} finally {
			await session.dispose();
		}
	});
});
