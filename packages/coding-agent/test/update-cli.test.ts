import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { CliConfig } from "@oh-my-pi/pi-utils/cli";
import { parseArgs } from "../src/cli/args";
import * as pluginCli from "../src/cli/plugin-cli";
import * as updateCli from "../src/cli/update-cli";
import { buildForkUpdateLaunchArgs, resolveForkRepoDir, resolveForkUpdateModelScope } from "../src/cli/update-cli";
import Update from "../src/commands/update";

const settingsWithSlowRole = {
	getModelRole(role: string): string | undefined {
		return role === "slow" ? "anthropic/claude-opus-4-5" : undefined;
	},
};
const TEST_CONFIG: CliConfig = {
	bin: "omp",
	version: "0.0.0-test",
	commands: new Map(),
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("fork update session launch", () => {
	it("uses PI_SLOW_MODEL as the update session model scope", () => {
		const scope = resolveForkUpdateModelScope({
			settings: settingsWithSlowRole,
			env: { PI_SLOW_MODEL: "openai/gpt-5.4" },
		});

		expect(scope).toBe("openai/gpt-5.4");
	});

	it("falls back to the configured slow role", () => {
		const scope = resolveForkUpdateModelScope({ settings: settingsWithSlowRole, env: {} });

		expect(scope).toBe("anthropic/claude-opus-4-5");
	});

	it("starts a fresh session with the fork merge prompt", () => {
		const args = buildForkUpdateLaunchArgs({ settings: settingsWithSlowRole, env: {} });
		const parsed = parseArgs([...args]);

		expect(parsed.newSession).toBe(true);
		expect(parsed.models).toEqual(["anthropic/claude-opus-4-5"]);
		expect(parsed.messages).toHaveLength(1);
		expect(parsed.messages[0]).toContain("Merge the latest upstream `can1357/oh-my-pi` tag into this fork.");
		expect(parsed.messages[0]).toContain("Do not run the legacy package or binary updater.");
	});

	it("pins the fork repo dir to the default checkout", () => {
		const dir = resolveForkRepoDir({ env: {}, homedir: "/home/pedro" });

		expect(dir).toBe("/home/pedro/Dev/oh-my-vacpi");
	});

	it("honors OMP_VACPI_REPO_DIR over the default", () => {
		const dir = resolveForkRepoDir({ env: { OMP_VACPI_REPO_DIR: "/srv/forks/vacpi" }, homedir: "/home/pedro" });

		expect(dir).toBe("/srv/forks/vacpi");
	});
});

describe("update command plugin dispatch", () => {
	it("routes -l to plugin upgrade instead of the fork merge launcher", async () => {
		const pluginSpy = spyOn(pluginCli, "runPluginCommand").mockResolvedValue(undefined);
		const updateSpy = spyOn(updateCli, "runUpdateCommand").mockResolvedValue(undefined);

		const command = new Update(["-l"], TEST_CONFIG);
		await command.run();

		expect(pluginSpy).toHaveBeenCalledWith({ action: "upgrade", args: [], flags: {} });
		expect(updateSpy).not.toHaveBeenCalled();
	});

	it("runs the fork merge launcher for normal update", async () => {
		const pluginSpy = spyOn(pluginCli, "runPluginCommand").mockResolvedValue(undefined);
		const updateSpy = spyOn(updateCli, "runUpdateCommand").mockResolvedValue(undefined);

		const command = new Update([], TEST_CONFIG);
		await command.run();

		expect(updateSpy).toHaveBeenCalledWith();
		expect(pluginSpy).not.toHaveBeenCalled();
	});
});

/**
 * The fork updater merges upstream inside a checkout instead of installing a
 * published artifact, so its only install-target contract is the checkout guard:
 * a missing or non-git directory must abort before a session is started.
 */
describe("fork update repo guard", () => {
	const originalRepoDir = process.env.OMP_VACPI_REPO_DIR;
	const tempDirs: string[] = [];

	afterEach(async () => {
		if (originalRepoDir === undefined) delete process.env.OMP_VACPI_REPO_DIR;
		else process.env.OMP_VACPI_REPO_DIR = originalRepoDir;
		for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
	});

	async function tempRepoDir(): Promise<string> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fork-update-"));
		tempDirs.push(dir);
		return dir;
	}

	it("refuses to start the merge session when the configured checkout is missing", async () => {
		const missing = path.join(await tempRepoDir(), "absent");
		process.env.OMP_VACPI_REPO_DIR = missing;

		await expect(updateCli.runUpdateCommand()).rejects.toThrow(`Fork repo not found at ${missing}`);
	});

	it("refuses to start the merge session when the checkout has no git repo", async () => {
		const dir = await tempRepoDir();
		process.env.OMP_VACPI_REPO_DIR = dir;

		await expect(updateCli.runUpdateCommand()).rejects.toThrow(/is not a git checkout/);
	});
});
