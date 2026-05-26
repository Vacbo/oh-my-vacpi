import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";

import * as PiAgentCore from "@oh-my-pi/pi-agent-core";
import * as PiAi from "@oh-my-pi/pi-ai";
import * as PiAiOauth from "@oh-my-pi/pi-ai/utils/oauth";
import * as PiNatives from "@oh-my-pi/pi-natives";
import * as PiTui from "@oh-my-pi/pi-tui";
import * as PiUtils from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../config/model-registry";
import { BorderedLoader } from "../../modes/components/bordered-loader";
import { CustomEditor } from "../../modes/components/custom-editor";
import { AuthStorage } from "../../session/auth-storage";
import { SessionManager } from "../../session/session-manager";
import { truncateHead } from "../../session/streaming-output";
import * as PiCodingAgentExtensions from "../extensions/types";
import * as TypeBoxShim from "../typebox";

const requireFromHere = createRequire(import.meta.url);

interface DefaultResourceLoaderOptions {
	cwd: string;
	agentDir?: string;
	noContextFiles?: boolean;
	appendSystemPromptOverride?: (base: string[]) => string[];
}

class DefaultResourceLoader {
	readonly #options: DefaultResourceLoaderOptions;

	constructor(options: DefaultResourceLoaderOptions) {
		this.#options = options;
	}

	async reload(): Promise<void> {
		void this.#options;
	}
}

function formatSize(bytes: number): string {
	const units = ["B", "KB", "MB", "GB", "TB"] as const;
	let value = bytes;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex += 1;
	}
	return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function createLegacyToolSession(cwd: string) {
	const { Settings } = requireFromHere("../../config/settings") as typeof import("../../config/settings");
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
}

function createReadTool(cwd: string): unknown {
	const { ReadTool } = requireFromHere("../../tools/read") as typeof import("../../tools/read");
	return new ReadTool(createLegacyToolSession(cwd));
}

function createBashTool(cwd: string): unknown {
	const { BashTool } = requireFromHere("../../tools/bash") as typeof import("../../tools/bash");
	return new BashTool(createLegacyToolSession(cwd));
}

function createEditTool(cwd: string): unknown {
	const { EditTool } = requireFromHere("../../edit") as typeof import("../../edit");
	return new EditTool(createLegacyToolSession(cwd));
}

function createWriteTool(cwd: string): unknown {
	const { WriteTool } = requireFromHere("../../tools/write") as typeof import("../../tools/write");
	return new WriteTool(createLegacyToolSession(cwd));
}

function createGrepTool(cwd: string): unknown {
	const { SearchTool } = requireFromHere("../../tools/search") as typeof import("../../tools/search");
	return new SearchTool(createLegacyToolSession(cwd));
}

function createFindTool(cwd: string): unknown {
	const { FindTool } = requireFromHere("../../tools/find") as typeof import("../../tools/find");
	return new FindTool(createLegacyToolSession(cwd));
}

function createLsTool(cwd: string): unknown {
	const { ReadTool } = requireFromHere("../../tools/read") as typeof import("../../tools/read");
	return new ReadTool(createLegacyToolSession(cwd));
}

async function createAgentSession(...args: Parameters<typeof import("../../sdk").createAgentSession>) {
	const sdk = await import("../../sdk");
	return sdk.createAgentSession(...args);
}

// Canonical scope for in-process pi packages. Plugins published against any of
// the aliased scopes below (mariozechner's original publish, earendil-works'
// fork, or the canonical @oh-my-pi scope itself) are remapped to this scope and
// resolved against the bundled copy that ships inside the omp binary. This
// keeps plugins running against the exact runtime state of the host (single
// module registry, single tool registry, etc.) regardless of which historical
// scope name they happened to declare in their peerDependencies.
const CANONICAL_PI_SCOPE = "@oh-my-pi";

// Scopes that have historically been used to publish (or alias) the same set
// of internal pi-* packages. `@oh-my-pi` is intentionally included so that
// direct imports of the canonical name still flow through `Bun.resolveSync`
// against the host binary, avoiding a duplicate copy being pulled in from a
// plugin's own node_modules tree at install time.
const PI_SCOPE_ALIASES = ["oh-my-pi", "mariozechner", "earendil-works"] as const;

// Internal pi-* package basenames bundled inside the omp binary.
const PI_PACKAGE_NAMES = ["pi-agent-core", "pi-ai", "pi-coding-agent", "pi-natives", "pi-tui", "pi-utils"] as const;

const PI_SCOPE_ALTERNATION = PI_SCOPE_ALIASES.join("|");
const PI_PACKAGE_ALTERNATION = PI_PACKAGE_NAMES.join("|");

// Upstream `@mariozechner/*` packages exposed a few subpaths at the package
// root that we relocated under a different folder. Each entry rewrites
// `<pkg>/<from>` → `<pkg>/<to>` after the scope has been canonicalised, so
// plugins importing the upstream layout still resolve to a real file in our
// bundled copy. Add new entries as `pkg/from -> pkg/to` whenever a plugin
// surfaces another upstream-only subpath that breaks resolution.
const PI_SUBPATH_REMAPS: ReadonlyMap<string, string> = new Map<string, string>([
	// `@mariozechner/pi-ai/oauth` re-exported `./utils/oauth/index.js`.
	// Our pi-ai keeps the implementation under `utils/oauth` but never added a
	// root-level re-export, so map the upstream subpath onto it directly.
	["pi-ai/oauth", "pi-ai/utils/oauth"],
]);

const LEGACY_PI_SPECIFIER_FILTER = new RegExp(`^@(?:${PI_SCOPE_ALTERNATION})/(?:${PI_PACKAGE_ALTERNATION})(?:/.*)?$`);
const LEGACY_PI_IMPORT_SPECIFIER_REGEX = new RegExp(
	`((?:from\\s+|import\\s*\\(\\s*)["'])(@(?:${PI_SCOPE_ALTERNATION})/(?:${PI_PACKAGE_ALTERNATION})(?:/[^"'()\\s]+)?)(["'])`,
	"g",
);
const LEGACY_PI_FILE_PREFIX = "omp-legacy-pi-file:";
const LEGACY_PI_FILE_NAMESPACE = "omp-legacy-pi-file";
const resolvedSpecifierFallbacks = new Map<string, string>();
const LEGACY_PI_MODULE_REGISTRY_KEY = "omp.legacyPiModules";
const EXPORTED_IDENTIFIER_REGEX = /^[$A-Z_a-z][$\w]*$/;
const NODE_MODULES_SEGMENT = `${path.sep}node_modules${path.sep}`;

// Extensions that imported `@sinclair/typebox` directly used to resolve against a
// real `@sinclair/typebox` install. The runtime dep was replaced with the Zod-backed
// shim under `extensibility/typebox.ts`; plugins still importing the public name
// are redirected to that shim so existing extensions keep working without code
// changes. Submodules like `@sinclair/typebox/compiler` are intentionally not
// remapped — those expose TypeBox-only APIs the shim does not provide and plugins
// relying on them must vendor `@sinclair/typebox` directly.
const TYPEBOX_SPECIFIER = "@sinclair/typebox";
const TYPEBOX_SPECIFIER_FILTER = /^@sinclair\/typebox$/;
const TYPEBOX_SHIM_RELATIVE_SPECIFIER = "../typebox.ts";
const TYPEBOX_SHIM_REGISTRY_SPECIFIER = "omp:typebox-shim";

var isLegacyPiSpecifierShimInstalled = false;

function remapLegacyPiSpecifier(specifier: string): string | null {
	if (!LEGACY_PI_SPECIFIER_FILTER.test(specifier)) {
		return null;
	}
	const slashIdx = specifier.indexOf("/", 1);
	// Filter guarantees a slash exists, but guard anyway to keep the type narrow.
	if (slashIdx === -1) {
		return null;
	}
	const rest = specifier.slice(slashIdx + 1);
	const remappedSubpath = PI_SUBPATH_REMAPS.get(rest) ?? rest;
	return `${CANONICAL_PI_SCOPE}/${remappedSubpath}`;
}

function getResolvedSpecifier(specifier: string): string {
	const cached = resolvedSpecifierFallbacks.get(specifier);
	if (cached) {
		return cached;
	}

	const resolved = Bun.resolveSync(specifier, import.meta.dir);
	resolvedSpecifierFallbacks.set(specifier, resolved);
	return resolved;
}

function getLegacyPiModuleRegistry(): Map<string, Record<string, unknown>> {
	const symbol = Symbol.for(LEGACY_PI_MODULE_REGISTRY_KEY);
	const global = globalThis as typeof globalThis & { [symbol]?: Map<string, Record<string, unknown>> };
	let registry = global[symbol];
	if (!registry) {
		registry = new Map();
		global[symbol] = registry;
	}
	return registry;
}

function getShimPathForSpecifier(specifier: string, state: LegacyPiMirrorState): string {
	const digest = Bun.hash(specifier).toString(36);
	return path.join(state.root, `shim-${digest}.mjs`);
}

async function writeModuleShim(
	specifier: string,
	module: Record<string, unknown>,
	state: LegacyPiMirrorState,
): Promise<string> {
	const shimPath = getShimPathForSpecifier(specifier, state);
	if (state.seen.has(shimPath)) {
		return shimPath;
	}

	getLegacyPiModuleRegistry().set(specifier, module);
	const exportedNames = Object.keys(module)
		.filter(name => name !== "default" && EXPORTED_IDENTIFIER_REGEX.test(name))
		.sort();

	const lines = [
		`const registry = globalThis[Symbol.for(${JSON.stringify(LEGACY_PI_MODULE_REGISTRY_KEY)})];`,
		`const module = registry?.get(${JSON.stringify(specifier)});`,
		`if (!module) throw new Error(${JSON.stringify(`Legacy Pi shim registry missing ${specifier}`)});`,
		"const defaultExport = module.default;",
		"export { defaultExport as default };",
		...exportedNames.map(name => `export const ${name} = module[${JSON.stringify(name)}];`),
	];

	state.seen.set(shimPath, shimPath);
	await Bun.write(shimPath, lines.join("\n"));
	return shimPath;
}

function getBundledLegacyPiModule(specifier: string): Record<string, unknown> | null {
	switch (specifier) {
		case "@oh-my-pi/pi-agent-core":
			return PiAgentCore;
		case "@oh-my-pi/pi-ai":
			return PiAi;
		case "@oh-my-pi/pi-ai/utils/oauth":
			return PiAiOauth;
		case "@oh-my-pi/pi-coding-agent":
			return {
				...PiCodingAgentExtensions,
				createBashTool,
				createEditTool,
				createFindTool,
				createGrepTool,
				createLsTool,
				createReadTool,
				createWriteTool,
				Container: PiTui.Container,
				Markdown: PiTui.Markdown,
				Spacer: PiTui.Spacer,
				Text: PiTui.Text,
				getAgentDir: PiUtils.getAgentDir,
				logger: PiUtils.logger,
				VERSION: PiUtils.VERSION,
				AuthStorage,
				BorderedLoader,
				CustomEditor,
				DefaultResourceLoader,
				ModelRegistry,
				SessionManager,
				createAgentSession,
				formatSize,
				truncateHead,
			};
		case "@oh-my-pi/pi-coding-agent/extensibility/extensions":
			return PiCodingAgentExtensions;
		case "@oh-my-pi/pi-natives":
			return PiNatives;
		case "@oh-my-pi/pi-tui":
			return PiTui;
		case "@oh-my-pi/pi-utils":
			return PiUtils;
		default:
			return null;
	}
}

async function writeLegacyPiModuleShim(remappedSpecifier: string, state: LegacyPiMirrorState): Promise<string> {
	const module =
		getBundledLegacyPiModule(remappedSpecifier) ?? ((await import(remappedSpecifier)) as Record<string, unknown>);
	return writeModuleShim(remappedSpecifier, module, state);
}

async function writeTypeBoxShim(state: LegacyPiMirrorState): Promise<string> {
	const module = TypeBoxShim as Record<string, unknown>;
	return writeModuleShim(TYPEBOX_SHIM_REGISTRY_SPECIFIER, module, state);
}

function toImportSpecifier(resolvedPath: string): string {
	return url.pathToFileURL(resolvedPath).href;
}

async function rewriteLegacyPiImports(source: string, state: LegacyPiMirrorState): Promise<string> {
	const replacements = new Map<string, string>();

	for (const match of source.matchAll(LEGACY_PI_IMPORT_SPECIFIER_REGEX)) {
		const specifier = match[2];
		const remappedSpecifier = remapLegacyPiSpecifier(specifier);
		if (!remappedSpecifier || replacements.has(specifier)) {
			continue;
		}
		const shimPath = await writeLegacyPiModuleShim(remappedSpecifier, state);
		replacements.set(specifier, toImportSpecifier(shimPath));
	}

	if (replacements.size === 0) {
		return source;
	}

	return source.replace(
		LEGACY_PI_IMPORT_SPECIFIER_REGEX,
		(match, prefix: string, specifier: string, suffix: string) => {
			const replacement = replacements.get(specifier);
			return replacement ? `${prefix}${replacement}${suffix}` : match;
		},
	);
}

// Match static `from "..."` / `from '...'` import specifiers.
const STATIC_IMPORT_SPECIFIER_REGEX = /(from\s+["'])([^"']+)(["'])/g;
// Match static imports plus dynamic `import("...")` / `import('...')` specifiers.
const ANY_IMPORT_SPECIFIER_REGEX = /((?:from\s+|import\s*\(\s*)["'])([^"']+)(["'])/g;
// Match CommonJS `require("...")` / `require('...')` specifiers.
const REQUIRE_SPECIFIER_REGEX = /(require\s*\(\s*["'])([^"']+)(["']\s*\))/g;

/** Resolve bare imports against the extension directory before loading mirrored legacy Pi files. */
function isUrlLikeSpecifier(specifier: string): boolean {
	// Windows drive-letter paths (e.g. `C:\foo` or `C:/foo`) also match the URL
	// scheme shape `[A-Za-z][A-Za-z\d+.-]*:`. Treat them as filesystem paths so
	// `toRewrittenImportSpecifier` converts them to `file://` URLs instead of
	// emitting raw paths whose `\n`, `\U`, ... get eaten by TS string-literal
	// escapes inside the mirrored extension file.
	if (/^[a-zA-Z]:[\\/]/.test(specifier)) return false;
	return /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier);
}

function shouldPreserveImportSpecifier(specifier: string): boolean {
	return specifier.startsWith(".") || path.isAbsolute(specifier) || isUrlLikeSpecifier(specifier);
}

function toRewrittenImportSpecifier(resolvedPath: string): string {
	return isUrlLikeSpecifier(resolvedPath) ? resolvedPath : toImportSpecifier(resolvedPath);
}

function shouldMirrorResolvedBareImport(resolvedPath: string): boolean {
	return (
		path.isAbsolute(resolvedPath) &&
		resolvedPath.includes(NODE_MODULES_SEGMENT) &&
		/\.[cm]?[jt]sx?$/.test(resolvedPath)
	);
}

async function toRewrittenBareImportSpecifier(resolvedPath: string, state: LegacyPiMirrorState): Promise<string> {
	if (shouldMirrorResolvedBareImport(resolvedPath)) {
		return toImportSpecifier(await mirrorLegacyPiFile(resolvedPath, state));
	}
	return toRewrittenImportSpecifier(resolvedPath);
}

async function getPackageDirForBareSpecifier(
	specifier: string,
	importerDir: string,
): Promise<{ packageDir: string; subpath: string } | null> {
	if (specifier.startsWith(".") || specifier.startsWith("/") || isUrlLikeSpecifier(specifier)) {
		return null;
	}

	const parts = specifier.split("/");
	const packageName = specifier.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
	if (!packageName || (specifier.startsWith("@") && !parts[1])) {
		return null;
	}

	const subpathParts = parts.slice(packageName.startsWith("@") ? 2 : 1);
	let cursor = importerDir;
	while (true) {
		const candidate = path.join(cursor, "node_modules", packageName);
		if (await Bun.file(path.join(candidate, "package.json")).exists()) {
			return { packageDir: candidate, subpath: subpathParts.join("/") };
		}

		const nodeModulesIndex = cursor.lastIndexOf(NODE_MODULES_SEGMENT);
		if (nodeModulesIndex >= 0) {
			const nodeModulesRoot = cursor.slice(0, nodeModulesIndex + NODE_MODULES_SEGMENT.length - 1);
			const sibling = path.join(nodeModulesRoot, packageName);
			if (await Bun.file(path.join(sibling, "package.json")).exists()) {
				return { packageDir: sibling, subpath: subpathParts.join("/") };
			}
		}

		const parent = path.dirname(cursor);
		if (parent === cursor) {
			return null;
		}
		cursor = parent;
	}
}

async function resolvePackageEntry(packageDir: string, subpath: string): Promise<string> {
	const pkg = (await Bun.file(path.join(packageDir, "package.json")).json()) as {
		exports?: unknown;
		module?: string;
		main?: string;
	};
	if (subpath) {
		return path.join(packageDir, subpath);
	}

	const rootExport =
		typeof pkg.exports === "object" && pkg.exports !== null
			? (pkg.exports as Record<string, unknown>)["."]
			: undefined;
	if (typeof rootExport === "string") {
		return path.join(packageDir, rootExport);
	}
	if (typeof rootExport === "object" && rootExport !== null) {
		const importTarget = (rootExport as Record<string, unknown>).import;
		if (typeof importTarget === "string") {
			return path.join(packageDir, importTarget);
		}
	}

	if (typeof pkg.module === "string") {
		return path.join(packageDir, pkg.module);
	}
	if (typeof pkg.main === "string") {
		return path.join(packageDir, pkg.main);
	}
	return path.join(packageDir, "index.js");
}

async function resolveBareImportForLegacyExtension(specifier: string, importerDir: string): Promise<string | null> {
	try {
		return Bun.resolveSync(specifier, importerDir);
	} catch {
		const packageInfo = await getPackageDirForBareSpecifier(specifier, importerDir);
		return packageInfo ? resolvePackageEntry(packageInfo.packageDir, packageInfo.subpath) : null;
	}
}

async function rewriteBareImportsForLegacyExtension(
	source: string,
	importerPath: string,
	state: LegacyPiMirrorState,
): Promise<string> {
	const importerDir = path.dirname(importerPath);
	const importReplacements = new Map<string, string>();
	const requireReplacements = new Map<string, string>();

	for (const match of source.matchAll(ANY_IMPORT_SPECIFIER_REGEX)) {
		const specifier = match[2];
		if (specifier === TYPEBOX_SPECIFIER && !importReplacements.has(specifier)) {
			const shimPath = await writeTypeBoxShim(state);
			importReplacements.set(specifier, toImportSpecifier(shimPath));
			continue;
		}

		if (shouldPreserveImportSpecifier(specifier) || importReplacements.has(specifier)) {
			continue;
		}

		const resolved = await resolveBareImportForLegacyExtension(specifier, importerDir);
		if (resolved) {
			importReplacements.set(specifier, await toRewrittenBareImportSpecifier(resolved, state));
		}
	}

	for (const match of source.matchAll(REQUIRE_SPECIFIER_REGEX)) {
		const specifier = match[2];
		if (shouldPreserveImportSpecifier(specifier) || requireReplacements.has(specifier)) {
			continue;
		}

		const resolved = await resolveBareImportForLegacyExtension(specifier, importerDir);
		if (resolved) {
			requireReplacements.set(specifier, resolved);
		}
	}

	if (importReplacements.size === 0 && requireReplacements.size === 0) {
		return source;
	}

	const withImports = source.replace(
		ANY_IMPORT_SPECIFIER_REGEX,
		(match, prefix: string, specifier: string, suffix: string) => {
			const replacement = importReplacements.get(specifier);
			return replacement ? `${prefix}${replacement}${suffix}` : match;
		},
	);

	return withImports.replace(REQUIRE_SPECIFIER_REGEX, (match, prefix: string, specifier: string, suffix: string) => {
		const replacement = requireReplacements.get(specifier);
		return replacement ? `${prefix}${replacement}${suffix}` : match;
	});
}

interface LegacyPiMirrorState {
	root: string;
	seen: Map<string, string>;
}

function getMirrorPath(sourcePath: string, state: LegacyPiMirrorState): string {
	const extension = path.extname(sourcePath) || ".js";
	const digest = Bun.hash(sourcePath).toString(36);
	return path.join(state.root, `module-${digest}${extension}`);
}

async function rewriteRelativeImportsForLegacyExtension(
	source: string,
	importerPath: string,
	state: LegacyPiMirrorState,
): Promise<string> {
	const replacements = new Map<string, string>();

	for (const match of source.matchAll(STATIC_IMPORT_SPECIFIER_REGEX)) {
		const specifier = match[2];
		if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
			continue;
		}

		const resolved = Bun.resolveSync(specifier, path.dirname(importerPath));
		const mirrored = await mirrorLegacyPiFile(resolved, state);
		replacements.set(specifier, toImportSpecifier(mirrored));
	}

	if (replacements.size === 0) {
		return source;
	}

	return source.replace(STATIC_IMPORT_SPECIFIER_REGEX, (match, prefix: string, specifier: string, suffix: string) => {
		const replacement = replacements.get(specifier);
		return replacement ? `${prefix}${replacement}${suffix}` : match;
	});
}

async function rewriteLegacyPiImportsForRuntime(
	source: string,
	importerPath: string,
	state: LegacyPiMirrorState,
): Promise<string> {
	const withRelativeResolved = await rewriteRelativeImportsForLegacyExtension(source, importerPath, state);
	const withLegacyRemap = await rewriteLegacyPiImports(withRelativeResolved, state);
	return rewriteBareImportsForLegacyExtension(withLegacyRemap, importerPath, state);
}

async function mirrorLegacyPiFile(sourcePath: string, state: LegacyPiMirrorState): Promise<string> {
	const resolvedPath = path.resolve(sourcePath);
	const cached = state.seen.get(resolvedPath);
	if (cached) {
		return cached;
	}

	const mirrorPath = getMirrorPath(resolvedPath, state);
	state.seen.set(resolvedPath, mirrorPath);

	const raw = await Bun.file(resolvedPath).text();
	const rewritten = await rewriteLegacyPiImportsForRuntime(raw, resolvedPath, state);
	await Bun.write(mirrorPath, rewritten);
	return mirrorPath;
}

export async function loadLegacyPiModule(resolvedPath: string): Promise<unknown> {
	const mirrorParent = path.join(os.tmpdir(), "omp-legacy-pi-file");
	await fs.mkdir(mirrorParent, { recursive: true });
	const root = await fs.mkdtemp(path.join(mirrorParent, `${Bun.hash(resolvedPath).toString(36)}-`));
	const state: LegacyPiMirrorState = { root, seen: new Map() };
	const mirroredEntry = await mirrorLegacyPiFile(resolvedPath, state);
	return import(`${toImportSpecifier(mirroredEntry)}?mtime=${Date.now()}`);
}

function getLoader(path: string): "js" | "jsx" | "ts" | "tsx" {
	if (path.endsWith(".tsx")) {
		return "tsx";
	}
	if (path.endsWith(".jsx")) {
		return "jsx";
	}
	if (path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts")) {
		return "ts";
	}
	return "js";
}

function resolveLegacyPiSpecifier(args: { path: string; importer: string }): { path: string } | undefined {
	const remappedSpecifier = remapLegacyPiSpecifier(args.path);
	if (!remappedSpecifier) {
		return undefined;
	}

	return { path: getResolvedSpecifier(remappedSpecifier) };
}

function resolveTypeBoxSpecifier(): { path: string } {
	return { path: getResolvedSpecifier(TYPEBOX_SHIM_RELATIVE_SPECIFIER) };
}

export function installLegacyPiSpecifierShim(): void {
	if (isLegacyPiSpecifierShimInstalled) {
		return;
	}
	isLegacyPiSpecifierShimInstalled = true;

	Bun.plugin({
		name: "omp:legacy-pi-shim",
		setup(build) {
			build.onResolve({ filter: LEGACY_PI_SPECIFIER_FILTER, namespace: "file" }, resolveLegacyPiSpecifier);
			build.onResolve(
				{ filter: LEGACY_PI_SPECIFIER_FILTER, namespace: LEGACY_PI_FILE_NAMESPACE },
				resolveLegacyPiSpecifier,
			);

			build.onResolve({ filter: TYPEBOX_SPECIFIER_FILTER, namespace: "file" }, resolveTypeBoxSpecifier);
			build.onResolve(
				{ filter: TYPEBOX_SPECIFIER_FILTER, namespace: LEGACY_PI_FILE_NAMESPACE },
				resolveTypeBoxSpecifier,
			);

			build.onResolve({ filter: /^omp-legacy-pi-file:/, namespace: "file" }, args => ({
				path: args.path.slice(LEGACY_PI_FILE_PREFIX.length),
				namespace: LEGACY_PI_FILE_NAMESPACE,
			}));

			build.onResolve({ filter: /^(?:\.{1,2}\/|\/)/, namespace: LEGACY_PI_FILE_NAMESPACE }, args => ({
				path: args.path.startsWith("/") ? args.path : Bun.resolveSync(args.path, path.dirname(args.importer)),
				namespace: LEGACY_PI_FILE_NAMESPACE,
			}));

			build.onLoad({ filter: /\.[cm]?[jt]sx?$/, namespace: LEGACY_PI_FILE_NAMESPACE }, async args => {
				const raw = await Bun.file(args.path).text();
				const state: LegacyPiMirrorState = { root: path.dirname(args.path), seen: new Map() };
				const withLegacyRemap = await rewriteLegacyPiImports(raw, state);
				const withBareResolved = await rewriteBareImportsForLegacyExtension(withLegacyRemap, args.path, state);
				return {
					contents: withBareResolved,
					loader: getLoader(args.path),
				};
			});
		},
	});
}
