import * as fs from "node:fs/promises";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import type { AgentSessionEvent } from "./agent-session";

const MAX_TEXT_CHARS = 500;
const MAX_JSON_CHARS = 2_000;

export interface LiveEventRecord {
	sequence: number;
	timestamp: string;
	type: AgentSessionEvent["type"];
	data?: Record<string, unknown>;
}

export interface LiveEventStreamOptions {
	path: string;
	now?: () => Date;
}

export class LiveEventStream {
	readonly path: string;
	#sequence = 0;
	#writeChain: Promise<void> = Promise.resolve();
	#now: () => Date;

	constructor(options: LiveEventStreamOptions) {
		this.path = options.path;
		this.#now = options.now ?? (() => new Date());
	}

	append(event: AgentSessionEvent): void {
		const record: LiveEventRecord = {
			sequence: ++this.#sequence,
			timestamp: this.#now().toISOString(),
			type: event.type,
			data: sanitizeEvent(event),
		};
		const line = `${JSON.stringify(record)}\n`;
		this.#writeChain = this.#writeChain
			.then(() => fs.appendFile(this.path, line, "utf8"))
			.catch(error => {
				logger.warn("Failed to append live session event", { error: String(error), path: this.path });
			});
	}

	async flush(): Promise<void> {
		await this.#writeChain;
	}
}

export interface ReadLiveEventsResult {
	nextByte: number;
	records: LiveEventRecord[];
}

/**
 * Read JSONL event records from a live session stream starting at `sinceByte`.
 * Returns the parsed records and the next byte offset for incremental reads.
 * Malformed or truncated lines are skipped rather than throwing.
 */
export async function readLiveEvents(filePath: string, sinceByte = 0): Promise<ReadLiveEventsResult> {
	let buffer: ArrayBuffer;
	try {
		buffer = await Bun.file(filePath).arrayBuffer();
	} catch (error) {
		if (isEnoent(error)) return { nextByte: sinceByte, records: [] };
		throw error;
	}
	const bytes = new Uint8Array(buffer);
	const offset = sinceByte > bytes.byteLength || sinceByte < 0 ? 0 : sinceByte;
	const text = new TextDecoder().decode(bytes.subarray(offset));
	const records: LiveEventRecord[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const record = parseEventRecord(trimmed);
		if (record) records.push(record);
	}
	return { nextByte: bytes.byteLength, records };
}

function parseEventRecord(line: string): LiveEventRecord | null {
	try {
		const value = JSON.parse(line) as {
			sequence?: unknown;
			timestamp?: unknown;
			type?: unknown;
			data?: unknown;
		};
		if (typeof value.sequence !== "number" || typeof value.timestamp !== "string" || typeof value.type !== "string") {
			return null;
		}
		return {
			sequence: value.sequence,
			timestamp: value.timestamp,
			type: value.type as AgentSessionEvent["type"],
			data: (value.data as Record<string, unknown> | undefined) ?? undefined,
		};
	} catch {
		return null;
	}
}

export function sanitizeEvent(event: AgentSessionEvent): Record<string, unknown> | undefined {
	switch (event.type) {
		case "agent_start":
		case "turn_start":
		case "todo_auto_clear":
			return undefined;
		case "agent_end":
			return {
				messageCount: event.messages.length,
				inputTokens: event.telemetry?.usage.inputTokens,
				outputTokens: event.telemetry?.usage.outputTokens,
				cacheReadTokens: event.telemetry?.usage.cachedInputTokens,
				cacheWriteTokens: event.telemetry?.usage.cacheWriteTokens,
			};
		case "turn_end":
			return {
				messageRole: event.message.role,
				toolResultCount: event.toolResults.length,
			};
		case "message_start":
		case "message_end":
			return summarizeMessage(event.message);
		case "message_update":
			return {
				...summarizeMessage(event.message),
				assistantEventType: event.assistantMessageEvent.type,
			};
		case "tool_execution_start":
			return {
				toolCallId: boundText(event.toolCallId),
				toolName: boundText(event.toolName),
				intent: boundText(event.intent),
				argsPreview: summarizeUnknown(event.args),
			};
		case "tool_execution_update":
			return {
				toolCallId: boundText(event.toolCallId),
				toolName: boundText(event.toolName),
				argsPreview: summarizeUnknown(event.args),
				partialResultPreview: summarizeUnknown(event.partialResult),
			};
		case "tool_execution_end":
			return {
				toolCallId: boundText(event.toolCallId),
				toolName: boundText(event.toolName),
				isError: event.isError === true,
				resultPreview: summarizeUnknown(event.result),
			};
		case "auto_compaction_start":
			return { reason: boundText(event.reason), action: boundText(event.action) };
		case "auto_compaction_end":
			return { action: boundText(event.action), resultPreview: summarizeUnknown(event.result) };
		case "thinking_level_changed":
			return { thinkingLevel: event.thinkingLevel, configured: event.configured };
		case "auto_retry_start":
			return {
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				delayMs: event.delayMs,
				errorMessage: boundText(event.errorMessage),
			};
		case "auto_retry_end":
			return { success: event.success, attempt: event.attempt, finalError: boundText(event.finalError) };
		case "retry_fallback_applied":
			return { from: boundText(event.from), to: boundText(event.to), role: boundText(event.role) };
		case "retry_fallback_succeeded":
			return { model: boundText(event.model), role: boundText(event.role) };
		case "ttsr_triggered":
			return { ruleCount: event.rules.length };
		case "todo_reminder":
			return { todoCount: event.todos.length, attempt: event.attempt, maxAttempts: event.maxAttempts };
		case "irc_message":
			return { customType: boundText(event.message.customType), attribution: event.message.attribution };
		case "notice":
			return { level: event.level, message: boundText(event.message), source: boundText(event.source) };
		case "goal_updated":
			return {
				goal: event.goal
					? { id: boundText(event.goal.id), objective: boundText(event.goal.objective), status: event.goal.status }
					: null,
			};
		default:
			return { preview: summarizeUnknown(event) };
	}
}

function summarizeMessage(message: { role: string; content?: unknown }): Record<string, unknown> {
	return {
		role: message.role,
		contentPreview: summarizeUnknown(message.content),
	};
}

function summarizeUnknown(value: unknown): unknown {
	if (value === undefined || value === null) return value;
	if (typeof value === "string") return boundText(value);
	if (typeof value === "number" || typeof value === "boolean") return value;
	try {
		return boundText(JSON.stringify(value));
	} catch {
		return "[unserializable]";
	}
}

function boundText(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const normalized = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "�");
	const limit = Math.min(MAX_TEXT_CHARS, MAX_JSON_CHARS);
	return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}
