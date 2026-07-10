import * as crypto from "node:crypto";
import type { AgentTool, AgentToolResult, ToolTier } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import {
	CONTEXT_EXPORT_TASK_MAX_LENGTH,
	CONTEXT_EXPORT_TASK_TOO_LONG_MESSAGE,
	type ContextExportSelection,
	type ContextExportSkip,
	type ContextExportStats,
	type ContextExportWriteResult,
	type PreparedContextExport,
	prepareContextExport,
	publishContextExport,
} from "../context-export";
import contextExportDescription from "../prompts/tools/context-export.md" with { type: "text" };
import { collectEnvSecrets, loadSecrets, SecretObfuscator } from "../secrets";
import type { ToolSession } from ".";

const lineRangeSchema = type({
	start_line: "number",
	end_line: "number",
	"+": "reject",
});

const selectionOperationSchema = type({
	action: "'include' | 'exclude'",
	path: "string",
	"ranges?": lineRangeSchema.array(),
	"+": "reject",
});

const selectionSchema = type({
	base: "'all' | 'none'",
	operations: selectionOperationSchema.array(),
	"+": "reject",
});

const contextExportSchema = type({
	action: type("'preview' | 'write'").describe(
		"preview renders and caches the bundle; write publishes the cached preview",
	),
	workflow_id: type("string").describe("workflow ID issued by /context-export"),
	"selection?": selectionSchema.describe("ordered selection program (preview only)"),
	"preview_id?": type("string").describe("receipt from the latest preview (write only)"),
	"+": "reject",
});

export type ContextExportParams = typeof contextExportSchema.infer;

export const CONTEXT_EXPORT_WORKFLOW_NOT_FOUND_MESSAGE =
	"Context export workflow not found; run /context-export <task> again.";

export interface ContextExportToolDetails {
	action: "preview" | "write";
	destination: string;
	stats?: ContextExportStats;
	skips?: ContextExportSkip[];
	previewId?: string;
	writeResult?: ContextExportWriteResult;
}

/** Controller surface the slash command drives; forwarded intact by tool proxies. */
export interface ContextExportController {
	beginContextExport(task: string): string;
}

/** Narrow runtime guard for {@link ContextExportController} on a (possibly proxied) tool. */
export function isContextExportController(tool: unknown): tool is ContextExportController {
	return (
		typeof tool === "object" &&
		tool !== null &&
		typeof (tool as ContextExportController).beginContextExport === "function"
	);
}

interface PreviewReceipt {
	previewId: string;
	prepared: PreparedContextExport;
}

export class ContextExportTool implements AgentTool<typeof contextExportSchema, ContextExportToolDetails> {
	readonly name = "context_export";
	readonly label = "Context Export";
	readonly summary = "Preview or write a task-focused repository context bundle";
	readonly loadMode = "discoverable";
	readonly description: string;
	readonly parameters = contextExportSchema;
	readonly strict = true;
	readonly concurrency = "exclusive" as const;
	readonly approval = (args: unknown): ToolTier =>
		args !== null && typeof args === "object" && "action" in args && args.action === "write" ? "write" : "read";

	#workflowId: string | null = null;
	#task: string | null = null;
	#receipt: PreviewReceipt | null = null;

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(contextExportDescription);
	}

	/** Registered only for top-level sessions; subagents never see it. */
	static createIf(session: ToolSession): ContextExportTool | null {
		if ((session.taskDepth ?? 0) !== 0) return null;
		return new ContextExportTool(session);
	}

	/**
	 * Bind a new command-issued workflow: stores the exact trimmed task,
	 * invalidates any prior workflow/receipt, and returns a fresh workflow ID.
	 */
	beginContextExport(task: string): string {
		const trimmed = task.trim();
		if (!trimmed) {
			throw new Error("Context export task must not be empty.");
		}
		if (trimmed.length > CONTEXT_EXPORT_TASK_MAX_LENGTH) {
			throw new Error(CONTEXT_EXPORT_TASK_TOO_LONG_MESSAGE);
		}
		this.#workflowId = crypto.randomUUID();
		this.#task = trimmed;
		this.#receipt = null;
		return this.#workflowId;
	}

	async execute(
		_toolCallId: string,
		params: ContextExportParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<ContextExportToolDetails>> {
		if (!this.#workflowId || this.#task === null) {
			throw new Error(CONTEXT_EXPORT_WORKFLOW_NOT_FOUND_MESSAGE);
		}
		if (params.workflow_id !== this.#workflowId) {
			// Wrong ID leaves the valid workflow/receipt intact.
			throw new Error("Unknown context export workflow ID; use the ID issued by /context-export.");
		}
		if (params.action === "preview") {
			if (params.preview_id !== undefined) {
				throw new Error("preview does not accept preview_id.");
			}
			if (params.selection === undefined) {
				throw new Error("preview requires selection.");
			}
			return await this.#preview(params.selection, signal);
		}
		if (params.selection !== undefined) {
			throw new Error("write does not accept selection.");
		}
		if (params.preview_id === undefined) {
			throw new Error("write requires the preview_id from the latest preview.");
		}
		return await this.#write(params.preview_id, signal);
	}

	async #preview(
		selectionInput: NonNullable<ContextExportParams["selection"]>,
		signal?: AbortSignal,
	): Promise<AgentToolResult<ContextExportToolDetails>> {
		// A new preview always invalidates the previous receipt, even on failure.
		this.#receipt = null;
		const selection: ContextExportSelection = {
			base: selectionInput.base,
			operations: selectionInput.operations.map(op => ({
				action: op.action,
				path: op.path,
				ranges: op.ranges?.map(range => ({ startLine: range.start_line, endLine: range.end_line })),
			})),
		};
		const secretEntries = [
			...(await loadSecrets(this.session.cwd, this.session.settings.getAgentDir())),
			...collectEnvSecrets(),
		];
		const prepared = await prepareContextExport({
			rootPath: this.session.cwd,
			task: this.#task as string,
			selection,
			secretDetector: new SecretObfuscator(secretEntries),
			signal,
		});
		const previewId = crypto.randomUUID();
		this.#receipt = { previewId, prepared };
		const lines = [
			`Preview ready: ${previewId}`,
			`Destination: ${prepared.destination}`,
			`Files: ${prepared.stats.selectedFileCount} selected (${prepared.stats.fullFileCount} full, ${prepared.stats.slicedFileCount} sliced, ${prepared.stats.sliceRangeCount} ranges)`,
			`Bytes: ${prepared.stats.sourceBytes} source, ${prepared.stats.renderedBytes} rendered`,
			`Tokens (o200k_base): ${prepared.stats.tokens} of ${prepared.stats.maxTokens} (${prepared.stats.tokenHeadroom} headroom)`,
			`Known-secret scan: ${prepared.secretScan}`,
		];
		if (prepared.skips.length > 0) {
			const byReason = new Map<string, string[]>();
			for (const skip of prepared.skips) {
				const group = byReason.get(skip.reason) ?? [];
				group.push(skip.path);
				byReason.set(skip.reason, group);
			}
			lines.push("Skipped:");
			for (const [reason, paths] of byReason) {
				lines.push(`- ${reason}: ${paths.join(", ")}`);
			}
		}
		if (prepared.largestPayloads.length > 0) {
			lines.push("Largest selected payloads (UTF-8 bytes):");
			for (const payload of prepared.largestPayloads) {
				lines.push(`- ${payload.path}: ${payload.bytes}`);
			}
		}
		lines.push(`Publish with { action: "write", workflow_id: "${this.#workflowId}", preview_id: "${previewId}" }.`);
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: {
				action: "preview",
				destination: prepared.destination,
				stats: prepared.stats,
				skips: prepared.skips,
				previewId,
			},
		};
	}

	async #write(previewId: string, signal?: AbortSignal): Promise<AgentToolResult<ContextExportToolDetails>> {
		const receipt = this.#receipt;
		if (!receipt) {
			throw new Error("No context export preview is pending; call preview first.");
		}
		if (previewId !== receipt.previewId) {
			// Wrong receipt ID leaves the pending receipt intact.
			throw new Error("Unknown context export preview ID; use the preview_id from the latest preview.");
		}
		// Consume the receipt before publishing so a failed attempt cannot be
		// retried against possibly divergent expectations; the workflow survives
		// a failure so the agent can preview again without re-running the command.
		this.#receipt = null;
		const result = await publishContextExport(receipt.prepared, signal);
		this.#workflowId = null;
		this.#task = null;
		return {
			content: [
				{
					type: "text",
					text: [
						`Wrote ${result.destination}`,
						`Bytes: ${result.sourceBytes} source, ${result.bytesWritten} rendered`,
						`Tokens (o200k_base): ${result.tokens}`,
						"Review the file before uploading it.",
					].join("\n"),
				},
			],
			details: {
				action: "write",
				destination: result.destination,
				writeResult: result,
			},
		};
	}
}
