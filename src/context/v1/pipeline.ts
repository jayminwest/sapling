/**
 * Context Pipeline v1 — Orchestrating class
 *
 * SaplingPipelineV1 wires together the five pipeline stages via a StageRegistry:
 *   ingest → evaluate → compact → budget → render
 *
 * Each call to process() runs one full pipeline cycle and returns the curated
 * message array + updated system prompt for the next LLM call.
 *
 * The pipeline maintains operation registry state across calls (stateful).
 * Callers may supply a custom StageRegistry to extend or replace stages.
 *
 * See docs/context-pipeline-v1.md for the full design specification.
 */

import type { Message } from "../../types.ts";
import { createDefaultStageRegistry, type StageRegistry } from "./registry.ts";
import type {
	Operation,
	PipelineInput,
	PipelineOutput,
	PipelineState,
	StageContext,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface PipelineOptions {
	/** Total context window size in tokens. */
	windowSize: number;
	/** Whether to log pipeline decisions (verbose mode). */
	verbose?: boolean;
	/**
	 * Custom stage registry. Defaults to createDefaultStageRegistry().
	 * Pass a custom registry to add, remove, or replace pipeline stages.
	 */
	registry?: StageRegistry;
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
	private readonly registry: StageRegistry;

	constructor(options: PipelineOptions) {
		this.windowSize = options.windowSize;
		this.verbose = options.verbose ?? false;
		this.registry = options.registry ?? createDefaultStageRegistry();
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
		const { messages } = input;

		// Guard: need at least a task message
		if (messages.length === 0) {
			throw new Error("Pipeline.process: messages array must not be empty");
		}

		// Build the shared stage context and run all pipeline stages.
		const ctx: StageContext = {
			input,
			windowSize: this.windowSize,
			verbose: this.verbose,
			operations: this.operations,
			activeOperationId: this.activeOperationId,
			nextOperationId: this.nextOperationId,
			budgetUtil: null,
			output: null,
		};

		this.registry.run(ctx);

		// Sync mutable state back from context
		this.operations = ctx.operations;
		this.activeOperationId = ctx.activeOperationId;
		this.nextOperationId = ctx.nextOperationId ?? this.nextOperationId;

		if (!ctx.output) {
			throw new Error(
				"Pipeline.process: no output produced — ensure the render stage is registered",
			);
		}

		this.lastState = ctx.output.state;
		return ctx.output;
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

	/**
	 * Expose the stage registry so callers can inspect or modify stages
	 * after construction (e.g. to add instrumentation or swap a stage).
	 */
	getRegistry(): StageRegistry {
		return this.registry;
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
