/**
 * UI adapter over the schema. Reads `ui.options` declared inline in
 * settings-schema.ts and produces typed widget definitions for the
 * settings selector.
 *
 * To add a new setting to the UI: declare it in `settings-schema.ts`
 * with a `ui` block carrying `tab` and `group` (the group must be listed
 * in `TAB_GROUPS[tab]`). If it needs a submenu, include `options: [...]`
 * (or `options: "runtime"` for runtime-injected lists like themes).
 */

import { fuzzyFilter, TERMINAL } from "@oh-my-pi/pi-tui";
import { Settings } from "../../config/settings";
import {
	type AnyUiMetadata,
	getDefault,
	getEnumValues,
	getPathsForTab,
	getType,
	getUi,
	SETTING_TABS,
	type SettingPath,
	type SettingTab,
	type SubmenuOption,
	TAB_GROUPS,
} from "../../config/settings-schema";

// ═══════════════════════════════════════════════════════════════════════════
// UI Definition Types
// ═══════════════════════════════════════════════════════════════════════════

export type SettingValue = boolean | string;

interface BaseSettingDef {
	path: SettingPath;
	label: string;
	description: string;
	tab: SettingTab;
	/** Section within the tab; items are ordered by TAB_GROUPS[tab] and rendered under a heading row. */
	group?: string;
	/**
	 * Optional visibility predicate. When supplied and returning false, the
	 * setting is hidden from the UI. Applies to every variant — booleans,
	 * enums, submenus, and text inputs.
	 */
	condition?: () => boolean;
}

export interface BooleanSettingDef extends BaseSettingDef {
	type: "boolean";
}

export interface EnumSettingDef extends BaseSettingDef {
	type: "enum";
	values: readonly string[];
}

type OptionList = ReadonlyArray<SubmenuOption>;

export interface SubmenuSettingDef extends BaseSettingDef {
	type: "submenu";
	options: OptionList;
	onPreview?: (value: string) => void;
	onPreviewCancel?: (originalValue: string) => void;
}

export interface TextInputSettingDef extends BaseSettingDef {
	type: "text";
}

export type SettingDef = BooleanSettingDef | EnumSettingDef | SubmenuSettingDef | TextInputSettingDef;

// ═══════════════════════════════════════════════════════════════════════════
// Condition Functions
// ═══════════════════════════════════════════════════════════════════════════

const CONDITIONS: Record<string, () => boolean> = {
	hasImageProtocol: () => !!TERMINAL.imageProtocol,
	advisorEnabled: () => {
		try {
			return Settings.instance.get("advisor.enabled") === true;
		} catch {
			return false;
		}
	},
	hindsightActive: () => {
		try {
			return Settings.instance.get("memory.backend") === "hindsight";
		} catch {
			return false;
		}
	},
	mnemopiActive: () => {
		try {
			return Settings.instance.get("memory.backend") === "mnemopi";
		} catch {
			return false;
		}
	},
	autolearnActive: () => {
		try {
			return Settings.instance.get("autolearn.enabled") === true;
		} catch {
			return false;
		}
	},
	autoThinkingActive: () => {
		try {
			return Settings.instance.get("defaultThinkingLevel") === "auto";
		} catch {
			return false;
		}
	},
	skillDiscoverySearchActive: () => {
		try {
			return Settings.instance.get("skills.discoveryMode") === "search";
		} catch {
			return false;
		}
	},
	planModeEnabled: () => {
		try {
			return Settings.instance.get("plan.enabled");
		} catch {
			return false;
		}
	},
};

// ═══════════════════════════════════════════════════════════════════════════
// Schema to UI Conversion
// ═══════════════════════════════════════════════════════════════════════════

function resolveOptions(ui: AnyUiMetadata): OptionList | "runtime" | undefined {
	if (!ui.options) return undefined;
	if (ui.options === "runtime") return "runtime";
	return ui.options;
}

function pathToSettingDef(path: SettingPath): SettingDef | null {
	const ui = getUi(path);
	if (!ui) return null;

	const schemaType = getType(path);
	const condition = ui.condition ? CONDITIONS[ui.condition] : undefined;
	const base = { path, label: ui.label, description: ui.description, tab: ui.tab, group: ui.group, condition };

	if (schemaType === "boolean") {
		return { ...base, type: "boolean" };
	}

	const options = resolveOptions(ui);

	if (schemaType === "enum") {
		if (options === undefined) {
			return { ...base, type: "enum", values: getEnumValues(path) ?? [] };
		}
		// "runtime" is not a valid sentinel for enums — schema types prevent this,
		// but treat defensively as an empty submenu.
		return { ...base, type: "submenu", options: options === "runtime" ? [] : options };
	}

	if (schemaType === "number") {
		// Numbers without options are intentionally hidden from the UI.
		if (!options || options === "runtime") return null;
		return { ...base, type: "submenu", options };
	}

	if (schemaType === "string") {
		if (options === "runtime") {
			// Empty list now; the selector layer (theme handling, etc.) injects choices.
			return { ...base, type: "submenu", options: [] };
		}
		if (options) {
			return { ...base, type: "submenu", options };
		}
		return { ...base, type: "text" };
	}

	if (schemaType === "array") {
		// Arrays render as comma-separated text inputs.
		return { ...base, type: "text" };
	}

	return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/** Cache of generated definitions */
let cachedDefs: SettingDef[] | null = null;

/** Get all setting definitions with UI */
export function getAllSettingDefs(): SettingDef[] {
	if (cachedDefs) return cachedDefs;

	const defs: SettingDef[] = [];
	for (const tab of SETTING_TABS) {
		for (const path of getPathsForTab(tab)) {
			const def = pathToSettingDef(path);
			if (def) defs.push(def);
		}
	}
	cachedDefs = defs;
	return defs;
}

/**
 * Get settings for a specific tab, ordered by the tab's group layout
 * (TAB_GROUPS). Ungrouped settings sort first; within a group, schema
 * declaration order is preserved.
 */
export function getSettingsForTab(tab: SettingTab): SettingDef[] {
	const defs = getAllSettingDefs().filter(def => def.tab === tab);
	const order = TAB_GROUPS[tab];
	const rank = (def: SettingDef): number => {
		if (!def.group) return -1;
		const index = order.indexOf(def.group);
		return index >= 0 ? index : order.length;
	};
	return defs.sort((a, b) => rank(a) - rank(b));
}

/** Get a setting definition by path */
export function getSettingDef(path: SettingPath): SettingDef | undefined {
	return getAllSettingDefs().find(def => def.path === path);
}

/** Get default value for display */
export function getDisplayDefault(path: SettingPath): string {
	const value = getDefault(path);
	if (value === undefined) return "";
	if (typeof value === "boolean") return value ? "true" : "false";
	return String(value);
}

/** Render an array setting (or any value) as comma-separated text-input content. */
export function formatSettingTextValue(value: unknown): string {
	if (Array.isArray(value)) return value.join(", ");
	return typeof value === "string" ? value : "";
}

/** Parse comma-separated text-input content back into a string array. */
export function parseSettingArrayText(value: string): string[] {
	return value
		.split(",")
		.map(item => item.trim())
		.filter(item => item.length > 0);
}
/** Result of ranking pool entries against the segment being typed in an array text input. */
export interface ArraySuggestState {
	/** Ranked candidates for the segment currently being typed (capped). */
	items: string[];
	/** Pool entries matched by the full comma list, after glob expansion. */
	matchCount: number;
	poolSize: number;
}

const GLOB_CHARS = /[*?[\]{}]/;

function globMatches(pattern: string, pool: readonly string[]): string[] {
	try {
		const glob = new Bun.Glob(pattern);
		return pool.filter(name => glob.match(name));
	} catch {
		return [];
	}
}

/**
 * Rank pool entries against the last (in-progress) segment of a comma-separated
 * array input, and count how many pool entries the full list currently matches.
 * Glob segments preview their actual matches; literal segments fuzzy-rank the
 * pool. Entries already covered by committed segments are not re-suggested.
 */
export function suggestArrayEntries(text: string, pool: readonly string[], limit = 5): ArraySuggestState {
	const lastComma = text.lastIndexOf(",");
	const typing = text.slice(lastComma + 1).trim();
	const committed = lastComma >= 0 ? parseSettingArrayText(text.slice(0, lastComma)) : [];

	const matched = new Set<string>();
	for (const segment of typing ? [...committed, typing] : committed) {
		for (const name of globMatches(segment, pool)) matched.add(name);
	}

	let items: string[] = [];
	if (typing) {
		const covered = new Set(committed.flatMap(segment => globMatches(segment, pool)));
		const open = pool.filter(name => !covered.has(name));
		items = GLOB_CHARS.test(typing)
			? globMatches(typing, open).sort().slice(0, limit)
			: fuzzyFilter(open, typing, name => name).slice(0, limit);
	}

	return { items, matchCount: matched.size, poolSize: pool.length };
}

/**
 * Replace the in-progress last segment with the accepted suggestion, normalizing
 * separators. The trailing ", " primes the next segment so the suggestion list
 * resets after an accept; saving strips it via parseSettingArrayText.
 */
export function applyArraySuggestion(text: string, item: string): string {
	const lastComma = text.lastIndexOf(",");
	const committed = lastComma >= 0 ? parseSettingArrayText(text.slice(0, lastComma)) : [];
	return `${[...committed, item].join(", ")}, `;
}
