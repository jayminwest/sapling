/**
 * Context Pipeline v1 — Render Stage
 *
 * Responsibilities:
 * 1. Build the final message array: [task message] + retained operations' turns (chronological)
 *    Compacted operations are rendered as synthetic assistant/user pairs.
 * 2. Compose the system prompt: agent persona + working memory + active context.
 * 3. Produce PipelineState for RPC inspection, events, and benchmarking.
 *
 * See docs/context-pipeline-v1.md sections 4.5 and 5.
 */

import type { Message } from "../../types.ts";
import type {
	BudgetUtilization,
	Operation,
	OperationStatus,
	PipelineOutput,
	PipelineState,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Archive entry template (local implementation; replaced by templates.ts import post-merge)
// ---------------------------------------------------------------------------

/**
 * Render a one-line archive entry for the working memory section.
 * Template: - [Op #{id}: {type}] {verb} {files}. Outcome: {outcome}.
 */
function localArchiveEntry(op: Operation): string {
	const files = [...op.files]
		.slice(0, 3)
		.map((f) => f.split("/").pop() ?? f)
		.join(", ");
	const verb: Record<Operation["type"], string> = {
		explore: "Explored",
		mutate: "Modified",
		verify: "Verified",
		investigate: "Investigated",
		mixed: "Worked on",
	};
	return `- [Op #${op.id}: ${op.type}] ${verb[op.type]}${files ? ` ${files}` : ""}. Outcome: ${op.outcome}.`;
}

// ---------------------------------------------------------------------------
// 1. renderMessages
// ---------------------------------------------------------------------------

/** An entry in the message assembly queue, tagged with a sort key. */
type MessageEntry =
	| { sortKey: number; messages: [Message, Message] }
	| { sortKey: number; messages: [Message] | [Message, Message] };

/**
 * Build the final message array for the next LLM call.
 *
 * Layout: [taskMessage] followed by retained operations' messages in
 * chronological order (by turn index or operation startTurn for compacted ops).
 *
 * Compacted operations (status='compacted') are rendered as a synthetic pair:
 *   assistant: { content: [{ type:'text', text: summary }] }
 *   user:      { content: '[continued]' }
 */
export function renderMessages(taskMessage: Message, retainedOps: Operation[]): Message[] {
	const entries: MessageEntry[] = [];

	for (const op of retainedOps) {
		if (op.status === "compacted" && op.summary !== null) {
			// Render as synthetic exchange
			const assistant: Message = {
				role: "assistant",
				content: [{ type: "text", text: op.summary }],
			};
			const ack: Message = {
				role: "user",
				content: "[continued]",
			};
			entries.push({ sortKey: op.startTurn, messages: [assistant, ack] });
		} else {
			// Render full turns
			for (const turn of op.turns) {
				const pair: [Message] | [Message, Message] = turn.toolResults
					? [turn.assistant, turn.toolResults]
					: [turn.assistant];
				entries.push({ sortKey: turn.index, messages: pair });
			}
		}
	}

	// Sort chronologically
	entries.sort((a, b) => a.sortKey - b.sortKey);

	const messages: Message[] = [taskMessage];
	for (const entry of entries) {
		for (const msg of entry.messages) {
			messages.push(msg);
		}
	}

	return messages;
}

// ---------------------------------------------------------------------------
// 2. composeSystemPrompt
// ---------------------------------------------------------------------------

/**
 * Compose the system prompt for the next LLM call.
 *
 * Three sections:
 *   1. AGENT PERSONA  — basePrompt verbatim (stable across the session)
 *   2. WORKING MEMORY — archive entries for ops evicted from the message array
 *   3. ACTIVE CONTEXT — current op, modified files, unresolved errors
 */
export function composeSystemPrompt(
	basePrompt: string,
	archivedOps: Operation[],
	activeOp: Operation | null,
	allOps: Operation[],
): string {
	let prompt = basePrompt;

	// --- Working Memory ---
	if (archivedOps.length > 0) {
		const sorted = [...archivedOps].sort((a, b) => a.id - b.id);
		const entries = sorted.map((op) => localArchiveEntry(op)).join("\n");
		prompt += `\n\n## Working Memory\n\n### Completed Operations (oldest first)\n${entries}`;
	}

	// --- Active Context ---
	// Non-archived ops that have artifacts (mutate/mixed)
	const nonArchivedOps = allOps.filter((op) => op.status !== "archived");
	const artifactFiles = collectArtifacts(nonArchivedOps);
	const failureOps = collectUnresolvedErrors(nonArchivedOps);

	const hasActiveOp = activeOp !== null;
	const hasFiles = artifactFiles.length > 0;
	const hasErrors = failureOps.length > 0;

	if (hasActiveOp || hasFiles || hasErrors) {
		prompt += "\n\n## Active Context\n\n";

		// Current operation
		const currentOpLine = activeOp
			? `[Op #${activeOp.id}: ${activeOp.type}] ${briefDescription(activeOp)}`
			: "None";
		prompt += `**Current operation:** ${currentOpLine}\n`;

		// Modified files
		if (hasFiles) {
			prompt += "**Files modified this session:**\n";
			for (const f of artifactFiles) {
				prompt += `- ${f}\n`;
			}
		} else {
			prompt += "**Files modified this session:** None\n";
		}

		// Unresolved errors
		if (hasErrors) {
			const descriptions = failureOps.map((op) => `Op #${op.id} (${op.type}): ${op.outcome}`);
			prompt += `**Unresolved errors:** ${descriptions.join("; ")}`;
		} else {
			prompt += "**Unresolved errors:** None";
		}
	}

	return prompt;
}

/**
 * Collect a deduplicated list of artifact files from non-archived operations.
 */
function collectArtifacts(ops: Operation[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const op of ops) {
		for (const f of op.artifacts) {
			if (!seen.has(f)) {
				seen.add(f);
				result.push(f);
			}
		}
	}
	return result;
}

/**
 * Collect operations with outcome='failure' where no later op on the same
 * files has outcome='success' (i.e., the error is still unresolved).
 */
function collectUnresolvedErrors(ops: Operation[]): Operation[] {
	return ops.filter((op) => {
		if (op.outcome !== "failure") return false;
		// Consider resolved if a later op touches the same files and succeeded
		return !ops.some(
			(later) =>
				later.id > op.id &&
				later.outcome === "success" &&
				[...op.files].some((f) => later.files.has(f)),
		);
	});
}

/**
 * Generate a brief one-line description for an operation (for the active context line).
 */
function briefDescription(op: Operation): string {
	const verb: Record<Operation["type"], string> = {
		explore: "Exploring",
		mutate: "Modifying",
		verify: "Verifying",
		investigate: "Investigating",
		mixed: "Working on",
	};
	const files = [...op.files].slice(0, 2).map((f) => f.split("/").pop() ?? f);
	return `${verb[op.type]}${files.length > 0 ? ` ${files.join(", ")}` : ""}`;
}

// ---------------------------------------------------------------------------
// 3. renderPipelineState
// ---------------------------------------------------------------------------

/**
 * Build the PipelineState snapshot for inspection, events, and benchmarking.
 */
export function renderPipelineState(
	operations: Operation[],
	activeOperationId: number | null,
	budget: BudgetUtilization,
): PipelineState {
	const operationCounts: Record<OperationStatus, number> = {
		active: 0,
		completed: 0,
		compacted: 0,
		archived: 0,
	};
	for (const op of operations) {
		operationCounts[op.status]++;
	}

	return {
		operations,
		activeOperationId,
		utilization: budget.utilization,
		budget,
		operationCounts,
	};
}

// ---------------------------------------------------------------------------
// 4. render — main entry point
// ---------------------------------------------------------------------------

/**
 * Render stage: combine messages, system prompt, and pipeline state into
 * the final PipelineOutput for the next LLM call.
 *
 * @param taskMessage      The original task/prompt message (always first, never pruned).
 * @param retainedOps      Operations retained in the message array (active/completed/compacted).
 * @param archivedOps      Operations evicted to working memory (archived).
 * @param basePrompt       The agent persona (stable system prompt section).
 * @param allOps           All operations (for state and active context computation).
 * @param activeOperationId The ID of the currently active operation, or null.
 * @param budget           Budget utilization from the Budget stage.
 */
export function render(
	taskMessage: Message,
	retainedOps: Operation[],
	archivedOps: Operation[],
	basePrompt: string,
	allOps: Operation[],
	activeOperationId: number | null,
	budget: BudgetUtilization,
): PipelineOutput {
	const activeOp =
		activeOperationId !== null ? (allOps.find((op) => op.id === activeOperationId) ?? null) : null;

	return {
		messages: renderMessages(taskMessage, retainedOps),
		systemPrompt: composeSystemPrompt(basePrompt, archivedOps, activeOp, allOps),
		state: renderPipelineState(allOps, activeOperationId, budget),
	};
}
