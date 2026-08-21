/**
 * Contract tests for the context manifest model + builder and the inspector
 * overlay renderer behind `/context full`.
 *
 * The guarantees that matter:
 *   1. Block segmentation is byte-reversible (segments concatenate to the block).
 *   2. The manifest headline total is internally consistent with the same
 *      estimator set used by `/context`.
 *   3. Leaf content is byte-for-byte: prompt blocks, per-file context, message
 *      parts, and secrets all appear verbatim (no masking in the user-facing view).
 *   4. The overlay reveals a leaf's raw content on expand and closes on Esc.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { ContextInspectorOverlayComponent } from "../src/modes/components/context-inspector-overlay";
import { initTheme } from "../src/modes/theme/theme";
import {
	buildContextManifest,
	type ContextManifest,
	type ContextManifestSession,
	type ManifestNode,
	renderContextManifestText,
	segmentPromptBlock,
} from "../src/modes/utils/context-manifest";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

const SECRET = "sk-SUPERSECRET-abcdef1234567890";

const BLOCK0 = [
	"<system-conventions>",
	"RFC 2119 applies.",
	"</system-conventions>",
	"",
	"TOOLS",
	"===================================",
	"Use tools when helpful.",
	"",
	"ENV",
	"===================================",
	"",
	"# Skills & Rules",
	"<skills>",
	"- alpha: First skill description",
	"- beta: Second skill description",
	"</skills>",
	"",
	"CONTRACT",
	"===================================",
	"These are inviolable.",
].join("\n");

const BLOCK1 = [
	"PROJECT",
	"===================================",
	"",
	"<context>",
	"Follow the context files below for all tasks:",
	'<file path="/home/u/.zshrc">',
	`export API_KEY=${SECRET}`,
	"export OTHER=plain",
	"</file>",
	"</context>",
	"",
	"<critical>",
	"- advance the task",
	"</critical>",
].join("\n");

/**
 * One tokenizer for the whole suite: the manifest counts through the session's
 * instance, so the expectations must measure with the same one.
 */
const TOKENIZER = new Tokenizer();

function makeSession(overrides: Partial<ContextManifestSession> = {}): ContextManifestSession {
	const session: ContextManifestSession = {
		systemPrompt: [BLOCK0, BLOCK1],
		tokenizer: TOKENIZER,
		agent: { state: { tools: [{ name: "read", description: "Read files", parameters: { type: "object" } }] } },
		skills: [
			{ name: "alpha", description: "First skill description", filePath: "/s/alpha.md", source: "builtin" },
			{ name: "beta", description: "Second skill description", filePath: "/s/beta.md", source: "builtin" },
		],
		model: { id: "test-model", name: "Test Model", contextWindow: 200_000 },
		settings: { getGroup: () => ({ enabled: false, strategy: "off", reserveTokens: 0, keepRecentTokens: 0 }) },
		messages: [
			{ role: "user", content: `please use ${SECRET} as the key`, timestamp: 0 },
			{
				role: "assistant",
				api: "anthropic-messages",
				provider: "test-provider",
				model: "test-model",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 0,
				content: [
					{ type: "thinking", thinking: "I should call read" },
					{ type: "text", text: "Reading the file now." },
					{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "config.json" } },
				],
			},
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				isError: false,
				timestamp: 0,
				content: [{ type: "text", text: "file contents here" }],
			},
			{
				role: "bashExecution",
				command: "echo hi",
				output: "hi\n",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 0,
			},
		],
	};
	return { ...session, ...overrides };
}

function findNode(root: ManifestNode, predicate: (n: ManifestNode) => boolean): ManifestNode | undefined {
	const stack = [root];
	while (stack.length > 0) {
		const node = stack.pop();
		if (!node) continue;
		if (predicate(node)) return node;
		for (const child of node.children ?? []) stack.push(child);
	}
	return undefined;
}

describe("segmentPromptBlock", () => {
	it("tiles a block into byte-reversible segments", () => {
		const segments = segmentPromptBlock(BLOCK0);
		expect(segments.length).toBeGreaterThan(1);
		expect(segments.map(s => s.content).join("")).toBe(BLOCK0);
	});

	it("labels recognized tag and heading regions", () => {
		const labels = segmentPromptBlock(BLOCK0).map(s => s.label);
		expect(labels).toContain("Skills");
		expect(labels).toContain("System conventions");
		expect(labels).toContain("Tools guidance");
		expect(labels).toContain("Contract");
	});

	it("falls back to a single whole-block segment when no markers are present", () => {
		const plain = "just some prose\nwith two lines";
		const segments = segmentPromptBlock(plain);
		expect(segments).toHaveLength(1);
		expect(segments[0].content).toBe(plain);
	});

	it("keeps the context tag and its file payload reversible", () => {
		const segments = segmentPromptBlock(BLOCK1);
		expect(segments.map(s => s.content).join("")).toBe(BLOCK1);
		expect(segments.map(s => s.label)).toContain("Context files");
	});
});

describe("buildContextManifest", () => {
	it("keeps headline token totals internally consistent", () => {
		const manifest = buildContextManifest(makeSession());
		expect(manifest.root.tokens).toBe(manifest.summary.usedTokens);
		expect(manifest.summary.freeTokens).toBe(
			manifest.summary.contextWindow - manifest.summary.usedTokens - manifest.summary.autoCompactBufferTokens,
		);
	});

	it("exposes the three wire groups under the root", () => {
		const manifest = buildContextManifest(makeSession());
		const groupLabels = (manifest.root.children ?? []).map(c => c.label);
		expect(groupLabels).toEqual(["System prompt", "Tool schemas", "Messages"]);
	});

	it("keeps prompt block content byte-for-byte", () => {
		const manifest = buildContextManifest(makeSession());
		const block0 = findNode(manifest.root, n => n.id === "sys/block-0");
		expect(block0?.content).toBe(BLOCK0);
		expect(block0?.bytes).toBe(Buffer.byteLength(BLOCK0, "utf8"));
	});

	it("decomposes the skills section into per-skill leaves with exact lines", () => {
		const manifest = buildContextManifest(makeSession());
		const skills = findNode(manifest.root, n => n.kind === "section" && n.label === "Skills");
		expect(skills?.children?.map(c => c.content)).toEqual([
			"- alpha: First skill description",
			"- beta: Second skill description",
		]);
		expect(skills?.children?.[0].detail).toBe("builtin");
	});

	it("decomposes context files and preserves secrets verbatim", () => {
		const manifest = buildContextManifest(makeSession());
		const file = findNode(manifest.root, n => n.kind === "file");
		expect(file?.detail).toBe("/home/u/.zshrc");
		expect(file?.content).toBe(`export API_KEY=${SECRET}\nexport OTHER=plain`);
		expect(file?.content?.includes(SECRET)).toBe(true);
	});

	it("breaks assistant messages into text, thinking, and tool-call parts", () => {
		const manifest = buildContextManifest(makeSession());
		const assistant = findNode(manifest.root, n => n.id === "msgs/1");
		const parts = assistant?.children ?? [];
		expect(parts.map(p => p.label)).toEqual(["Thinking", "Text", "Tool call: read"]);
		expect(parts[0].content).toBe("I should call read");
		expect(parts[2].content).toContain("config.json");
	});

	it("renders message-level tokens from the same estimator the summary uses", () => {
		const session = makeSession();
		const manifest = buildContextManifest(session);
		const messages = findNode(manifest.root, n => n.id === "msgs");
		const expected = session.tokenizer.countMessages(session.messages ?? []);
		expect(messages?.tokens).toBe(expected);
	});

	it("never drops a user message's secret-bearing content", () => {
		const manifest = buildContextManifest(makeSession());
		const user = findNode(manifest.root, n => n.id === "msgs/0");
		expect(user?.children?.[0].content).toBe(`please use ${SECRET} as the key`);
	});
});

describe("renderContextManifestText", () => {
	it("renders an indented outline with the model and node summaries", () => {
		const text = renderContextManifestText(buildContextManifest(makeSession()));
		expect(text).toContain("Test Model");
		expect(text).toContain("System prompt");
		expect(text).toContain("Messages");
		expect(text).toContain("tok");
	});

	it("reports unavailable when no model is selected", () => {
		const manifest = buildContextManifest(makeSession({ model: undefined }));
		expect(renderContextManifestText(manifest)).toContain("unavailable");
	});
});

describe("ContextInspectorOverlayComponent", () => {
	function leafManifest(content: string): ContextManifest {
		const leaf: ManifestNode = {
			id: "sys/block-0",
			label: "Block 1",
			kind: "promptBlock",
			tokens: 5,
			bytes: Buffer.byteLength(content, "utf8"),
			percentOfWindow: 0.005,
			content,
		};
		const group: ManifestNode = {
			id: "sys",
			label: "System prompt",
			kind: "group",
			tokens: 5,
			bytes: leaf.bytes,
			percentOfWindow: 0.005,
			children: [leaf],
			defaultExpanded: true,
		};
		const root: ManifestNode = {
			id: "root",
			label: "Context",
			kind: "root",
			tokens: 5,
			bytes: leaf.bytes,
			percentOfWindow: 0.005,
			children: [group],
			defaultExpanded: true,
		};
		return {
			root,
			summary: {
				modelName: "Test Model",
				modelId: "test-model",
				contextWindow: 1000,
				usedTokens: 5,
				freeTokens: 995,
				autoCompactBufferTokens: 0,
			},
		};
	}

	it("renders the header and default-expanded structure without leaf content", () => {
		const overlay = new ContextInspectorOverlayComponent(leafManifest("SECRET-RAW-LINE\nsecond line"), () => {});
		const out = overlay.render(80).join("\n");
		expect(out).toContain("Test Model");
		expect(out).toContain("System prompt");
		expect(out).toContain("Block 1");
		// Leaf content stays collapsed until the user expands it.
		expect(out).not.toContain("SECRET-RAW-LINE");
	});

	it("reveals raw leaf content verbatim after navigating to and expanding the leaf", () => {
		const overlay = new ContextInspectorOverlayComponent(leafManifest("SECRET-RAW-LINE\nsecond line"), () => {});
		// rows: [root, System prompt, Block 1]; move selection to the leaf, then expand.
		overlay.handleInput("j");
		overlay.handleInput("j");
		overlay.handleInput("\r");
		const out = overlay.render(80).join("\n");
		expect(out).toContain("SECRET-RAW-LINE");
		expect(out).toContain("second line");
	});

	it("invokes the done callback on Escape", () => {
		let closed = false;
		const overlay = new ContextInspectorOverlayComponent(leafManifest("x"), () => {
			closed = true;
		});
		overlay.handleInput("\x1b");
		expect(closed).toBe(true);
	});
});
