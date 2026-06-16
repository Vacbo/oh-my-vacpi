/**
 * Context manifest: a renderer-agnostic tree describing, node by node, exactly
 * what the model sees this session (system prompt blocks, tool schemas, and
 * every conversation message). It is the single source of truth behind the
 * `/context full` inspector and the foundation for the harness-observability
 * read API, so it carries NO rendering concerns: every node holds its own
 * authoritative token/byte accounting and (for content leaves) byte-for-byte
 * content. Consumers display `node.tokens`/`node.bytes` as-is and never re-sum.
 *
 * Token accounting reuses the exact helpers behind the `/context` summary
 * (`estimateToolSchemaTokens`, `estimateTokens`, `countTokens`, and the same
 * auto-compaction reserve math) so the inspector's headline total matches that
 * panel without depending on the full `AgentSession` concrete type.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { CompactionSettings } from "@oh-my-pi/pi-agent-core/compaction";
import { effectiveReserveTokens, estimateTokens, resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, ImageContent, TextContent, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { countTokens } from "@oh-my-pi/pi-natives";
import type {
	BashExecutionMessage,
	BranchSummaryMessage,
	CompactionSummaryMessage,
	CustomMessage,
	FileMentionMessage,
	HookMessage,
	PythonExecutionMessage,
} from "../../session/messages";
import { estimateToolSchemaTokens } from "./context-usage";

/** Minimal live-session shape the manifest builder actually needs. */
export interface ContextManifestSkill {
	name: string;
	description: string;
	filePath?: string;
	source?: string;
}

export interface ContextManifestTool {
	name: string;
	description: string;
	parameters?: unknown;
}

export interface ContextManifestModel {
	id: string;
	name?: string;
	contextWindow: number;
}

export interface ContextManifestSession {
	systemPrompt?: readonly string[];
	agent?: {
		state?: {
			tools?: readonly ContextManifestTool[];
		};
	};
	skills?: readonly ContextManifestSkill[];
	model?: ContextManifestModel;
	settings: {
		getGroup(name: "compaction"): CompactionSettings;
	};
	messages?: readonly AgentMessage[];
}

export function toContextManifestSession(session: {
	systemPrompt?: readonly string[];
	agent?: {
		state?: {
			tools?: readonly { name: string; description?: string; parameters?: unknown }[];
		};
	};
	skills?: readonly { name: string; description?: string; filePath?: string; source?: string }[];
	model?: { id: string; name?: string; contextWindow: number | null };
	settings: {
		getGroup(name: "compaction"): CompactionSettings;
	};
	messages?: readonly AgentMessage[];
}): ContextManifestSession {
	return {
		systemPrompt: session.systemPrompt,
		agent: {
			state: {
				tools: (session.agent?.state?.tools ?? []).map(tool => ({
					name: tool.name,
					description: tool.description ?? "",
					parameters: tool.parameters,
				})),
			},
		},
		skills: (session.skills ?? []).map(skill => ({
			name: skill.name,
			description: skill.description ?? "",
			filePath: skill.filePath,
			source: skill.source,
		})),
		model: session.model
			? { id: session.model.id, name: session.model.name, contextWindow: session.model.contextWindow ?? 0 }
			: undefined,
		settings: session.settings,
		messages: session.messages,
	};
}
export type ManifestNodeKind =
	| "root"
	| "group"
	| "promptBlock"
	| "section"
	| "skill"
	| "tool"
	| "message"
	| "messagePart"
	| "file";

/**
 * One node in the context manifest tree.
 *
 * `tokens`/`bytes` are this node's OWN authoritative estimate, set at build
 * time. A group's value is computed from its members but is stored, not
 * recomputed by consumers; a node may also carry both `content` (authoritative
 * bytes) and `children` (a finer decomposition) where the children need not
 * sum exactly to the parent.
 */
export interface ManifestNode {
	/** Stable dotted id, unique within the tree. Keys expansion state and the read API. */
	id: string;
	/** Short, scannable label. Counts/percentages are appended by the renderer, not baked in. */
	label: string;
	/** Optional secondary descriptor (path, role, source, mime). */
	detail?: string;
	kind: ManifestNodeKind;
	/** Node's own authoritative token estimate. */
	tokens: number;
	/** Node's own authoritative UTF-8 byte size. */
	bytes: number;
	/** `tokens / contextWindow`, in [0, 1]; 0 when the window is unknown. */
	percentOfWindow: number;
	/** Byte-exact content for content leaves; absent on pure groups. */
	content?: string;
	/** Child nodes; absent or empty on leaves. */
	children?: ManifestNode[];
	/** Suggested initial expansion for a progressive renderer. */
	defaultExpanded?: boolean;
}

/** Window-level totals, sourced from the same breakdown the `/context` panel uses. */
export interface ManifestSummary {
	modelName: string;
	modelId: string;
	contextWindow: number;
	usedTokens: number;
	freeTokens: number;
	autoCompactBufferTokens: number;
}

/** Full manifest: the tree root plus window-level totals. */
export interface ContextManifest {
	root: ManifestNode;
	summary: ManifestSummary;
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function pct(tokens: number, window: number): number {
	return window > 0 ? tokens / window : 0;
}

/** Build a content leaf carrying byte-exact `content`. */
function makeLeaf(
	id: string,
	label: string,
	kind: ManifestNodeKind,
	content: string,
	tokens: number,
	window: number,
	detail?: string,
): ManifestNode {
	return {
		id,
		label,
		kind,
		detail,
		tokens,
		bytes: byteLength(content),
		percentOfWindow: pct(tokens, window),
		content,
	};
}

/** Sum the `bytes` field across nodes. */
function sumBytes(nodes: ManifestNode[]): number {
	let total = 0;
	for (const node of nodes) total += node.bytes;
	return total;
}

/** Sum the `tokens` field across nodes. */
function sumTokens(nodes: ManifestNode[]): number {
	let total = 0;
	for (const node of nodes) total += node.tokens;
	return total;
}

// ---------------------------------------------------------------------------
// System prompt block segmentation
// ---------------------------------------------------------------------------

const TAG_LABELS: Record<string, string> = {
	skills: "Skills",
	context: "Context files",
	"dir-context": "Directory rules",
	"workspace-tree": "Workspace tree",
	critical: "Critical rules",
	workstation: "Workstation",
	"system-conventions": "System conventions",
	completeness: "Completeness rules",
	yielding: "Yielding rules",
	workflow: "Workflow",
	"reply-guidelines": "Reply guidelines",
	"generic-rules": "Always-apply rules",
	"domain-rules": "Domain rules",
	"discovery-notice": "MCP discovery",
};

const HEADING_LABELS: Record<string, string> = {
	TOOLS: "Tools guidance",
	ENV: "Environment",
	CONTRACT: "Contract",
	PROJECT: "Project",
};

interface LineSpan {
	start: number;
	end: number;
	text: string;
}

/** Split text into lines with absolute [start, end) offsets; `text` excludes the trailing newline. */
function splitLinesWithOffsets(text: string): LineSpan[] {
	const lines: LineSpan[] = [];
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "\n") {
			lines.push({ start, end: i + 1, text: text.slice(start, i) });
			start = i + 1;
		}
	}
	if (start < text.length) {
		lines.push({ start, end: text.length, text: text.slice(start) });
	}
	return lines;
}

const OPEN_TAG_RE = /^<([a-z][a-z0-9-]*)>$/;
const HEADING_RE = /^[A-Z][A-Z0-9 /&-]{2,}$/;
const HEADING_RULE_RE = /^={3,}\s*$/;

interface BlockSegment {
	label: string;
	tag?: string;
	content: string;
}

/**
 * Tile a system-prompt block into contiguous, byte-exact segments at
 * recognized boundaries (`<tag>…</tag>` blocks and `WORD↵===` section
 * headers). Segments always concatenate back to the input exactly; an
 * unrecognized region simply becomes a prose segment labeled by its first
 * line. Returns a single whole-block segment when nothing is recognized.
 */
export function segmentPromptBlock(block: string): BlockSegment[] {
	const lines = splitLinesWithOffsets(block);
	const cuts = new Set<number>([0]);
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].text.trim();
		const tagMatch = OPEN_TAG_RE.exec(trimmed);
		if (tagMatch) {
			cuts.add(lines[i].start);
			const close = `</${tagMatch[1]}>`;
			for (let j = i + 1; j < lines.length; j++) {
				if (lines[j].text.trim() === close) {
					cuts.add(lines[j].end);
					break;
				}
			}
			continue;
		}
		if (HEADING_RE.test(lines[i].text) && i + 1 < lines.length && HEADING_RULE_RE.test(lines[i + 1].text)) {
			cuts.add(lines[i].start);
		}
	}

	const boundaries = [...cuts].sort((a, b) => a - b);
	boundaries.push(block.length);
	const segments: BlockSegment[] = [];
	for (let k = 0; k + 1 < boundaries.length; k++) {
		const content = block.slice(boundaries[k], boundaries[k + 1]);
		if (content.length === 0) continue;
		segments.push({ ...labelForSegment(content), content });
	}

	// Reversibility guard: never present a decomposition that loses bytes.
	if (segments.length === 0 || segments.map(s => s.content).join("") !== block) {
		return [{ label: "Full block", content: block }];
	}
	return segments;
}

function labelForSegment(content: string): { label: string; tag?: string } {
	let firstNonBlank = "";
	let firstNonBlankIdx = -1;
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim().length > 0) {
			firstNonBlank = lines[i];
			firstNonBlankIdx = i;
			break;
		}
	}
	const trimmed = firstNonBlank.trim();
	const tagMatch = OPEN_TAG_RE.exec(trimmed);
	if (tagMatch) {
		return { label: TAG_LABELS[tagMatch[1]] ?? tagMatch[1], tag: tagMatch[1] };
	}
	const next = firstNonBlankIdx >= 0 ? (lines[firstNonBlankIdx + 1] ?? "") : "";
	if (HEADING_RE.test(firstNonBlank) && HEADING_RULE_RE.test(next)) {
		return { label: HEADING_LABELS[trimmed] ?? toTitleCase(trimmed) };
	}
	return { label: truncateLabel(trimmed) || "Prose" };
}

function toTitleCase(word: string): string {
	return word.toLowerCase().replace(/(^|[\s/&-])([a-z])/g, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

function truncateLabel(text: string, max = 48): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

const SKILL_LINE_RE = /^- ([^:]+): (.+)$/;
const FILE_OPEN_RE = /^<file path="(.*)">$/;

/** Parse `<skills>` segment lines into per-skill leaves. Returns [] when none match. */
function skillSegmentChildren(
	idPrefix: string,
	content: string,
	window: number,
	skills: readonly ContextManifestSkill[],
): ManifestNode[] {
	const byName = new Map<string, ContextManifestSkill>();
	for (const skill of skills) byName.set(skill.name, skill);
	const children: ManifestNode[] = [];
	for (const rawLine of content.split("\n")) {
		const match = SKILL_LINE_RE.exec(rawLine.trim());
		if (!match) continue;
		const name = match[1].trim();
		const description = match[2].trim();
		const skill = byName.get(name);
		const tokens = countTokens([name, description]);
		children.push(
			makeLeaf(
				`${idPrefix}/skill-${children.length}`,
				name,
				"skill",
				rawLine,
				tokens,
				window,
				skill?.source ?? skill?.filePath,
			),
		);
	}
	return children;
}

/** Parse a `<context>` segment into per-file leaves. Returns [] when the structure does not pair cleanly. */
function contextSegmentChildren(idPrefix: string, content: string, window: number): ManifestNode[] {
	const lines = splitLinesWithOffsets(content);
	const children: ManifestNode[] = [];
	let i = 0;
	while (i < lines.length) {
		const open = FILE_OPEN_RE.exec(lines[i].text.trim());
		if (!open) {
			i++;
			continue;
		}
		const path = open[1];
		let close = -1;
		for (let j = i + 1; j < lines.length; j++) {
			if (lines[j].text.trim() === "</file>") {
				close = j;
				break;
			}
		}
		if (close < 0) break;
		const innerStart = lines[i].end;
		const innerEnd = lines[close].start;
		const fileContent = content.slice(innerStart, innerEnd).replace(/\n$/, "");
		children.push(
			makeLeaf(
				`${idPrefix}/file-${children.length}`,
				shortenLeadingPath(path),
				"file",
				fileContent,
				countTokens(fileContent),
				window,
				path,
			),
		);
		i = close + 1;
	}
	return children;
}

function shortenLeadingPath(path: string): string {
	const parts = path.split("/");
	return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}

function blockDetail(index: number, content: string): string {
	if (index === 0) return "main · system-prompt.md";
	if (index === 1 && /^PROJECT\s*\n=+/.test(content.trimStart())) return "project · project-prompt.md";
	return "appended / memory";
}

/** Build the "System prompt" group from the live session's prompt blocks. */
function buildSystemPromptGroup(
	blocks: readonly string[],
	window: number,
	skills: readonly ContextManifestSkill[],
): ManifestNode {
	const blockNodes: ManifestNode[] = blocks.map((block, index) => {
		const id = `sys/block-${index}`;
		const blockTokens = countTokens(block);
		const segments = segmentPromptBlock(block);
		if (segments.length <= 1) {
			return {
				...makeLeaf(id, `Block ${index + 1}`, "promptBlock", block, blockTokens, window, blockDetail(index, block)),
				defaultExpanded: true,
			};
		}
		const sectionNodes: ManifestNode[] = segments.map((segment, segIndex) => {
			const segId = `${id}/seg-${segIndex}`;
			const segTokens = countTokens(segment.content);
			let segChildren: ManifestNode[] = [];
			if (segment.tag === "skills") segChildren = skillSegmentChildren(segId, segment.content, window, skills);
			else if (segment.tag === "context") segChildren = contextSegmentChildren(segId, segment.content, window);
			const node: ManifestNode = {
				id: segId,
				label: segment.label,
				kind: "section",
				tokens: segTokens,
				bytes: byteLength(segment.content),
				percentOfWindow: pct(segTokens, window),
				content: segment.content,
			};
			if (segChildren.length > 0) node.children = segChildren;
			return node;
		});
		return {
			id,
			label: `Block ${index + 1}`,
			kind: "promptBlock",
			detail: blockDetail(index, block),
			tokens: blockTokens,
			bytes: byteLength(block),
			percentOfWindow: pct(blockTokens, window),
			content: block,
			children: sectionNodes,
			defaultExpanded: true,
		};
	});
	const tokens = sumTokens(blockNodes);
	return {
		id: "sys",
		label: "System prompt",
		kind: "group",
		detail: `${blocks.length} block${blocks.length === 1 ? "" : "s"}`,
		tokens,
		bytes: sumBytes(blockNodes),
		percentOfWindow: pct(tokens, window),
		children: blockNodes,
		defaultExpanded: true,
	};
}

/** Build the "Tool schemas" group from the wire tool set. */
function buildToolsGroup(tools: readonly ContextManifestTool[], window: number): ManifestNode {
	const normalized = tools.map(tool => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters ?? {},
	}));
	const toolNodes: ManifestNode[] = normalized.map((tool, index) => {
		const params = safeStringify(tool.parameters);
		const content = `${tool.name}\n\n${tool.description}\n\n${params}`;
		const tokens = estimateToolSchemaTokens([tool]);
		return makeLeaf(`tools/${tool.name || index}`, tool.name || `tool-${index}`, "tool", content, tokens, window);
	});
	const tokens = estimateToolSchemaTokens(normalized);
	return {
		id: "tools",
		label: "Tool schemas",
		kind: "group",
		detail: `${tools.length} tool${tools.length === 1 ? "" : "s"}`,
		tokens,
		bytes: sumBytes(toolNodes),
		percentOfWindow: pct(tokens, window),
		children: toolNodes,
	};
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return "[unserializable]";
	}
}

// ---------------------------------------------------------------------------
// Message decomposition
// ---------------------------------------------------------------------------

function textAndImagesFromContent(content: string | (TextContent | ImageContent)[]): {
	text: string;
	images: ImageContent[];
} {
	if (typeof content === "string") return { text: content, images: [] };
	const texts: string[] = [];
	const images: ImageContent[] = [];
	for (const block of content) {
		if (block.type === "text") texts.push(block.text);
		else if (block.type === "image") images.push(block);
	}
	return { text: texts.join("\n"), images };
}

function imageDescriptor(image: ImageContent): string {
	const mime = typeof image.mimeType === "string" ? image.mimeType : "image";
	const data = typeof image.data === "string" ? image.data : "";
	return `[image · ${mime} · ${data.length} base64 chars]`;
}

function messageRoleLabel(message: AgentMessage): string {
	switch (message.role) {
		case "user":
			return "user";
		case "developer":
			return "developer";
		case "assistant":
			return "assistant";
		case "toolResult":
			return "tool result";
		case "bashExecution":
			return "bash";
		case "pythonExecution":
			return "python";
		case "custom":
			return `custom: ${(message as CustomMessage).customType}`;
		case "hookMessage":
			return `hook: ${(message as HookMessage).customType}`;
		case "fileMention":
			return "file mention";
		case "branchSummary":
			return "branch summary";
		case "compactionSummary":
			return "compaction summary";
		default:
			return String((message as { role?: unknown }).role ?? "message");
	}
}

/** Decompose a message into byte-exact content parts. Never drops a message: unknown shapes fall back to raw JSON. */
function messageParts(idPrefix: string, message: AgentMessage, window: number): ManifestNode[] {
	const parts: ManifestNode[] = [];
	const push = (label: string, content: string, detail?: string) => {
		parts.push(
			makeLeaf(
				`${idPrefix}/part-${parts.length}`,
				label,
				"messagePart",
				content,
				countTokens(content),
				window,
				detail,
			),
		);
	};

	switch (message.role) {
		case "user":
		case "developer":
		case "custom":
		case "hookMessage": {
			const { text, images } = textAndImagesFromContent(message.content);
			if (text.length > 0 || images.length === 0) push("Text", text);
			for (const image of images) push("Image", imageDescriptor(image));
			break;
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			for (const block of assistant.content) {
				if (block.type === "text") push("Text", block.text);
				else if (block.type === "thinking") push("Thinking", block.thinking);
				else if (block.type === "toolCall")
					push(`Tool call: ${block.name}`, safeStringify(block.arguments), block.id);
				else push(`Block: ${block.type}`, safeStringify(block));
			}
			if (assistant.errorMessage) push("Error", assistant.errorMessage);
			break;
		}
		case "toolResult": {
			const result = message as ToolResultMessage;
			const { text, images } = textAndImagesFromContent(result.content);
			const errorTag = result.isError ? "error" : undefined;
			push("Result", text, [result.toolCallId, errorTag].filter(Boolean).join(" · ") || undefined);
			for (const image of images) push("Image", imageDescriptor(image));
			break;
		}
		case "bashExecution": {
			const bash = message as BashExecutionMessage;
			push("Command", bash.command);
			push("Output", bash.output, bash.exitCode === undefined ? undefined : `exit ${bash.exitCode}`);
			break;
		}
		case "pythonExecution": {
			const py = message as PythonExecutionMessage;
			push("Code", py.code);
			push("Output", py.output, py.exitCode === undefined ? undefined : `exit ${py.exitCode}`);
			break;
		}
		case "fileMention": {
			const mention = message as FileMentionMessage;
			for (const file of mention.files) {
				push(shortenLeadingPath(file.path), file.content ?? "", file.path);
			}
			break;
		}
		case "branchSummary":
		case "compactionSummary": {
			push("Summary", (message as BranchSummaryMessage | CompactionSummaryMessage).summary);
			break;
		}
		default: {
			push("Raw", safeStringify(message));
			break;
		}
	}
	if (parts.length === 0) push("Raw", safeStringify(message));
	return parts;
}

/** Build the "Messages" group from the live conversation. */
function buildMessagesGroup(messages: readonly AgentMessage[], window: number): ManifestNode {
	const messageNodes: ManifestNode[] = messages.map((message, index) => {
		const id = `msgs/${index}`;
		const tokens = estimateTokens(message);
		const parts = messageParts(id, message, window);
		return {
			id,
			label: `[${index}] ${messageRoleLabel(message)}`,
			kind: "message",
			tokens,
			bytes: sumBytes(parts),
			percentOfWindow: pct(tokens, window),
			children: parts,
		};
	});
	const tokens = sumTokens(messageNodes);
	return {
		id: "msgs",
		label: "Messages",
		kind: "group",
		detail: `${messages.length} message${messages.length === 1 ? "" : "s"}`,
		tokens,
		bytes: sumBytes(messageNodes),
		percentOfWindow: pct(tokens, window),
		children: messageNodes,
	};
}

/**
 * Assemble the full context manifest for a live session. The three top-level
 * groups (system prompt blocks, tool schemas, messages) mirror the three
 * payloads sent on the wire; their token total reproduces the `/context`
 * panel's `usedTokens`. Content is taken verbatim from live session state, so
 * secrets appear exactly as the user owns them locally (no masking here).
 */
export function buildContextManifest(session: ContextManifestSession): ContextManifest {
	const contextWindow = session.model?.contextWindow ?? 0;
	const blocks = session.systemPrompt ?? [];
	const tools = session.agent?.state?.tools ?? [];
	const messages = session.messages ?? [];
	const skills = session.skills ?? [];

	const systemGroup = buildSystemPromptGroup(blocks, contextWindow, skills);
	const toolsGroup = buildToolsGroup(tools, contextWindow);
	const messagesGroup = buildMessagesGroup(messages, contextWindow);
	const children = [systemGroup, toolsGroup, messagesGroup];

	const usedTokens = sumTokens(children);
	const modelName = session.model?.name ?? session.model?.id ?? "no model";
	const modelId = session.model?.id ?? "unknown";

	let autoCompactBufferTokens = 0;
	if (contextWindow > 0) {
		const compactionSettings = session.settings.getGroup("compaction");
		if (compactionSettings.enabled && compactionSettings.strategy !== "off") {
			const threshold = resolveThresholdTokens(contextWindow, compactionSettings);
			autoCompactBufferTokens = Math.max(0, contextWindow - threshold);
		}
		if (autoCompactBufferTokens === 0 && compactionSettings.enabled) {
			autoCompactBufferTokens = effectiveReserveTokens(contextWindow, compactionSettings);
		}
	}
	autoCompactBufferTokens = Math.min(autoCompactBufferTokens, Math.max(0, contextWindow - usedTokens));
	const freeTokens = Math.max(0, contextWindow - usedTokens - autoCompactBufferTokens);

	const root: ManifestNode = {
		id: "root",
		label: "Context",
		kind: "root",
		tokens: usedTokens,
		bytes: sumBytes(children),
		percentOfWindow: pct(usedTokens, contextWindow),
		children,
		defaultExpanded: true,
	};

	return {
		root,
		summary: {
			modelName,
			modelId,
			contextWindow,
			usedTokens,
			freeTokens,
			autoCompactBufferTokens,
		},
	};
}

// ---------------------------------------------------------------------------
// Plain-text rendering (ACP / non-TUI path)
// ---------------------------------------------------------------------------

function formatPercent(fraction: number): string {
	const value = fraction * 100;
	if (value > 0 && value < 0.1) return "<0.1%";
	return `${value.toFixed(1)}%`;
}

/**
 * Render the manifest as an indented, fully-expanded tree of node summaries
 * (no raw leaf content) for the ACP / print path. Mirrors the TUI inspector's
 * default tree view.
 */
export function renderContextManifestText(manifest: ContextManifest): string {
	const { root, summary } = manifest;
	if (summary.contextWindow <= 0) {
		return "Context usage is unavailable: no model is selected for this session.";
	}
	const lines: string[] = [
		`${summary.modelName} (${summary.contextWindow} ctx)`,
		`Used ${summary.usedTokens} tokens (${formatPercent(pct(summary.usedTokens, summary.contextWindow))}) · free ${summary.freeTokens}`,
		"",
	];
	const walk = (node: ManifestNode, depth: number): void => {
		const indent = "  ".repeat(depth);
		const detail = node.detail ? ` (${node.detail})` : "";
		const pctUsed = summary.usedTokens > 0 ? node.tokens / summary.usedTokens : 0;
		lines.push(
			`${indent}${node.label}${detail} — ${node.tokens} tok · ${formatPercent(pctUsed)} used · ${formatPercent(node.percentOfWindow)} ctx`,
		);
		for (const child of node.children ?? []) walk(child, depth + 1);
	};
	walk(root, 0);
	return lines.join("\n");
}
