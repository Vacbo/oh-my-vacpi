/**
 * Context inspector overlay (`/context full`).
 *
 * Renders a `ContextManifest` as a progressive, expandable tree: the system
 * prompt blocks, tool schemas, and every message, each drillable down to its
 * byte-for-byte content. It complements the `/context` summary, which answers
 * "what roughly fills the window"; this answers "show me exactly what is in
 * there". Scroll/selection mechanics mirror `SessionObserverOverlayComponent`.
 *
 * Navigation:
 *   - j / ↓            move selection down a node
 *   - k / ↑            move selection up a node
 *   - Enter / Space    toggle expand/collapse (group children, or leaf content)
 *   - → / l            expand (or descend into first child)
 *   - ← / h            collapse (or jump to parent)
 *   - g / G            jump to top / bottom
 *   - E / C            expand all groups / collapse to the default view
 *   - PageUp/PageDown  scroll a page
 *   - Esc / q          close the overlay
 */
import { Container, matchesKey } from "@oh-my-pi/pi-tui";
import { formatNumber } from "@oh-my-pi/pi-utils";
import { replaceTabs } from "../../tools/render-utils";
import { theme } from "../theme/theme";
import type { ContextManifest, ManifestNode } from "../utils/context-manifest";
import { matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import { DynamicBorder } from "./dynamic-border";

/** Lines scrolled per PageUp/PageDown when selection cannot advance. */
const PAGE_SIZE = 15;
/** Two spaces of indent per tree depth. */
const INDENT_UNIT = "  ";

const GLYPH_EXPANDED = "▾";
const GLYPH_COLLAPSED = "▸";
const GLYPH_LEAF = "·";

/** A selectable node mapped to its span in the flattened render lines. */
interface NodeRow {
	id: string;
	depth: number;
	lineStart: number;
	lineCount: number;
}

function formatPercent(fraction: number): string {
	const value = fraction * 100;
	if (value > 0 && value < 0.1) return "<0.1%";
	return `${value.toFixed(1)}%`;
}

export class ContextInspectorOverlayComponent extends Container {
	#root: ManifestNode;
	#summary: ContextManifest["summary"];
	#onDone: () => void;

	#expanded: Set<string>;
	#selectedIndex = 0;
	#scrollOffset = 0;
	#viewportHeight = 20;
	#lastWidth = 0;

	#renderedLines: string[] = [];
	#nodeRows: NodeRow[] = [];
	#headerLines: string[] = [];
	#footerLines: string[] = [];

	constructor(manifest: ContextManifest, onDone: () => void) {
		super();
		this.#root = manifest.root;
		this.#summary = manifest.summary;
		this.#onDone = onDone;
		this.#expanded = new Set<string>();
		this.#seedDefaultExpanded(this.#root);
		this.#lastWidth = process.stdout.columns || 80;
		this.#rebuild();
	}

	#seedDefaultExpanded(node: ManifestNode): void {
		if (node.defaultExpanded) this.#expanded.add(node.id);
		for (const child of node.children ?? []) this.#seedDefaultExpanded(child);
	}

	override render(width: number): string[] {
		if (width !== this.#lastWidth) {
			this.#lastWidth = width;
			this.#rebuild();
		}
		const termHeight = process.stdout.rows || 40;
		const headerChrome = this.#headerLines.length + 2;
		const footerChrome = this.#footerLines.length + 2;
		this.#viewportHeight = Math.max(5, termHeight - headerChrome - footerChrome);

		const maxScroll = Math.max(0, this.#renderedLines.length - this.#viewportHeight);
		this.#scrollOffset = Math.max(0, Math.min(this.#scrollOffset, maxScroll));

		const lines: string[] = [];
		lines.push(...new DynamicBorder().render(width));
		for (const hl of this.#headerLines) lines.push(` ${hl}`);
		lines.push(...new DynamicBorder().render(width));

		const visible = this.#renderedLines.slice(this.#scrollOffset, this.#scrollOffset + this.#viewportHeight);
		for (const vl of visible) lines.push(` ${vl}`);
		for (let i = visible.length; i < this.#viewportHeight; i++) lines.push("");

		const scrollInfo =
			this.#renderedLines.length > this.#viewportHeight
				? ` ${theme.fg("dim", `[${this.#scrollOffset + 1}-${Math.min(this.#scrollOffset + this.#viewportHeight, this.#renderedLines.length)}/${this.#renderedLines.length}]`)}`
				: "";
		lines.push("");
		lines.push(` ${this.#footerLines[0] ?? ""}${scrollInfo}`);
		for (let i = 1; i < this.#footerLines.length; i++) lines.push(` ${this.#footerLines[i]}`);
		lines.push(...new DynamicBorder().render(width));
		return lines;
	}

	#rebuild(): void {
		const s = this.#summary;
		this.#headerLines = [
			`${theme.bold(s.modelName)}${theme.fg("dim", ` (${formatNumber(s.contextWindow)} ctx)`)}`,
			`${theme.bold(formatNumber(s.usedTokens))}${theme.fg("dim", ` used (${formatPercent(s.contextWindow > 0 ? s.usedTokens / s.contextWindow : 0)})`)}` +
				theme.fg("muted", ` · free ${formatNumber(s.freeTokens)}`),
		];

		this.#renderedLines = [];
		this.#nodeRows = [];
		this.#appendNode(this.#root, 0);

		if (this.#selectedIndex >= this.#nodeRows.length) this.#selectedIndex = Math.max(0, this.#nodeRows.length - 1);

		this.#footerLines = [
			theme.fg("dim", "j/k:move  Enter/→:expand  ←:collapse  g/G:top/bottom  E/C:all/default  Esc/q:close"),
		];
		const selected = this.#nodeRows[this.#selectedIndex];
		const node = selected ? this.#findNode(selected.id) : undefined;
		if (node) {
			const raw = node.content != null && !(node.children && node.children.length > 0);
			this.#footerLines.push(
				theme.fg("muted", `${node.id} · ${formatNumber(node.bytes)} bytes${raw ? " · raw content" : ""}`),
			);
		}
	}

	#appendNode(node: ManifestNode, depth: number): void {
		const rowIndex = this.#nodeRows.length;
		const isSelected = rowIndex === this.#selectedIndex;
		const hasChildren = (node.children?.length ?? 0) > 0;
		const expandable = hasChildren || node.content != null;
		const expanded = this.#expanded.has(node.id);

		const lineStart = this.#renderedLines.length;
		this.#renderedLines.push(this.#renderHeaderLine(node, depth, expandable, expanded, isSelected));
		let lineCount = 1;

		if (expanded && !hasChildren && node.content != null) {
			const contentLines = this.#renderContentLines(node.content, depth + 1);
			this.#renderedLines.push(...contentLines);
			lineCount += contentLines.length;
		}

		this.#nodeRows.push({ id: node.id, depth, lineStart, lineCount });

		if (expanded && hasChildren) {
			for (const child of node.children ?? []) this.#appendNode(child, depth + 1);
		}
	}

	#renderHeaderLine(
		node: ManifestNode,
		depth: number,
		expandable: boolean,
		expanded: boolean,
		isSelected: boolean,
	): string {
		const indent = INDENT_UNIT.repeat(depth);
		const glyph = expandable ? (expanded ? GLYPH_EXPANDED : GLYPH_COLLAPSED) : GLYPH_LEAF;
		const marker = isSelected ? theme.fg("accent", "❯ ") : "  ";
		const labelText = node.label;
		const label = isSelected ? theme.bold(theme.fg("accent", labelText)) : theme.bold(labelText);
		const detail = node.detail ? theme.fg("dim", ` ${node.detail}`) : "";
		const counts = theme.fg("muted", `  ${formatNumber(node.tokens)} tok · ${formatPercent(node.percentOfWindow)}`);
		return `${marker}${indent}${theme.fg("dim", glyph)} ${label}${detail}${counts}`;
	}

	#renderContentLines(content: string, depth: number): string[] {
		const indent = INDENT_UNIT.repeat(depth);
		const width = Math.max(20, this.#lastWidth - indent.length - 2);
		const out: string[] = [];
		for (const rawLine of content.split("\n")) {
			const safe = replaceTabs(rawLine);
			const wrapped = Bun.wrapAnsi(safe, width, { hard: true, trim: false });
			for (const sub of wrapped.split("\n")) out.push(`${indent}${theme.fg("toolOutput", sub)}`);
		}
		return out;
	}

	#findNode(id: string): ManifestNode | undefined {
		const stack: ManifestNode[] = [this.#root];
		while (stack.length > 0) {
			const node = stack.pop();
			if (!node) continue;
			if (node.id === id) return node;
			for (const child of node.children ?? []) stack.push(child);
		}
		return undefined;
	}

	handleInput(keyData: string): void {
		const rowCount = this.#nodeRows.length;

		if (matchesKey(keyData, "escape") || keyData === "q") {
			this.#onDone();
			return;
		}

		if (keyData === "j" || matchesSelectDown(keyData)) {
			this.#selectedIndex = Math.min(this.#selectedIndex + 1, Math.max(0, rowCount - 1));
			this.#rebuildAndScroll();
			return;
		}
		if (keyData === "k" || matchesSelectUp(keyData)) {
			this.#selectedIndex = Math.max(this.#selectedIndex - 1, 0);
			this.#rebuildAndScroll();
			return;
		}

		if (matchesKey(keyData, "enter") || keyData === "\r" || keyData === "\n" || keyData === " ") {
			this.#toggleSelected();
			return;
		}
		if (matchesKey(keyData, "right") || keyData === "l") {
			this.#expandOrDescend();
			return;
		}
		if (matchesKey(keyData, "left") || keyData === "h") {
			this.#collapseOrParent();
			return;
		}

		if (keyData === "g") {
			this.#selectedIndex = 0;
			this.#scrollOffset = 0;
			this.#rebuildAndScroll();
			return;
		}
		if (keyData === "G") {
			this.#selectedIndex = Math.max(0, rowCount - 1);
			this.#rebuildAndScroll();
			return;
		}
		if (keyData === "E") {
			this.#expandAllGroups(this.#root);
			this.#rebuildAndScroll();
			return;
		}
		if (keyData === "C") {
			this.#expanded.clear();
			this.#seedDefaultExpanded(this.#root);
			this.#selectedIndex = Math.min(this.#selectedIndex, Math.max(0, this.#countDefaultRows() - 1));
			this.#rebuildAndScroll();
			return;
		}

		if (matchesKey(keyData, "pageDown")) {
			this.#scrollOffset = Math.min(
				this.#scrollOffset + PAGE_SIZE,
				Math.max(0, this.#renderedLines.length - this.#viewportHeight),
			);
			return;
		}
		if (matchesKey(keyData, "pageUp")) {
			this.#scrollOffset = Math.max(this.#scrollOffset - PAGE_SIZE, 0);
			return;
		}
	}

	#selectedNode(): ManifestNode | undefined {
		const row = this.#nodeRows[this.#selectedIndex];
		return row ? this.#findNode(row.id) : undefined;
	}

	#toggleSelected(): void {
		const node = this.#selectedNode();
		if (!node) return;
		const expandable = (node.children?.length ?? 0) > 0 || node.content != null;
		if (!expandable) return;
		if (this.#expanded.has(node.id)) this.#expanded.delete(node.id);
		else this.#expanded.add(node.id);
		this.#rebuildAndScroll();
	}

	#expandOrDescend(): void {
		const node = this.#selectedNode();
		if (!node) return;
		const hasChildren = (node.children?.length ?? 0) > 0;
		const expandable = hasChildren || node.content != null;
		if (expandable && !this.#expanded.has(node.id)) {
			this.#expanded.add(node.id);
			this.#rebuildAndScroll();
			return;
		}
		// Already expanded with children: move into the first child.
		if (hasChildren && this.#expanded.has(node.id)) {
			this.#selectedIndex = Math.min(this.#selectedIndex + 1, Math.max(0, this.#nodeRows.length - 1));
			this.#rebuildAndScroll();
		}
	}

	#collapseOrParent(): void {
		const row = this.#nodeRows[this.#selectedIndex];
		const node = this.#selectedNode();
		if (!row || !node) return;
		if (this.#expanded.has(node.id)) {
			this.#expanded.delete(node.id);
			this.#rebuildAndScroll();
			return;
		}
		// Collapsed already: jump to the nearest shallower ancestor row.
		for (let i = this.#selectedIndex - 1; i >= 0; i--) {
			if (this.#nodeRows[i].depth < row.depth) {
				this.#selectedIndex = i;
				this.#rebuildAndScroll();
				return;
			}
		}
	}

	#expandAllGroups(node: ManifestNode): void {
		if ((node.children?.length ?? 0) > 0) {
			this.#expanded.add(node.id);
			for (const child of node.children ?? []) this.#expandAllGroups(child);
		}
	}

	#countDefaultRows(): number {
		let count = 0;
		const walk = (node: ManifestNode): void => {
			count++;
			if (node.defaultExpanded) for (const child of node.children ?? []) walk(child);
		};
		walk(this.#root);
		return count;
	}

	#rebuildAndScroll(): void {
		this.#rebuild();
		this.#scrollToSelected();
	}

	#scrollToSelected(): void {
		const row = this.#nodeRows[this.#selectedIndex];
		if (!row) return;
		const top = row.lineStart;
		const bottom = row.lineStart + row.lineCount;
		if (top < this.#scrollOffset) {
			this.#scrollOffset = Math.max(0, top - 1);
		} else if (bottom > this.#scrollOffset + this.#viewportHeight) {
			this.#scrollOffset = Math.max(0, bottom - this.#viewportHeight);
		}
	}
}
