/**
 * Pruning strategies for the context manager.
 *
 * Different content types get different pruning strategies:
 * - Tool results: truncate large outputs, summarize or drop stale reads
 * - Assistant messages: summarize low-relevance older messages
 * - History: merge very old turns into archive
 */

import type { ContentBlock, Message, ScoredMessage } from "../types.ts";
import { estimateMessageTokens, estimateTokens } from "./measure.ts";

// Pruning thresholds
const BASH_OUTPUT_KEEP_HEAD = 50; // lines to keep at start of large bash output
const BASH_OUTPUT_KEEP_TAIL = 20; // lines to keep at end
const BASH_OUTPUT_MAX_TOKENS = 5_000;
// STALE_READ_MAX_AGE = 10; // turns after which an unreferenced read is dropped (unused for now)
const SCORE_THRESHOLD_SUMMARIZE = 0.35; // below this, old messages get summarized
const SCORE_THRESHOLD_DROP = 0.15; // below this AND old, messages get dropped

/**
 * Result of pruning: the (potentially modified) message and whether it was changed.
 */
export interface PruneResult {
	message: Message;
	wasModified: boolean;
	wasSummarized: boolean;
	wasDropped: boolean;
}

/**
 * Prune a bash tool result that is too large.
 * Keeps first BASH_OUTPUT_KEEP_HEAD + last BASH_OUTPUT_KEEP_TAIL lines.
 */
export function pruneBashOutput(content: string): string {
	if (estimateTokens(content) <= BASH_OUTPUT_MAX_TOKENS) return content;

	const lines = content.split("\n");
	if (lines.length <= BASH_OUTPUT_KEEP_HEAD + BASH_OUTPUT_KEEP_TAIL) return content;

	const head = lines.slice(0, BASH_OUTPUT_KEEP_HEAD);
	const tail = lines.slice(-BASH_OUTPUT_KEEP_TAIL);
	const dropped = lines.length - BASH_OUTPUT_KEEP_HEAD - BASH_OUTPUT_KEEP_TAIL;

	return [...head, `\n[... ${dropped} lines truncated ...]\n`, ...tail].join("\n");
}

/**
 * Summarize a grep result that returned many matches.
 * Returns a compact summary with file list.
 */
export function summarizeGrepResult(content: string): string {
	const lines = content.split("\n").filter((l) => l.trim());
	if (lines.length <= 20) return content;

	// Extract file names from grep output (lines with : for file:line format)
	const files = new Set<string>();
	for (const line of lines) {
		const colonIdx = line.indexOf(":");
		if (colonIdx > 0) {
			const maybePath = line.slice(0, colonIdx);
			if (maybePath.includes("/") || maybePath.includes(".")) {
				files.add(maybePath);
			}
		}
	}

	const fileList = Array.from(files).slice(0, 20).join(", ");
	return `Found ${lines.length} matches across ${files.size} files: ${fileList}`;
}

/**
 * Heuristic: does this text look like ripgrep output (file:line: content lines)?
 */
function looksLikeGrepOutput(text: string): boolean {
	const lines = text.split("\n").filter((l) => l.trim());
	if (lines.length < 5) return false;
	let grepLines = 0;
	const sample = lines.slice(0, 20);
	for (const line of sample) {
		if (/^[^:]+\.[a-zA-Z]+:\d+:/.test(line)) grepLines++;
	}
	return grepLines / sample.length > 0.5;
}

/**
 * Determine whether a ContentBlock is a file read that has since been modified.
 * Used to replace read content with a compact summary.
 */
export function isStaleRead(block: ContentBlock, modifiedFiles: Set<string>): boolean {
	if (block.type !== "tool_use") return false;
	if (block.name !== "read") return false;
	const path = block.input.file_path;
	if (typeof path !== "string") return false;
	return modifiedFiles.has(path);
}

/**
 * Replace a stale file read with a compact summary.
 */
export function summarizeStaleRead(filePath: string): string {
	return `[File read: ${filePath} — subsequently modified, content omitted]`;
}

/**
 * Produce a one-line summary of an assistant message for use in pruned history.
 */
export function summarizeAssistantMessage(message: Message): string {
	if (message.role !== "assistant") return "[message]";

	const blocks = typeof message.content === "string" ? [] : message.content;
	const parts: string[] = [];

	for (const block of blocks) {
		if (block.type === "text") {
			// Take the first sentence or 100 chars
			const text = block.text.trim();
			const firstSentence = text.split(/[.!?]/)[0] ?? text;
			const summary =
				firstSentence.length > 100 ? `${firstSentence.slice(0, 100)}…` : firstSentence;
			if (summary) parts.push(summary);
		} else if (block.type === "tool_use") {
			const path = block.input.file_path ?? block.input.command ?? block.input.pattern;
			const arg = typeof path === "string" ? shortArg(path) : "…";
			parts.push(`${block.name}(${arg})`);
		}
	}

	return parts.length > 0 ? `[Summary: ${parts.join(", ")}]` : "[assistant turn]";
}

function shortArg(s: string): string {
	return `${s.slice(0, 30)}${s.length > 30 ? "…" : ""}`;
}

/**
 * Produce a compact summary of a user message (tool results) for pruned history.
 * Returns null if the content is already small enough to keep as-is.
 */
export function summarizeUserToolResult(message: Message): Message | null {
	if (message.role !== "user") return null;
	if (typeof message.content === "string") return null;

	const blocks = message.content;
	const totalTokens = blocks.reduce((sum, block) => {
		if (block.type === "text") return sum + estimateTokens(block.text);
		return sum;
	}, 0);

	// Only summarize if there's substantial content to compress
	if (totalTokens < 100) return null;

	const summaryParts: string[] = [];
	for (const block of blocks) {
		if (block.type === "text") {
			const lines = block.text.split("\n").length;
			summaryParts.push(`${lines} line${lines !== 1 ? "s" : ""}`);
		}
	}

	if (summaryParts.length === 0) return null;

	return {
		role: "user",
		content: [{ type: "text", text: `[Tool output: ${summaryParts.join(", ")}]` }],
	};
}

/**
 * Prune a single scored message according to its score and age.
 *
 * Pruning rules:
 * 1. If it's a large bash output → truncate
 * 2. If it references a file that was later modified → summarize the read
 * 3. If score < SCORE_THRESHOLD_SUMMARIZE and age > 5 → summarize
 * 4. If score < SCORE_THRESHOLD_DROP and age > 15 → drop
 */
export function pruneMessage(
	scored: ScoredMessage,
	modifiedFiles: Set<string>,
	_currentTurnIdx: number,
): PruneResult {
	// Current turn messages are never pruned
	if (scored.category === "current" || scored.category === "task") {
		return { message: scored.message, wasModified: false, wasSummarized: false, wasDropped: false };
	}

	const msg = scored.message;

	// Check for bash output pruning
	if (msg.role === "user" && typeof msg.content !== "string") {
		const pruned = pruneUserMessageContent(msg.content, modifiedFiles);
		if (pruned.modified) {
			const updated: Message = { role: "user", content: pruned.content };
			return { message: updated, wasModified: true, wasSummarized: false, wasDropped: false };
		}
	}

	// Score-based pruning for old messages
	if (scored.age > 15 && scored.score < SCORE_THRESHOLD_DROP) {
		return {
			message: scored.message,
			wasModified: false,
			wasSummarized: false,
			wasDropped: true,
		};
	}

	if (scored.age > 5 && scored.score < SCORE_THRESHOLD_SUMMARIZE) {
		if (msg.role === "assistant") {
			const summary = summarizeAssistantMessage(msg);
			const summarized: Message = {
				role: "assistant",
				content: [{ type: "text", text: summary }],
			};
			return { message: summarized, wasModified: true, wasSummarized: true, wasDropped: false };
		}
		if (msg.role === "user") {
			const summarized = summarizeUserToolResult(msg);
			if (summarized) {
				return { message: summarized, wasModified: true, wasSummarized: true, wasDropped: false };
			}
		}
	}

	return { message: scored.message, wasModified: false, wasSummarized: false, wasDropped: false };
}

/**
 * Process the content blocks of a user message, applying pruning where needed.
 */
function pruneUserMessageContent(
	blocks: ContentBlock[],
	modifiedFiles: Set<string>,
): { content: ContentBlock[]; modified: boolean } {
	let modified = false;
	const result: ContentBlock[] = [];

	for (const block of blocks) {
		if (block.type === "text") {
			// Try grep result summarization first (compact and structure-preserving)
			if (looksLikeGrepOutput(block.text)) {
				const summarized = summarizeGrepResult(block.text);
				if (summarized !== block.text) {
					result.push({ type: "text", text: summarized });
					modified = true;
					continue;
				}
			}
			// Fall back to bash output truncation for large outputs
			const pruned = pruneBashOutput(block.text);
			if (pruned !== block.text) {
				result.push({ type: "text", text: pruned });
				modified = true;
			} else {
				result.push(block);
			}
		} else if (block.type === "tool_use" && isStaleRead(block, modifiedFiles)) {
			const filePath = block.input.file_path as string;
			result.push({
				type: "text",
				text: summarizeStaleRead(filePath),
			});
			modified = true;
		} else {
			result.push(block);
		}
	}

	return { content: result, modified };
}

/**
 * Apply pruning to the full scored message list.
 * Returns only messages that should be kept (drops are excluded).
 *
 * @param scoredMessages - All scored messages in the history
 * @param modifiedFiles  - Set of file paths that have been modified by the agent
 * @param currentTurnIdx - Index where the current turn begins
 * @param historyBudget  - Max tokens allowed for history section
 */
export function pruneMessages(
	scoredMessages: ScoredMessage[],
	modifiedFiles: Set<string>,
	currentTurnIdx: number,
	historyBudget: number,
): Message[] {
	const results: PruneResult[] = scoredMessages.map((scored) =>
		pruneMessage(scored, modifiedFiles, currentTurnIdx),
	);

	// Filter out dropped messages
	const kept = results.filter((r) => !r.wasDropped).map((r) => r.message);

	// If we're still over the history budget, drop lowest-scoring messages first
	const historyMessages = kept.filter((_, i) => {
		const scored = scoredMessages[i];
		return scored && scored.category === "history";
	});

	const historyTokens = historyMessages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);

	if (historyTokens <= historyBudget) {
		return kept;
	}

	// Sort history messages by score (highest score = highest priority to keep)
	const scoreMap = new Map<Message, number>();
	for (const scored of scoredMessages) {
		scoreMap.set(scored.message, scored.score);
	}

	const historySet = new Set(historyMessages);
	const sortedHistory = [...historyMessages].sort(
		(a, b) => (scoreMap.get(b) ?? 0) - (scoreMap.get(a) ?? 0),
	);

	let remaining = historyBudget;
	const keptHistory = new Set<Message>();

	for (const msg of sortedHistory) {
		const tokens = estimateMessageTokens(msg);
		if (tokens <= remaining) {
			keptHistory.add(msg);
			remaining -= tokens;
		}
	}

	// Maintain original message order
	const finalMessages: Message[] = [];
	for (const msg of kept) {
		if (!historySet.has(msg) || keptHistory.has(msg)) {
			finalMessages.push(msg);
		}
	}

	return finalMessages;
}
