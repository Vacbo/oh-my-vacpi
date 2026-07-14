/**
 * ToolsDashboard - Tool Control Center (/tools).
 *
 * Same UI backend as the Extension Control Center: source tabs, inventory
 * list with Space-to-toggle, inspector pane with description and arguments.
 * Rows cover every built-in tool (toggleable; persisted to
 * `tools.disabledTools`) plus the session's MCP and custom/extension tools
 * (shown for reference; managed from /extensions).
 *
 * Navigation:
 * - Left/Right or Tab/Shift+Tab: cycle source tabs
 * - Up/Down/j/k: navigate list
 * - Space/Enter: toggle selected built-in tool
 * - Esc: close (clears search first if active)
 */

import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { Container, matchesKey, Spacer, Text, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../../../config/settings";
import { DynamicBorder } from "../../../modes/components/dynamic-border";
import { theme } from "../../../modes/theme/theme";
import { matchesAppInterrupt } from "../../../modes/utils/keybinding-matchers";
import { isMCPToolName } from "../../../tool-discovery/tool-index";
import {
	BUILTIN_TOOLS,
	computeEssentialBuiltinNames,
	DEFAULT_ESSENTIAL_TOOL_NAMES,
	HIDDEN_TOOLS,
	type Tool,
} from "../../../tools";
import { replaceTabs } from "../../../tools/render-utils";
import { TwoColumnBody } from "./extension-dashboard";
import { ExtensionList } from "./extension-list";
import { type InspectorMeta, InspectorPanel } from "./inspector-panel";
import { applyFilter, filterByProvider } from "./state-manager";
import type { Extension, ProviderTab } from "./types";

const TOOLS_FOOTER = " ↑/↓: navigate  Space: toggle  ^p: pin  ←/→: source  Esc: close";

/** How a tool relates to the running session. */
export type ToolAvailability = "active" | "available" | "not loaded";

export type ToolOrigin = "builtin" | "mcp" | "custom";

const ORIGIN_SOURCE: Record<ToolOrigin, Extension["source"]> = {
	builtin: { provider: "builtin", providerName: "Built-in", level: "native" },
	mcp: { provider: "mcp", providerName: "MCP", level: "user" },
	custom: { provider: "custom", providerName: "Custom / Extension", level: "user" },
};

/** Maximum characters of a tool description shown in the inspector blurb. */
const BLURB_MAX_CHARS = 480;

/** Narrow session surface the dashboard needs (structurally satisfied by AgentSession). */
export interface ToolsDashboardSession {
	getAllToolNames(): string[];
	getActiveToolNames(): string[];
	getToolByName(name: string): Tool | undefined;
	setActiveToolsByName(toolNames: string[]): Promise<void>;
}

/** Toggle a tool name in a `tools.disabledTools` list; returns a sorted copy. */
export function toggleDisabledTool(disabled: readonly string[], name: string, enabled: boolean): string[] {
	const next = new Set(disabled);
	if (enabled) {
		next.delete(name);
	} else {
		next.add(name);
	}
	return [...next].sort();
}

/**
 * Toggle a built-in in `tools.essentialOverride` (pin = always loaded at session
 * start). An empty override means the default essential set, so the first
 * toggle materializes the defaults before applying; a result equal to the default
 * set normalizes back to `[]` ("leave empty to use defaults").
 */
export function toggleEssentialTool(override: readonly string[], name: string): string[] {
	const effective = new Set(override.length > 0 ? override : DEFAULT_ESSENTIAL_TOOL_NAMES);
	if (effective.has(name)) {
		effective.delete(name);
	} else {
		effective.add(name);
	}
	const next = [...effective].sort();
	const defaults = [...DEFAULT_ESSENTIAL_TOOL_NAMES].sort();
	const isDefault = next.length === defaults.length && next.every((entry, i) => entry === defaults[i]);
	return isDefault ? [] : next;
}

/** First paragraph of the tool description (or its discovery summary), flattened for the inspector. */
function toolBlurb(tool: Tool | undefined): string | undefined {
	if (!tool) return undefined;
	if (tool.summary) return replaceTabs(tool.summary);
	const description = tool.description?.trim();
	if (!description) return undefined;
	const paragraph = replaceTabs(
		description
			.split(/\n\s*\n/, 1)[0]
			.replace(/\s+/gu, " ")
			.trim(),
	);
	return paragraph.length > BLURB_MAX_CHARS ? `${paragraph.slice(0, BLURB_MAX_CHARS - 1)}…` : paragraph;
}

/** JSON-schema shape for the inspector's argument table; undefined when conversion fails. */
function toolArgsPreview(tool: Tool | undefined): unknown {
	if (!tool) return undefined;
	try {
		return { parameters: toolWireSchema(tool) };
	} catch {
		return undefined;
	}
}

function classifyOrigin(name: string): ToolOrigin {
	if (name in BUILTIN_TOOLS) return "builtin";
	if (isMCPToolName(name)) return "mcp";
	return "custom";
}

/** Whether a label adds information beyond the tool name (ignoring case and separators). */
function labelDiffers(name: string, label: string | undefined): label is string {
	if (!label) return false;
	const normalize = (value: string) => value.replace(/[^a-z0-9]/giu, "").toLowerCase();
	return normalize(label) !== normalize(name);
}

/**
 * Build dashboard rows: every built-in tool (even ones not loaded in this
 * session) plus all other registered session tools, as Extension-shaped items.
 */
export function buildToolRows(session: ToolsDashboardSession, disabledTools: readonly string[]): Extension[] {
	const disabled = new Set(disabledTools);
	const activeNames = new Set(session.getActiveToolNames());

	const toRow = (name: string, origin: ToolOrigin): Extension => {
		const tool = session.getToolByName(name);
		const label = tool?.label;
		const isDisabled = origin === "builtin" && disabled.has(name);
		const availability: ToolAvailability = activeNames.has(name) ? "active" : tool ? "available" : "not loaded";
		return {
			id: `tool:${name}`,
			kind: "tool",
			name,
			displayName: labelDiffers(name, label) ? `${name} (${label})` : name,
			description: toolBlurb(tool),
			trigger: availability,
			path: "",
			source: ORIGIN_SOURCE[origin],
			state: isDisabled ? "disabled" : "active",
			disabledReason: isDisabled ? "item-disabled" : undefined,
			raw: toolArgsPreview(tool),
		};
	};

	const builtinNames = Object.keys(BUILTIN_TOOLS).sort();
	const otherNames = session
		.getAllToolNames()
		// Hidden/internal tools (resolve, yield, report_*) are infrastructure, not user-facing rows.
		.filter(name => !(name in BUILTIN_TOOLS) && !(name in HIDDEN_TOOLS))
		.sort();
	return [
		...builtinNames.map(name => toRow(name, "builtin")),
		...otherNames.map(name => toRow(name, classifyOrigin(name))),
	];
}

export class ToolsDashboard extends Container {
	#rows: Extension[] = [];
	#tabs: ProviderTab[] = [];
	#activeTabIndex = 0;
	#tabFiltered: Extension[] = [];
	#searchFiltered: Extension[] = [];
	#searchQuery = "";
	#selected: Extension | null = null;
	#mainList!: ExtensionList;
	#inspector!: InspectorPanel;
	#builtRows = -1;
	#builtCols = -1;

	onClose?: () => void;
	onRequestRender?: () => void;

	private constructor(
		private readonly session: ToolsDashboardSession,
		private readonly settings: Settings,
		private readonly terminalHeight: number,
	) {
		super();
	}

	static create(session: ToolsDashboardSession, settings: Settings, terminalHeight?: number): ToolsDashboard {
		const dashboard = new ToolsDashboard(session, settings, terminalHeight ?? process.stdout.rows ?? 24);
		dashboard.#init();
		return dashboard;
	}

	#disabledTools(): string[] {
		return this.settings.get("tools.disabledTools") ?? [];
	}

	#init(): void {
		this.#rows = buildToolRows(this.session, this.#disabledTools());
		this.#tabs = this.#buildTabs(this.#rows);
		this.#tabFiltered = this.#rows;
		this.#searchFiltered = this.#rows;
		this.#selected = this.#rows[0] ?? null;

		this.#mainList = new ExtensionList(
			this.#searchFiltered,
			{
				onSelectionChange: ext => {
					this.#selected = ext;
					this.#inspector.setExtension(ext, this.#inspectorMeta(ext));
				},
				onToggle: (extensionId, enabled) => {
					this.#handleToolToggle(extensionId, enabled);
				},
				isPinned: ext => this.#isEssential(ext),
				onPinToggle: ext => this.#handlePinToggle(ext),
				masterSwitchProvider: null,
			},
			this.#maxVisibleItems(),
		);
		this.#mainList.setFocused(true);

		this.#inspector = new InspectorPanel();
		this.#inspector.setExtension(this.#selected, this.#inspectorMeta(this.#selected));

		this.#buildLayout();
	}

	#buildTabs(rows: Extension[]): ProviderTab[] {
		const counts = new Map<string, number>();
		for (const row of rows) {
			counts.set(row.source.provider, (counts.get(row.source.provider) ?? 0) + 1);
		}
		const tabs: ProviderTab[] = [{ id: "all", label: "All", enabled: true, count: rows.length }];
		for (const origin of ["builtin", "mcp", "custom"] as const) {
			const count = counts.get(origin) ?? 0;
			if (count > 0) {
				tabs.push({ id: origin, label: ORIGIN_SOURCE[origin].providerName, enabled: true, count });
			}
		}
		return tabs;
	}

	/** Built-in tools pinned as always-loaded (tools.essentialOverride; empty = read/bash/edit). */
	#isEssential(ext: Extension): boolean {
		return ext.source.provider === "builtin" && computeEssentialBuiltinNames(this.settings).includes(ext.name);
	}

	#inspectorMeta(ext: Extension | null): InspectorMeta {
		if (!ext) return {};
		const origin = ext.source.provider as ToolOrigin;
		if (origin === "mcp") return { statusNote: "MCP server tool. Manage it from its server entry in /extensions." };
		if (origin === "custom") {
			return { statusNote: "Provided by an extension or custom tool file. Manage it in /extensions." };
		}
		const pinned = this.#isEssential(ext);
		const pinMeta: InspectorMeta = {
			pinned,
			pinnedNote: pinned
				? "always loaded at session start (tools.essentialOverride)"
				: 'loads on demand when tools.discoveryMode hides built-ins ("all")',
		};
		return { ...pinMeta, ...this.#availabilityNote(ext) };
	}

	#availabilityNote(ext: Extension): { statusNote?: string } {
		const inRegistry = this.session.getToolByName(ext.name) !== undefined;
		if (ext.state === "disabled") {
			return {
				statusNote: inRegistry
					? "Excluded from new sessions; re-enabling activates it in this session."
					: "Excluded from new sessions. Re-enabling applies at next session start.",
			};
		}
		switch (ext.trigger as ToolAvailability) {
			case "active":
				return { statusNote: "Active in this session." };
			case "available":
				return { statusNote: "Loaded but hidden; the model activates it on demand via search_tool_bm25." };
			default:
				return {
					statusNote: "Not loaded in this session (config-gated or unavailable); changes apply to new sessions.",
				};
		}
	}

	#handlePinToggle(ext: Extension): void {
		// Pinning maps to tools.essentialOverride, which only governs built-ins.
		if (ext.source.provider !== "builtin") return;
		this.settings.set(
			"tools.essentialOverride",
			toggleEssentialTool(this.settings.get("tools.essentialOverride") ?? [], ext.name),
		);
		this.#rebuildRows();
	}

	/** Live terminal height so the dashboard tracks resize while open. */
	#terminalRows(): number {
		return process.stdout.rows || this.terminalHeight || 24;
	}

	#uiWidth(): number {
		return Math.max(20, process.stdout.columns || 80);
	}

	#footerLines(): number {
		return Math.max(1, wrapTextWithAnsi(theme.fg("dim", TOOLS_FOOTER), this.#uiWidth()).length);
	}

	/** Height budget for the two-column body, sized to the live terminal. */
	#computeBodyHeight(): number {
		// Chrome: top border + title + tab bar + spacer (4), then spacer + footer + bottom border.
		const chrome = 4 + 1 + this.#footerLines() + 1;
		return Math.max(5, this.#terminalRows() - chrome);
	}

	#maxVisibleItems(): number {
		// List chrome inside the body: search line, blank line, scroll indicator.
		return Math.max(3, this.#computeBodyHeight() - 3);
	}

	override render(width: number): readonly string[] {
		if (this.#terminalRows() !== this.#builtRows || this.#uiWidth() !== this.#builtCols) {
			this.#buildLayout();
		}
		const rendered = super.render(width);
		// Pad to the full viewport so the dashboard covers the screen. Render
		// results are component-owned and immutable — copy before padding.
		const rows = this.#terminalRows();
		if (rendered.length >= rows) return rendered;
		const lines = rendered.slice();
		while (lines.length < rows) lines.push("");
		return lines;
	}

	#buildLayout(): void {
		this.clear();
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold(theme.fg("accent", " Tool Control Center")), 0, 0));
		this.addChild(new Text(this.#renderTabBar(), 0, 0));
		this.addChild(new Spacer(1));

		const bodyMaxHeight = this.#computeBodyHeight();
		this.#mainList.setMaxVisible(this.#maxVisibleItems());
		this.addChild(new TwoColumnBody(this.#mainList, this.#inspector, bodyMaxHeight));

		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", TOOLS_FOOTER), 0, 0));
		this.addChild(new DynamicBorder());
		this.#builtRows = this.#terminalRows();
		this.#builtCols = this.#uiWidth();
	}

	#renderTabBar(): string {
		const parts: string[] = [" "];
		for (let i = 0; i < this.#tabs.length; i++) {
			const tab = this.#tabs[i];
			const label = tab.count > 0 ? `${tab.label} (${tab.count})` : tab.label;
			if (i === this.#activeTabIndex) {
				parts.push(theme.bg("selectedBg", ` ${label} `));
			} else {
				parts.push(theme.fg("muted", ` ${label} `));
			}
		}
		return parts.join("");
	}

	#activeTabId(): string {
		return this.#tabs[this.#activeTabIndex]?.id ?? "all";
	}

	#handleToolToggle(extensionId: string, enabled: boolean): void {
		const row = this.#rows.find(ext => ext.id === extensionId);
		// MCP and custom tools are managed from /extensions; ignore toggles here.
		if (row?.source.provider !== "builtin") return;

		this.settings.set("tools.disabledTools", toggleDisabledTool(this.#disabledTools(), row.name, enabled));
		void this.#applyLiveToolChange(row.name, enabled);
		this.#rebuildRows();
	}

	/**
	 * Best-effort live sync of the running session: deactivate a disabled tool
	 * immediately, and reactivate an enabled one while its instance is still in
	 * the session registry. New sessions pick the setting up via createTools.
	 */
	async #applyLiveToolChange(name: string, enabled: boolean): Promise<void> {
		try {
			const active = this.session.getActiveToolNames();
			if (!enabled && active.includes(name)) {
				await this.session.setActiveToolsByName(active.filter(n => n !== name));
			} else if (enabled && !active.includes(name) && this.session.getToolByName(name)) {
				await this.session.setActiveToolsByName([...active, name]);
			}
		} catch (error) {
			logger.warn("Failed to live-apply tool toggle", { name, enabled, error: String(error) });
		}
	}

	#rebuildRows(): void {
		const selectedId = this.#selected?.id;
		this.#rows = buildToolRows(this.session, this.#disabledTools());
		this.#tabs = this.#buildTabs(this.#rows);
		this.#activeTabIndex = Math.min(this.#activeTabIndex, this.#tabs.length - 1);
		this.#tabFiltered = filterByProvider(this.#rows, this.#activeTabId());
		this.#searchFiltered = applyFilter(this.#tabFiltered, this.#searchQuery);
		this.#mainList.setExtensions(this.#searchFiltered);
		this.#selected = this.#searchFiltered.find(ext => ext.id === selectedId) ?? this.#searchFiltered[0] ?? null;
		this.#inspector.setExtension(this.#selected, this.#inspectorMeta(this.#selected));
		this.#buildLayout();
		this.onRequestRender?.();
	}

	#switchTab(direction: 1 | -1): void {
		const numTabs = this.#tabs.length;
		if (numTabs === 0) return;
		this.#activeTabIndex = (this.#activeTabIndex + direction + numTabs) % numTabs;
		this.#tabFiltered = filterByProvider(this.#rows, this.#activeTabId());
		this.#searchFiltered = applyFilter(this.#tabFiltered, this.#searchQuery);
		this.#mainList.setExtensions(this.#searchFiltered);
		this.#mainList.resetSelection();
		this.#selected = this.#searchFiltered[0] ?? null;
		this.#inspector.setExtension(this.#selected, this.#inspectorMeta(this.#selected));
		this.#buildLayout();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c")) {
			this.onClose?.();
			return;
		}
		if (matchesAppInterrupt(data)) {
			if (this.#searchQuery.length > 0) {
				this.#searchQuery = "";
				this.#searchFiltered = this.#tabFiltered;
				this.#mainList.setExtensions(this.#searchFiltered);
				this.#mainList.clearSearch();
				this.#buildLayout();
				return;
			}
			this.onClose?.();
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "right")) {
			this.#switchTab(1);
			return;
		}
		if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) {
			this.#switchTab(-1);
			return;
		}

		this.#mainList.handleInput(data);

		const query = this.#mainList.getSearchQuery();
		if (query !== this.#searchQuery) {
			this.#searchQuery = query;
			this.#searchFiltered = applyFilter(this.#tabFiltered, query);
		}
	}
}
