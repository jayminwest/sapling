/**
 * Context Pipeline v1 — Orchestrating class
 *
 * SaplingPipelineV1 wires together the five pipeline stages:
 *   ingest → evaluate → compact → budget → render
 *
 * Each call to process() runs one full pipeline cycle and returns the curated
 * message array + updated system prompt for the next LLM call.
 *
 * The pipeline maintains operation registry state across calls (stateful).
 *
 * See docs/context-pipeline-v1.md for the full design specification.
 */

import type { Message } from "../../types.ts";
import { budget, estimateTokens } from "./budget.ts";
import { compact } from "./compact.ts";
import { evaluate } from "./evaluate.ts";
import { ingest } from "./ingest.ts";
import { render } from "./render.ts";
import type { Operation, PipelineInput, PipelineOutput, PipelineState } from "./types.ts";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface PipelineOptions {
	/** Total context window size in tokens. */
	windowSize: number;
	/** Whether to log pipeline decisions (verbose mode). */
	verbose?: boolean;
}

/**
 * SaplingPipelineV1 — the context pipeline for v1.
 *
 * Stateful: maintains the operation registry across turns.
 * Call process() once per turn (after tool results are appended).
 */
export class SaplingPipelineV1 {
	private operations: Operation[] = [];
	private activeOperationId: number | null = null;
	private nextOperationId = 1;
	private readonly windowSize: number;
	private readonly verbose: boolean;
	private lastState: PipelineState | null = null;

	constructor(options: PipelineOptions) {
		this.windowSize = options.windowSize;
		this.verbose = options.verbose ?? false;
	}

	/**
	 * Run one pipeline cycle.
	 *
	 * @param input.messages     - Full message array including the latest turn.
	 * @param input.systemPrompt - The agent persona (base system prompt, never modified).
	 * @param input.turnHint     - Lightweight metadata from the loop about the latest turn.
	 * @param input.usage        - Token usage from the most recent LLM response.
	 * @returns PipelineOutput with managed messages, updated system prompt, and state.
	 */
	process(input: PipelineInput): PipelineOutput {
		const { messages, systemPrompt } = input;

		// Guard: need at least a task message
		if (messages.length === 0) {
			throw new Error("Pipeline.process: messages array must not be empty");
		}

		// ── Stage 1: Ingest ────────────────────────────────────────────────────
		// Extract turns from messages and assign them to operations.
		const ingestResult = ingest(
			messages,
			this.operations,
			this.activeOperationId,
			this.nextOperationId,
		);
		this.operations = ingestResult.operations;
		this.activeOperationId = ingestResult.activeOperationId;
		this.nextOperationId = ingestResult.nextOperationId;

		if (this.verbose) {
			const activeOp = this.operations.find((op) => op.id === this.activeOperationId);
			console.error(
				`[pipeline-v1] ingest: ${this.operations.length} ops, active=${this.activeOperationId}, ` +
					`turns=${activeOp?.turns.length ?? 0}`,
			);
		}

		// ── Stage 2: Evaluate ──────────────────────────────────────────────────
		// Score each operation for relevance to the current work.
		evaluate(this.operations);

		if (this.verbose) {
			for (const op of this.operations) {
				console.error(
					`[pipeline-v1] evaluate: op#${op.id} (${op.type}) score=${op.score.toFixed(3)} status=${op.status}`,
				);
			}
		}

		// ── Stage 3: Compact ───────────────────────────────────────────────────
		// Compact low-scoring completed operations into summaries.
		compact(this.operations, this.activeOperationId);

		if (this.verbose) {
			const compacted = this.operations.filter((op) => op.status === "compacted").length;
			console.error(`[pipeline-v1] compact: ${compacted} ops compacted`);
		}

		// ── Stage 4: Budget ────────────────────────────────────────────────────
		// Move over-budget operations to "archived" status.
		const systemTokens = estimateTokens(systemPrompt);
		const budgetUtil = budget(this.operations, systemTokens, this.windowSize);

		if (this.verbose) {
			const archived = this.operations.filter((op) => op.status === "archived").length;
			console.error(
				`[pipeline-v1] budget: utilization=${(budgetUtil.utilization * 100).toFixed(1)}%, archived=${archived}`,
			);
		}

		// ── Stage 5: Render ────────────────────────────────────────────────────
		// Build the final message array and system prompt.
		const taskMessage = messages[0] as Message;
		const retainedOps = this.operations.filter((op) => op.status !== "archived");
		const archivedOps = this.operations.filter((op) => op.status === "archived");

		const output = render(
			taskMessage,
			retainedOps,
			archivedOps,
			systemPrompt,
			this.operations,
			this.activeOperationId,
			budgetUtil,
		);

		this.lastState = output.state;

		if (this.verbose) {
			console.error(
				`[pipeline-v1] render: ${output.messages.length} messages, ` +
					`${archivedOps.length} archive entries`,
			);
		}

		return output;
	}

	/**
	 * Return the last known pipeline state snapshot.
	 * Returns null before the first process() call.
	 */
	getState(): PipelineState | null {
		return this.lastState;
	}

	/**
	 * Return a compact pipeline state for RPC getState responses.
	 */
	getRpcState(): {
		activeOperationId: number | null;
		operationCount: number;
		contextUtilization: number;
		archiveEntryCount: number;
	} | null {
		if (!this.lastState) return null;
		return {
			activeOperationId: this.lastState.activeOperationId,
			operationCount: this.lastState.operations.length,
			contextUtilization: this.lastState.utilization,
			archiveEntryCount: this.lastState.operationCounts.archived,
		};
	}
}

// ---------------------------------------------------------------------------
// TurnHint extraction helper (for use in loop.ts)
// ---------------------------------------------------------------------------

/**
 * Extract a TurnHint from the most recent assistant + tool-results message pair.
 *
 * This mirrors the extractCurrentFiles() logic in loop.ts but also captures
 * hasError and tool names for the full TurnHint interface.
 */
export function extractTurnHint(
	messages: Message[],
	turnNumber: number,
): PipelineInput["turnHint"] {
	const tools: string[] = [];
	const files: string[] = [];
	let hasError = false;

	// Scan the last two messages (assistant + tool results)
	const recent = messages.slice(-2);

	for (const msg of recent) {
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "tool_use") {
					tools.push(block.name);
					const input = block.input;
					for (const key of ["path", "file", "filename", "file_path"]) {
						const val = input[key];
						if (typeof val === "string" && val.length > 0) {
							files.push(val);
						}
					}
				}
			}
		} else if (msg.role === "user" && Array.isArray(msg.content)) {
			for (const block of msg.content as Array<{
				type: string;
				is_error?: boolean;
			}>) {
				if (block.type === "tool_result" && block.is_error === true) {
					hasError = true;
				}
			}
		}
	}

	return { turn: turnNumber, tools, files, hasError };
}
