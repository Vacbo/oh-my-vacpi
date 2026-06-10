import type { Settings } from "../config/settings";
import type { SettingValue } from "../config/settings-schema";

export const TOOL_DISCOVERY_AUTO_THRESHOLD = 40;
export const TOOL_DISCOVERY_SEARCH_TOOL_NAME = "search_tool_bm25";

export type ToolDiscoveryModeSetting = SettingValue<"tools.discoveryMode">;
export type EffectiveToolDiscoveryMode = Exclude<ToolDiscoveryModeSetting, "auto">;

export function countToolsForAutoDiscovery(toolNames: Iterable<string>): number {
	let count = 0;
	for (const name of toolNames) {
		if (name !== TOOL_DISCOVERY_SEARCH_TOOL_NAME) count++;
	}
	return count;
}

export function resolveEffectiveToolDiscoveryMode(settings: Settings, toolCount: number): EffectiveToolDiscoveryMode {
	const configuredMode = settings.get("tools.discoveryMode");
	if (configuredMode === "all" || configuredMode === "mcp-only") return configuredMode;
	if (settings.get("mcp.discoveryMode")) return "mcp-only";
	if (configuredMode === "auto" && toolCount > TOOL_DISCOVERY_AUTO_THRESHOLD) return "mcp-only";
	return "off";
}

/**
 * Skill discovery is a sibling knob to tool discovery: when `skills.discoveryMode === "search"`,
 * unpinned skills leave the system prompt `<skills>` listing and join the BM25 corpus instead.
 * It keeps `search_tool_bm25` alive even when tool discovery itself resolves to "off".
 */
export function isSkillDiscoverySearchMode(settings: Settings): boolean {
	return settings.get("skills.discoveryMode") === "search";
}
