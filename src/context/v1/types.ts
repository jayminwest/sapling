/**
 * Context Pipeline v1 — Type definitions
 *
 * All data models for the v1 inter-turn context management pipeline.
 * See docs/context-pipeline-v1.md for design details.
 */

import type { Message, TokenUsage } from "../../types.ts";

export type {
	BudgetEntry,
	ContentBlock,
	Message,
	TokenUsage,
	ToolResultBlock,
} from "../../types.ts";

// ---------------------------------------------------------------------------
// Turn & TurnMetadata
// ---------------------------------------------------------------------------

/** A paired assistant+toolResults exchange. The atomic unit of the pipeline. */
export interface Turn {
	/** 0-based index within the conversation. */
	index: number;
	/** The assistant message (text + tool_use blocks). */
	assistant: Message & { role: "assistant" };
	/** The user message with tool results (null for the final incomplete turn). */
	toolResults: (Message & { role: "user" }) | null;
	/** Metadata extracted from this turn. */
	meta: TurnMetadata;
}

export interface TurnMetadata {
	/** Tool names invoked in this turn. */
	tools: string[];
	/** File paths referenced (from tool inputs and outputs). */
	files: string[];
	/** Whether any tool result was an error. */
	hasError: boolean;
	/** Whether the assistant text contains decision language. */
	hasDecision: boolean;
	/** Estimated token count for the full turn (assistant + results). */
	tokens: number;
	/** Monotonic timestamp (Date.now()) when the turn was ingested. */
	timestamp: number;
}

// ---------------------------------------------------------------------------
// Operation
// ---------------------------------------------------------------------------

export type OperationStatus = "active" | "completed" | "compacted" | "archived";

export type OperationType =
	| "explore" // reading, grepping, globbing — gathering information
	| "mutate" // writing, editing — changing files
	| "verify" // running tests, linting — checking correctness
	| "investigate" // debugging — reading errors, tracing causes
	| "mixed"; // multi-type (e.g., edit + test in a tight loop)

export interface Operation {
	/** Unique ID (monotonically increasing integer). */
	id: number;
	/** Current lifecycle state. */
	status: OperationStatus;
	/** Inferred operation type based on dominant tool usage. */
	type: OperationType;
	/** The turns that belong to this operation, in chronological order. */
	turns: Turn[];
	/** All file paths touched by this operation. */
	files: Set<string>;
	/** All tool names used in this operation. */
	tools: Set<string>;
	/** Whether the operation ended in success, failure, or is still in progress. */
	outcome: "success" | "failure" | "partial" | "in_progress";
	/** Key artifacts produced (file paths created/modified). */
	artifacts: string[];
	/** IDs of operations this one depends on. */
	dependsOn: number[];
	/** Relevance score assigned by the Evaluate stage (0.0–1.0). Updated each pipeline run. */
	score: number;
	/** Compact summary (generated when status moves to "compacted"). */
	summary: string | null;
	/** Turn index of the first turn in this operation. */
	startTurn: number;
	/** Turn index of the last turn in this operation (updated as turns are added). */
	endTurn: number;
}

// ---------------------------------------------------------------------------
// Pipeline I/O
// ---------------------------------------------------------------------------

export interface TurnHint {
	/** 1-based turn number. */
	turn: number;
	/** Tool names invoked this turn. */
	tools: string[];
	/** File paths from tool inputs (not outputs). */
	files: string[];
	/** Whether any tool result was an error. */
	hasError: boolean;
}

export interface PipelineInput {
	/** Full message array (including the just-completed turn). */
	messages: Message[];
	/** The current system prompt text. */
	systemPrompt: string;
	/** Lightweight metadata about the just-completed turn. */
	turnHint: TurnHint;
	/** Token usage from the most recent LLM response. */
	usage: TokenUsage;
}

export interface PipelineState {
	/** All operations (including archived). */
	operations: Operation[];
	/** The active operation's ID (or null if no active operation). */
	activeOperationId: number | null;
	/** Current context utilization (0.0–1.0). */
	utilization: number;
	/** Budget breakdown. */
	budget: BudgetUtilization;
	/** Number of operations in each status. */
	operationCounts: Record<OperationStatus, number>;
}

export interface PipelineOutput {
	/** Managed message array for the next LLM call. */
	messages: Message[];
	/** Updated system prompt (agent persona + working memory). */
	systemPrompt: string;
	/** Pipeline state snapshot (for RPC inspection, events, benchmarking). */
	state: PipelineState;
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export interface BudgetUtilization {
	/** Total context window size in tokens. */
	windowSize: number;
	/** Tokens allocated to system prompt + archive. */
	systemWithArchive: number;
	/** Tokens used by retained active operations. */
	activeOperations: number;
	/** Headroom remaining. */
	headroom: number;
	/** Overall utilization fraction (0.0–1.0). */
	utilization: number;
}

// ---------------------------------------------------------------------------
// Boundary detection
// ---------------------------------------------------------------------------

export type ToolPhase = "read" | "write" | "verify" | "search";

export interface BoundarySignals {
	toolTypeTransition: boolean;
	fileScopeChange: boolean;
	intentSignal: boolean;
	temporalGap: boolean;
}

// ---------------------------------------------------------------------------
// Evaluate weights
// ---------------------------------------------------------------------------

export interface EvalWeights {
	recency: number;
	fileOverlap: number;
	causalDependency: number;
	outcomeSignificance: number;
	operationType: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Boundary detection signal weights (must sum to 1.0). */
export const BOUNDARY_WEIGHTS: Readonly<Record<keyof BoundarySignals, number>> = {
	toolTypeTransition: 0.35,
	fileScopeChange: 0.3,
	intentSignal: 0.2,
	temporalGap: 0.15,
} as const;

/** Score threshold above which a boundary is declared. */
export const BOUNDARY_THRESHOLD = 0.5;

/** Maps tool names to their phase category for boundary detection. */
export const TOOL_PHASES: Readonly<Record<string, ToolPhase>> = {
	read: "read",
	grep: "search",
	glob: "search",
	write: "write",
	edit: "write",
	bash: "verify",
} as const;

/** Regex patterns indicating the agent is transitioning to a new sub-task. */
export const INTENT_PATTERNS: readonly RegExp[] = [
	/\bnow (?:let me|I(?:'ll| will| need to| should))\b/i,
	/\bnext,?\s+I\b/i,
	/\bmoving on to\b/i,
	/\blet(?:'s| us) (?:switch|move|turn) to\b/i,
	/\bthat(?:'s| is) done[.,]?\s+/i,
	/\bwith that (?:complete|finished|done)\b/i,
];

/** Evaluate stage scoring weights (must sum to 1.0). */
export const EVAL_WEIGHTS: Readonly<EvalWeights> = {
	recency: 0.25,
	fileOverlap: 0.25,
	causalDependency: 0.25,
	outcomeSignificance: 0.15,
	operationType: 0.1,
} as const;

/** Recency half-life measured in operations (score halves every N operations). */
export const RECENCY_HALF_LIFE_OPS = 4;

/** Budget zone allocations (must sum to 1.0). */
export const V1_BUDGET_ALLOCATIONS: Readonly<{
	systemWithArchive: number;
	activeOperations: number;
	headroom: number;
}> = {
	systemWithArchive: 0.25, // persona + working memory
	activeOperations: 0.25, // full turns from retained operations
	headroom: 0.5, // LLM output + safety margin
} as const;

/** Tool output truncation thresholds (in tokens). */
export const TOOL_OUTPUT_TRUNCATION: Readonly<{
	bashMaxTokens: number;
	bashKeepFirstLines: number;
	bashKeepLastLines: number;
	grepMaxTokens: number;
	readMaxTokens: number;
	readKeepFirstLines: number;
	readKeepLastLines: number;
	globMaxResults: number;
}> = {
	bashMaxTokens: 3000,
	bashKeepFirstLines: 30,
	bashKeepLastLines: 15,
	grepMaxTokens: 1500,
	readMaxTokens: 4000,
	readKeepFirstLines: 60,
	readKeepLastLines: 20,
	globMaxResults: 30,
} as const;

/** Operations with score below this threshold are eligible for compaction. */
export const COMPACTION_SCORE_THRESHOLD = 0.3;
