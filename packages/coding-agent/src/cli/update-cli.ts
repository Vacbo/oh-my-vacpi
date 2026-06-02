/**
 * Fork update command handler.
 *
 * In this fork, `omp update` starts a fresh agent session whose job is to merge
 * the latest upstream tag. The upstream package/binary updater is intentionally
 * bypassed because installing upstream over this fork loses fork-specific code.
 *
 * The session is pinned to the fork checkout (not the cwd `omp update` ran from)
 * so the merge always edits the right repository.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $env, isEnoent, setProjectDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { runRootCommand } from "../main";
import MODEL_PRIO from "../priority.json" with { type: "json" };
import forkUpdatePrompt from "../prompts/commands/fork-update.md" with { type: "text" };
import { parseArgs } from "./args";

interface ModelRoleSettings {
	getModelRole(role: string): string | undefined;
}

export interface ForkUpdateLaunchOptions {
	settings?: ModelRoleSettings;
	env?: { PI_SLOW_MODEL?: string };
}

export interface ForkRepoDirOptions {
	env?: { OMP_VACPI_REPO_DIR?: string };
	homedir?: string;
}

const DEFAULT_FORK_REPO_SUBPATH = ["Documents", "Projects", "oh-my-vacpi"] as const;

/**
 * Resolve the fork checkout the update session must operate in.
 * `OMP_VACPI_REPO_DIR` overrides; otherwise the default `~/Documents/Projects/oh-my-vacpi`.
 */
export function resolveForkRepoDir(options: ForkRepoDirOptions = {}): string {
	const override = options.env?.OMP_VACPI_REPO_DIR?.trim();
	if (override) return path.resolve(override);
	const home = options.homedir ?? os.homedir();
	return path.join(home, ...DEFAULT_FORK_REPO_SUBPATH);
}

async function assertForkRepoDir(dir: string): Promise<void> {
	try {
		const stat = await fs.stat(dir);
		if (!stat.isDirectory()) {
			throw new Error(`Fork repo path is not a directory: ${dir}`);
		}
	} catch (err) {
		if (isEnoent(err)) {
			throw new Error(`Fork repo not found at ${dir}. Set OMP_VACPI_REPO_DIR to the oh-my-vacpi checkout path.`);
		}
		throw err;
	}
	try {
		await fs.stat(path.join(dir, ".git"));
	} catch (err) {
		if (isEnoent(err)) {
			throw new Error(`Fork repo at ${dir} is not a git checkout (no .git). Cannot merge upstream there.`);
		}
		throw err;
	}
}

export function resolveForkUpdateModelScope(options: ForkUpdateLaunchOptions = {}): string {
	const configured = options.env?.PI_SLOW_MODEL?.trim() || options.settings?.getModelRole("slow")?.trim();
	if (configured) return configured;
	return MODEL_PRIO.slow.join(",");
}

export function buildForkUpdateLaunchArgs(options: ForkUpdateLaunchOptions = {}): string[] {
	return ["--new", "--models", resolveForkUpdateModelScope(options), forkUpdatePrompt.trim()];
}

export async function runUpdateCommand(): Promise<void> {
	const repoDir = resolveForkRepoDir({ env: $env });
	await assertForkRepoDir(repoDir);
	// Pin both the project dir and process cwd to the fork checkout so settings,
	// plugin discovery, and the agent's tool cwd all target the right repo.
	setProjectDir(repoDir);

	const settings = await Settings.init({ cwd: repoDir });
	const args = buildForkUpdateLaunchArgs({ settings, env: $env });
	await runRootCommand(parseArgs([...args]), args);
}
