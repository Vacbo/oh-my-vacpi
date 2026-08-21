/**
 * Fork update command handler.
 *
 * In this fork, `omp update` starts a fresh agent session whose job is to merge
 * the latest upstream tag. The upstream package/binary updater is intentionally
 * bypassed because installing upstream over this fork loses fork-specific code.
 *
 * The session is pinned to the fork checkout (not the cwd `omp update` ran from)
 * so the merge always edits the right repository.
 *
 * {@link getLatestUpstreamRelease} is the one place that still talks to the npm
 * registry, and it only *reads* a version so startup can report that an upstream
 * tag is available to merge. No code path here downloads or installs an upstream
 * artifact: doing so would overwrite the fork with plain upstream.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $env, isEnoent, logger, setProjectDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { runRootCommand } from "../main";
import MODEL_PRIO from "../priority.json" with { type: "json" };
import forkUpdatePrompt from "../prompts/system/fork-update.md" with { type: "text" };
import { isUnsupportedProxyError, unsupportedProxyMessage, withTimeoutSignal } from "../utils/fetch-timeout";
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

const DEFAULT_FORK_REPO_SUBPATH = ["Dev", "oh-my-vacpi"] as const;
/**
 * Resolve the fork checkout the update session must operate in.
 * `OMP_VACPI_REPO_DIR` overrides; otherwise the default `~/Dev/oh-my-vacpi`.
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

/** Official npm registry origin — the catalog upstream publishes its releases to. */
const NPM_REGISTRY = "https://registry.npmjs.org/";

/**
 * Upstream package whose published version marks the newest mergeable tag. Hard
 * coded on purpose: the lookup below follows `omp.rename` pointers, and pinning
 * the entry point keeps a hostile or stale manifest from redirecting the very
 * first request somewhere else.
 */
const UPSTREAM_PACKAGE = "@oh-my-pi/pi-coding-agent";

/** Bound on `omp.rename` hops so a broken pointer chain cannot loop forever. */
const MAX_RENAME_HOPS = 3;

const RELEASE_METADATA_TIMEOUT_MS = 30_000;

/** npm package name grammar, so a rename pointer cannot smuggle a path or URL into the fetch. */
const NPM_PACKAGE_NAME_RE = /^(?:@[a-z0-9\-~][a-z0-9\-._~]*\/)?[a-z0-9\-~][a-z0-9\-._~]*$/;

const RELEASE_VERSION_RE = /^\d+\.\d+\.\d+(?:[-+].*)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Package name from an `omp.rename` pointer, or undefined when the manifest has
 * none or advertises something that is not a plain npm package name.
 */
function readRenamePointer(manifest: unknown): string | undefined {
	if (!isRecord(manifest) || !isRecord(manifest.omp) || !isRecord(manifest.omp.rename)) return undefined;
	const renamed = manifest.omp.rename.package;
	if (typeof renamed !== "string" || !NPM_PACKAGE_NAME_RE.test(renamed)) return undefined;
	return renamed;
}

async function fetchLatestManifest(pkg: string, timeoutMs: number): Promise<unknown> {
	let response: Response;
	try {
		response = await fetch(`${NPM_REGISTRY}${pkg}/latest`, {
			headers: { accept: "application/json" },
			signal: withTimeoutSignal(timeoutMs),
		});
	} catch (err) {
		// A misconfigured proxy env var otherwise surfaces as an opaque fetch
		// failure; upstream's diagnostic names the offending variable.
		if (isUnsupportedProxyError(err)) throw new Error(unsupportedProxyMessage(), { cause: err });
		throw err;
	}
	if (!response.ok) {
		throw new Error(`Failed to read ${pkg} release metadata: ${response.status} ${response.statusText}`);
	}
	return await response.json();
}

/**
 * Newest upstream version published to npm — the tag `omp update`'s merge
 * session would pull in.
 *
 * Read-only by construction: the fork shares upstream's package name, so this
 * resolves what upstream has released, never a fork artifact, and nothing acts
 * on the answer beyond reporting it. `omp.rename` pointers are followed (bounded
 * and cycle-guarded) so an upstream package rename does not silently freeze the
 * report at the last version published under the old name.
 *
 * @throws when the registry is unreachable or the manifest carries no usable version.
 */
export async function getLatestUpstreamRelease(options: { timeoutMs?: number } = {}): Promise<string> {
	const timeoutMs = options.timeoutMs ?? RELEASE_METADATA_TIMEOUT_MS;
	let pkg = UPSTREAM_PACKAGE;
	let manifest = await fetchLatestManifest(pkg, timeoutMs);
	const visited = new Set([pkg]);
	for (let hop = 0; hop < MAX_RENAME_HOPS; hop++) {
		const renamed = readRenamePointer(manifest);
		if (renamed === undefined || visited.has(renamed)) break;
		visited.add(renamed);
		manifest = await fetchLatestManifest(renamed, timeoutMs);
		pkg = renamed;
		logger.debug(`upstream release metadata followed rename pointer to ${pkg}`);
	}

	const version = isRecord(manifest) ? manifest.version : undefined;
	if (typeof version !== "string" || !RELEASE_VERSION_RE.test(version)) {
		throw new Error(`Upstream package ${pkg} published no usable version`);
	}
	return version;
}
