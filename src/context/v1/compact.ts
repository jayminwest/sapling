/**
 * Context Pipeline v1 — Compact stage
 *
 * Responsibilities:
 * 1. Threshold-based decision: score < COMPACTION_SCORE_THRESHOLD → compact, else keep
 * 2. Compaction: generate template-based summary, set operation status to "compacted"
 * 3. Truncation: for kept operations, truncate large tool outputs to stay within budget
 *
 * See docs/context-pipeline-v1.md §4.3.
 */

import { renderCompactSummary } from "./templates.ts";
import type { Operation } from "./types.ts";
import { COMPACTION_SCORE_THRESHOLD, TOOL_OUTPUT_TRUNCATION } from "./types.ts";

// ---------------------------------------------------------------------------
// Tool output truncation helpers
// ---------------------------------------------------------------------------

/**
 * Truncate a string to at most maxTokens (using 4 chars/token heuristic).
 * Appends a "[... truncated ...]" marker when truncated.
 */
function truncateToTokens(content: string, maxTokens: number): string {
	const maxChars = maxTokens * 4;
	if (content.length <= maxChars) return content;
	return `${content.slice(0, maxChars)}\n[... truncated ...]`;
}

/**
 * Truncate using a head+tail line strategy.
 * Keeps the first `keepFirst` lines and last `keepLast` lines when over budget.
 * Falls back to simple char truncation if line-based strategy cannot help.
 */
function truncateWithLines(
	content: string,
	maxTokens: number,
	keepFirst: number,
	keepLast: number,
): string {
	const maxChars = maxTokens * 4;
	if (content.length <= maxChars) return content;

	const lines = content.split("\n");
	const totalLines = lines.length;

	if (totalLines <= keepFirst + keepLast) {
		// Not enough lines to apply head+tail — fall back to char truncation
		return `${content.slice(0, maxChars)}\n[... truncated ...]`;
	}

	const head = lines.slice(0, keepFirst).join("\n");
	const tail = lines.slice(totalLines - keepLast).join("\n");
	const omitted = totalLines - keepFirst - keepLast;
	return `${head}\n[... ${omitted} lines omitted ...]\n${tail}`;
}

/**
 * Truncate glob output to at most globMaxResults non-empty lines.
 */
function truncateGlob(content: string): string {
	const lines = content.split("\n").filter((l) => l.trim().length > 0);
	const max = TOOL_OUTPUT_TRUNCATION.globMaxResults;
	if (lines.length <= max) return content;
	const kept = lines.slice(0, max);
	return `${kept.join("\n")}\n[... ${lines.length - max} more results ...]`;
}

/**
 * Apply tool-specific truncation to a tool result content string.
 * Tools not listed here are returned unchanged.
 */
export function truncateToolOutput(toolName: string, content: string): string {
	switch (toolName) {
		case "bash":
			return truncateWithLines(
				content,
				TOOL_OUTPUT_TRUNCATION.bashMaxTokens,
				TOOL_OUTPUT_TRUNCATION.bashKeepFirstLines,
				TOOL_OUTPUT_TRUNCATION.bashKeepLastLines,
			);
		case "grep":
			return truncateToTokens(content, TOOL_OUTPUT_TRUNCATION.grepMaxTokens);
		case "read":
			return truncateWithLines(
				content,
				TOOL_OUTPUT_TRUNCATION.readMaxTokens,
				TOOL_OUTPUT_TRUNCATION.readKeepFirstLines,
				TOOL_OUTPUT_TRUNCATION.readKeepLastLines,
			);
		case "glob":
			return truncateGlob(content);
		default:
			return content;
	}
}

// ---------------------------------------------------------------------------
// Operation-level compaction
// ---------------------------------------------------------------------------

/**
 * Compact a single operation: generate a template-based summary and mark as "compacted".
 * Mutates the operation in-place.
 */
export function compactOperation(op: Operation): void {
	op.summary = renderCompactSummary(op);
	op.status = "compacted";
}

/**
 * Truncate tool outputs in all turns of a retained operation.
 *
 * For each turn, builds a map of tool_use_id → tool_name from the assistant message,
 * then truncates any tool_result content whose tool exceeds its budget.
 * Mutates the turn messages in-place.
 */
export function truncateOperationOutputs(op: Operation): void {
	for (const turn of op.turns) {
		// Build id → name map from assistant tool_use blocks
		const toolNameById = new Map<string, string>();
		for (const block of turn.assistant.content) {
			if (block.type === "tool_use") {
				toolNameById.set(block.id, block.name);
			}
		}

		// Nothing to truncate if no tool results
		if (turn.toolResults === null) continue;
		if (!Array.isArray(turn.toolResults.content)) continue;

		// Mutate each tool_result block in-place
		for (const block of turn.toolResults.content as unknown[]) {
			if (
				typeof block !== "object" ||
				block === null ||
				(block as { type?: unknown }).type !== "tool_result"
			) {
				continue;
			}

			const resultBlock = block as { type: string; tool_use_id: string; content: string };
			const toolName = toolNameById.get(resultBlock.tool_use_id);
			if (toolName === undefined) continue;

			resultBlock.content = truncateToolOutput(toolName, resultBlock.content);
		}
	}
}

// ---------------------------------------------------------------------------
// Stage entry point
// ---------------------------------------------------------------------------

/**
 * Compact stage: process all operations.
 *
 * - Active operations are always skipped (never compacted or truncated here).
 * - Completed/in-progress operations with score < COMPACTION_SCORE_THRESHOLD are compacted.
 * - Operations with score >= COMPACTION_SCORE_THRESHOLD have tool outputs truncated.
 * - Already-compacted or archived operations are left unchanged.
 *
 * @param operations       - The full operation registry (mutated in-place).
 * @param activeOperationId - ID of the currently active operation (never compacted).
 */
export function compact(operations: Operation[], activeOperationId: number | null): void {
	for (const op of operations) {
		// Never touch the active operation
		if (op.id === activeOperationId) continue;

		// Skip already-processed states
		if (op.status === "compacted" || op.status === "archived") continue;

		if (op.score < COMPACTION_SCORE_THRESHOLD) {
			compactOperation(op);
		} else {
			truncateOperationOutputs(op);
		}
	}
}
