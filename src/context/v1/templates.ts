/**
 * Context Pipeline v1 — Template-based summary generation
 *
 * Three template levels:
 *   - renderCompactSummary: multi-line structured summary (for compacted operations)
 *   - renderArchiveEntry: one-liner for the system prompt working memory
 *
 * See docs/context-pipeline-v1.md §4.3.
 */

import type { Operation } from "./types.ts";

// ---------------------------------------------------------------------------
// Purpose extraction
// ---------------------------------------------------------------------------

/** Ordered regex cascade to extract a short purpose phrase from assistant text. */
const PURPOSE_PATTERNS: readonly RegExp[] = [
	/\bI(?:'ll| will)\s+(.{10,100}?)(?:[.!?]|$)/i,
	/\bLet me\s+(.{10,100}?)(?:[.!?]|$)/i,
	/\b(?:Going|Need)(?:ing)? to\s+(.{10,100}?)(?:[.!?]|$)/i,
	/\b(?:The goal|My task|My job) is to\s+(.{10,100}?)(?:[.!?]|$)/i,
	/\b(?:Now I(?:'ll| will)|Next,? I(?:'ll| will))\s+(.{10,100}?)(?:[.!?]|$)/i,
];

/**
 * Extract a short purpose phrase from an operation's first assistant turn.
 * Uses a regex cascade on the assistant text, falling back to type + files.
 */
export function extractPurpose(op: Operation): string {
	const firstTurn = op.turns[0];
	if (firstTurn !== undefined) {
		const text = firstTurn.assistant.content
			.filter((b) => b.type === "text")
			.map((b) => (b.type === "text" ? b.text : ""))
			.join(" ")
			.trim();

		for (const pattern of PURPOSE_PATTERNS) {
			const m = text.match(pattern);
			if (m?.[1] !== undefined) {
				const captured = m[1].trim().replace(/\s+/g, " ");
				if (captured.length >= 10) {
					// Cap at 100 chars
					return captured.length > 100 ? `${captured.slice(0, 97)}...` : captured;
				}
			}
		}
	}

	// Metadata fallback: type + file list
	const fileList = [...op.files].slice(0, 3).join(", ");
	return fileList ? `${op.type} operation on ${fileList}` : `${op.type} operation`;
}

// ---------------------------------------------------------------------------
// Action summary
// ---------------------------------------------------------------------------

/**
 * Build a deduplicated list of tool(file) pairs from all turns in the operation.
 * Tools with no associated files appear as bare tool names.
 */
export function buildActionSummary(op: Operation): string {
	const seen = new Set<string>();
	const actions: string[] = [];

	for (const turn of op.turns) {
		if (turn.meta.files.length > 0) {
			for (const toolName of turn.meta.tools) {
				for (const file of turn.meta.files) {
					const key = `${toolName}(${file})`;
					if (!seen.has(key)) {
						seen.add(key);
						actions.push(key);
					}
				}
			}
		} else {
			for (const toolName of turn.meta.tools) {
				if (!seen.has(toolName)) {
					seen.add(toolName);
					actions.push(toolName);
				}
			}
		}
	}

	return actions.join(", ");
}

// ---------------------------------------------------------------------------
// Outcome detail
// ---------------------------------------------------------------------------

/**
 * Return a human-readable outcome description for an operation.
 */
export function describeOutcome(op: Operation): string {
	const artifactList = op.artifacts.slice(0, 3).join(", ");
	switch (op.outcome) {
		case "success":
			return artifactList
				? `Completed successfully. Artifacts: ${artifactList}`
				: "Completed successfully";
		case "failure":
			return "Failed (error encountered)";
		case "partial":
			return artifactList ? `Partial completion. Modified: ${artifactList}` : "Partial completion";
		case "in_progress":
			return "In progress";
	}
}

// ---------------------------------------------------------------------------
// Template renderers
// ---------------------------------------------------------------------------

/**
 * Render a multi-line compact summary for a compacted operation.
 * Used as `op.summary` and included in archive context blocks.
 */
export function renderCompactSummary(op: Operation): string {
	const purpose = extractPurpose(op);
	const actions = buildActionSummary(op);
	const outcome = describeOutcome(op);

	const lines: string[] = [`[Op ${op.id}] ${purpose}`];
	if (actions.length > 0) lines.push(`Actions: ${actions}`);
	lines.push(`Outcome: ${outcome}`);
	return lines.join("\n");
}

/**
 * Render a one-liner archive entry for the system prompt working memory.
 * Format: "Op{id}: {purpose} [{outcome}]"
 */
export function renderArchiveEntry(op: Operation): string {
	const purpose = extractPurpose(op);
	return `Op${op.id}: ${purpose} [${op.outcome}]`;
}
