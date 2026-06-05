/**
 * Context inspector overlay (`/context full`).
 *
 * Renders a `ContextManifest` as a progressive, expandable tree: the system
 * prompt blocks, tool schemas, and every message, each drillable down to its
 * byte-for-byte content. It complements the `/context` summary, which answers
 * "what roughly fills the window"; this answers "show me exactly what is in
 * there". Scroll/selection mechanics mirror `SessionObserverOverlayComponent`.
 *
 * The overlay sizes itself from the TUI's live terminal height (`viewport`),
 * NOT `process.stdout.rows`: under the remote-control mirror those diverge, and
 * a mismatch made the compositor clip the header and flicker between frames.
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
import { replaceTabs, truncateToWidth } from "../../tools/render-utils";
import { type ThemeColor, theme } from "../theme/theme";
import type { ContextManifest, ManifestNode, ManifestNodeKind } from "../utils/context-manifest";
import { matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import { DynamicBorder } from "./dynamic-border";

/** Lines scrolled per PageUp/PageDown. */
const PAGE_SIZE = 15;
const GLYPH_EXPANDED = "▾";
const GLYPH_COLLAPSED = "▸";
const GLYPH_LEAF = "·";
const USAGE_BAR_WIDTH = 28;

/** Live terminal dimensions, read each frame so the overlay matches the compositor. */
export interface InspectorViewport {
	readonly rows: number;
	readonly columns: number;
}

/** A selectable node mapped to its span in the flattened render lines. */
interface NodeRow {
	id: string;
	depth: number;
	lineStart: number;
	lineCount: number;
}

/** Label color per node kind, so the tree reads as a hierarchy rather than a wall of text. */
const KIND_COLOR: Record<ManifestNodeKind, ThemeColor> = {
	root: "accent",
	group: "accent",
	promptBlock: "toolTitle",
	section: "customMessageLabel",
	skill: "success",
	tool: "warning",
	message: "userMessageText",
	messagePart: "muted",
	file: "statusLinePath",
};

function formatPercent(fraction: number): string {
	const value = fraction * 100;
	if (value > 0 && value < 0.1) return "<0.1%";
	return `${value.toFixed(1)}%`;
}

export class ContextInspectorOverlayComponent extends Container {
	#root: ManifestNode;
	#summary: ContextManifest["summary"];
	#onDone: () => void;
	#viewport: InspectorViewport | undefined;

	#expanded: Set<string>;
	#selectedIndex = 0;
	#scrollOffset = 0;
	#viewportHeight = 20;
	#lastWidth = 0;

	#renderedLines: string[] = [];
	#nodeRows: NodeRow[] = [];
	#headerLines: string[] = [];
	#footerLines: string[] = [];

	constructor(manifest: ContextManifest, onDone: () => void, viewport?: InspectorViewport) {
		super();
		this.#root = manifest.root;
		this.#summary = manifest.summary;
		this.#onDone = onDone;
		this.#viewport = viewport;
		this.#expanded = new Set<string>();
		this.#seedDefaultExpanded(this.#root);
		this.#lastWidth = this.#termWidth();
		this.#rebuild();
	}

	#termWidth(): number {
		return this.#viewport?.columns ?? process.stdout.columns ?? 80;
	}

	#termHeight(): number {
		return this.#viewport?.rows ?? process.stdout.rows ?? 40;
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
		const termHeight = this.#termHeight();
		const headerChrome = this.#headerLines.length + 2;
		const footerChrome = this.#footerLines.length + 2;
		const maxViewport = Math.max(1, termHeight - headerChrome - footerChrome);
		// Size to content (no blank padding): under the remote-control mirror
		// `terminal.rows` over-reports the real window, and padding to it inflated
		// the overlay past the visible area, clipping the header at the top.
		this.#viewportHeight = Math.min(this.#renderedLines.length, maxViewport);

		const maxScroll = Math.max(0, this.#renderedLines.length - this.#viewportHeight);
		this.#scrollOffset = Math.max(0, Math.min(this.#scrollOffset, maxScroll));

		const lines: string[] = [];
		lines.push(...new DynamicBorder().render(width));
		for (const hl of this.#headerLines) lines.push(` ${hl}`);
		lines.push(...new DynamicBorder().render(width));

		const visible = this.#renderedLines.slice(this.#scrollOffset, this.#scrollOffset + this.#viewportHeight);
		for (const vl of visible) lines.push(` ${vl}`);

		const scrollInfo =
			this.#renderedLines.length > this.#viewportHeight
				? theme.fg(
						"dim",
						`  [${this.#scrollOffset + 1}-${Math.min(this.#scrollOffset + this.#viewportHeight, this.#renderedLines.length)}/${this.#renderedLines.length}]`,
					)
				: "";
		lines.push("");
		lines.push(` ${this.#footerLines[0] ?? ""}${scrollInfo}`);
		for (let i = 1; i < this.#footerLines.length; i++) lines.push(` ${this.#footerLines[i]}`);
		lines.push(...new DynamicBorder().render(width));
		return lines;
	}

	#rebuild(): void {
		this.#headerLines = this.#buildHeaderLines();
		this.#renderedLines = [];
		this.#nodeRows = [];
		this.#appendNode(this.#root, "", true, 0);
		if (this.#selectedIndex >= this.#nodeRows.length) this.#selectedIndex = Math.max(0, this.#nodeRows.length - 1);
		this.#footerLines = this.#buildFooterLines();
	}

	#buildHeaderLines(): string[] {
		const s = this.#summary;
		const usedPct = s.contextWindow > 0 ? s.usedTokens / s.contextWindow : 0;
		const title = `${theme.bold(s.modelName)}${theme.fg("dim", ` · ${formatNumber(s.contextWindow)} ctx`)}`;
		const bufferNote =
			s.autoCompactBufferTokens > 0 ? theme.fg("muted", ` · buffer ${formatNumber(s.autoCompactBufferTokens)}`) : "";
		const stats =
			`${this.#usageBar()}  ${theme.bold(formatNumber(s.usedTokens))}${theme.fg("dim", ` used ${formatPercent(usedPct)}`)}` +
			`${theme.fg("muted", ` · free ${formatNumber(s.freeTokens)}`)}${bufferNote}`;
		return [title, stats];
	}

	#usageBar(): string {
		const s = this.#summary;
		const win = s.contextWindow > 0 ? s.contextWindow : 1;
		const used = Math.round((s.usedTokens / win) * USAGE_BAR_WIDTH);
		const buffer = Math.round((s.autoCompactBufferTokens / win) * USAGE_BAR_WIDTH);
		const usedCells = Math.min(USAGE_BAR_WIDTH, used);
		const bufferCells = Math.min(USAGE_BAR_WIDTH - usedCells, buffer);
		const freeCells = Math.max(0, USAGE_BAR_WIDTH - usedCells - bufferCells);
		return (
			theme.fg("accent", "█".repeat(usedCells)) +
			theme.fg("warning", "█".repeat(bufferCells)) +
			theme.fg("dim", "░".repeat(freeCells))
		);
	}

	#buildFooterLines(): string[] {
		const hints: Array<[string, string]> = [
			["j/k", "move"],
			["⏎/→", "expand"],
			["←", "collapse"],
			["g/G", "ends"],
			["E/C", "all/default"],
			["esc", "close"],
		];
		const hintLine = hints
			.map(([key, desc]) => `${theme.fg("accent", key)}${theme.fg("dim", ` ${desc}`)}`)
			.join(theme.fg("dim", "  ·  "));

		const lines = [hintLine];
		const node = this.#selectedNode();
		if (node) {
			const raw = node.content != null && !(node.children && node.children.length > 0);
			const path = theme.fg("muted", node.id);
			const size = theme.fg("dim", `${formatNumber(node.bytes)} bytes · ${formatNumber(node.tokens)} tok`);
			const rawTag = raw ? theme.fg("success", " · raw content") : "";
			lines.push(`${path}  ${size}${rawTag}`);
		}
		return lines;
	}

	#appendNode(node: ManifestNode, basePrefix: string, isLast: boolean, depth: number): void {
		const rowIndex = this.#nodeRows.length;
		const isSelected = rowIndex === this.#selectedIndex;
		const hasChildren = (node.children?.length ?? 0) > 0;
		const expandable = hasChildren || node.content != null;
		const expanded = this.#expanded.has(node.id);

		const connector = depth === 0 ? "" : `${isLast ? "└" : "├"}─ `;
		const headerPrefix = basePrefix + connector;
		const childBase = depth === 0 ? "" : basePrefix + (isLast ? "   " : "│  ");

		const lineStart = this.#renderedLines.length;
		this.#renderedLines.push(this.#renderHeaderLine(node, headerPrefix, expandable, expanded, isSelected));
		let lineCount = 1;

		if (expanded && !hasChildren && node.content != null) {
			const contentLines = this.#renderContentLines(node.content, childBase);
			this.#renderedLines.push(...contentLines);
			lineCount += contentLines.length;
		}

		this.#nodeRows.push({ id: node.id, depth, lineStart, lineCount });

		if (expanded && hasChildren) {
			const children = node.children ?? [];
			for (let i = 0; i < children.length; i++) {
				this.#appendNode(children[i], childBase, i === children.length - 1, depth + 1);
			}
		}
	}

	#renderHeaderLine(
		node: ManifestNode,
		prefix: string,
		expandable: boolean,
		expanded: boolean,
		isSelected: boolean,
	): string {
		const glyph = expandable ? (expanded ? GLYPH_EXPANDED : GLYPH_COLLAPSED) : GLYPH_LEAF;
		const labelColor = KIND_COLOR[node.kind];
		const label =
			node.kind === "messagePart" ? theme.fg(labelColor, node.label) : theme.bold(theme.fg(labelColor, node.label));
		const detail = node.detail ? theme.fg("dim", ` ${node.detail}`) : "";
		const left = `${theme.fg("dim", prefix)}${theme.fg("dim", glyph)} ${label}${detail}`;
		// Primary metric is share of USED context (node.tokens / usedTokens), so the
		// tree answers "what is filling the context I am actually paying for"; the
		// window share (· N% ctx) is the dim secondary.
		const pctUsed = this.#summary.usedTokens > 0 ? node.tokens / this.#summary.usedTokens : 0;
		const metrics =
			`${theme.fg("muted", `${formatNumber(node.tokens)} tok`)} ${theme.fg("dim", "·")} ` +
			`${theme.fg("text", formatPercent(pctUsed))} ${theme.fg("dim", `· ${formatPercent(node.percentOfWindow)} ctx`)}`;

		const avail = Math.max(10, this.#lastWidth - 1);
		const metricsWidth = Bun.stringWidth(metrics);
		const leftBudget = Math.max(0, avail - metricsWidth - 1);
		let leftFitted = left;
		if (Bun.stringWidth(left) > leftBudget) leftFitted = truncateToWidth(left, leftBudget);
		const pad = Math.max(1, avail - Bun.stringWidth(leftFitted) - metricsWidth);
		const row = `${leftFitted}${" ".repeat(pad)}${metrics}`;

		if (!isSelected) return row;
		const padded = row + " ".repeat(Math.max(0, avail - Bun.stringWidth(row)));
		return theme.bg("selectedBg", padded);
	}

	#renderContentLines(content: string, childBase: string): string[] {
		const gutter = `${childBase}│ `;
		const width = Math.max(20, this.#lastWidth - Bun.stringWidth(gutter) - 1);
		const styledGutter = theme.fg("dim", gutter);
		const out: string[] = [];
		for (const rawLine of content.split("\n")) {
			const styled = this.#styleContentLine(replaceTabs(rawLine));
			const wrapped = Bun.wrapAnsi(styled, width, { hard: true, trim: false });
			for (const sub of wrapped.split("\n")) out.push(`${styledGutter}${sub}`);
		}
		return out;
	}

	/**
	 * Light, byte-faithful syntax accents for raw leaf content: brighten the base
	 * text and tint the structural markers (markdown headings, XML-ish tags, list
	 * bullets) so a wall of prompt text is scannable without full markdown reflow.
	 */
	#styleContentLine(line: string): string {
		const trimmed = line.trimStart();
		if (/^#{1,6}\s/.test(trimmed)) return theme.bold(theme.fg("mdHeading", line));
		if (trimmed.startsWith("<") && /^<\/?[a-zA-Z][\w-]*(\s[^>]*)?\/?>?/.test(trimmed)) {
			return theme.fg("customMessageLabel", line);
		}
		const bullet = /^(\s*)([-*+]|\d+\.)(\s.*)$/.exec(line);
		if (bullet) return `${bullet[1]}${theme.fg("accent", bullet[2])}${theme.fg("text", bullet[3])}`;
		return theme.fg("text", line);
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

	#selectedNode(): ManifestNode | undefined {
		const row = this.#nodeRows[this.#selectedIndex];
		return row ? this.#findNode(row.id) : undefined;
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
