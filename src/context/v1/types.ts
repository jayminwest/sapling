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
	ToolPipelineMetadata,
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
	/** Future-action promises extracted from the assistant's text (e.g., "I will edit foo.ts"). */
	commitments?: string[];
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
	/** Commitments made during this operation that were not fulfilled (computed at finalization). */
	pendingCommitments?: string[];
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
	/** True when a tool result contains a [STEER] block with redirect language. */
	steerRedirect: boolean;
}

// ---------------------------------------------------------------------------
// Evaluate weights & signal registry
// ---------------------------------------------------------------------------

export interface EvalWeights {
	recency: number;
	fileOverlap: number;
	causalDependency: number;
	outcomeSignificance: number;
	operationType: number;
}

/** Context passed to each signal's scoring function. */
export interface EvalSignalContext {
	/** The operation being scored. */
	op: Operation;
	/** The currently active operation (null when there is none). */
	activeOp: Operation | null;
	/** How many operations ago this one ended (0 = active). */
	opsAgo: number;
	/** Files touched by the active operation (empty Set when no active op). */
	activeFiles: Set<string>;
}

/**
 * A pluggable evaluation signal.
 * Weights are auto-normalized when building a registry, so they do not need
 * to sum to 1.0 — only their relative magnitudes matter.
 */
export interface EvalSignal {
	/** Human-readable identifier (e.g. "recency", "fileOverlap"). */
	name: string;
	/** Relative weight for this signal (will be normalized by the registry). */
	weight: number;
	/** Returns a score in [0, 1] for the given context. */
	scoreFn: (ctx: EvalSignalContext) => number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Boundary detection signal weights for weighted signals (must sum to 1.0).
 * Note: steerRedirect is handled as an unconditional override in detectBoundary
 * and is not included in this weighted sum.
 */
export const BOUNDARY_WEIGHTS: Readonly<{
	toolTypeTransition: number;
	fileScopeChange: number;
	intentSignal: number;
	temporalGap: number;
}> = {
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

/**
 * Regex patterns that identify redirect language in [STEER] payloads.
 * A match signals that the steer message is redirecting the agent to a new task,
 * warranting an operation boundary.
 */
export const STEER_REDIRECT_PATTERNS: readonly RegExp[] = [
	/\bstop (?:what you(?:'re| are) doing|the current task|that)\b/i,
	/\binstead[,.]?\s+(?:do|focus|work|try|implement|start|fix|write|run)\b/i,
	/\bnew (?:priority|task|direction|goal|objective)\b/i,
	/\bignore (?:what|that|the current|the previous)\b/i,
	/\bchange of plans?\b/i,
	/\bcancel (?:that|what you|the current)\b/i,
	/\bscratch that\b/i,
	/\bnever mind\b/i,
	/\bpivot to\b/i,
	/\babandon (?:that|this|the current)\b/i,
	/\bactually[,.]?\s+(?:do|let(?:'s| us)|I want|please|focus|start|fix|write|run)\b/i,
	/\bforget (?:about )?(?:what|that|the current|the previous)\b/i,
] as const;

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

/**
 * Per-zone min/max fraction bounds used during dynamic budget rebalancing.
 * Unused budget in underutilized zones is redistributed to zones that need more.
 * min ensures each zone always receives a floor; max prevents monopolization.
 */
export const V1_ZONE_BOUNDS: Readonly<{
	systemWithArchive: { min: number; max: number };
	activeOperations: { min: number; max: number };
	headroom: { min: number; max: number };
}> = {
	systemWithArchive: { min: 0.1, max: 0.35 },
	activeOperations: { min: 0.15, max: 0.4 },
	headroom: { min: 0.3, max: 0.6 },
} as const;

/** Tool output truncation thresholds (in tokens). */
export const TOOL_OUTPUT_TRUNCATION: Readonly<{
	bashMaxTokens: number;
	bashKeepFirstLines: number;
	bashKeepLastLines: number;
	/** Aggressive bash limit applied to failure-outcome operations. */
	failureBashMaxTokens: number;
	grepMaxTokens: number;
	readMaxTokens: number;
	readKeepFirstLines: number;
	readKeepLastLines: number;
	globMaxResults: number;
}> = {
	bashMaxTokens: 3000,
	bashKeepFirstLines: 30,
	bashKeepLastLines: 15,
	failureBashMaxTokens: 1000,
	grepMaxTokens: 1500,
	readMaxTokens: 4000,
	readKeepFirstLines: 60,
	readKeepLastLines: 20,
	globMaxResults: 30,
} as const;

/**
 * Maximum fraction of the operation budget that any single non-active operation may consume.
 * Completed/compacted operations exceeding this cap are archived even if budget remains,
 * preventing large failure-output turns from monopolizing the history zone.
 */
export const MAX_SINGLE_OP_BUDGET_FRACTION = 0.5;

/** Operations with score below this threshold are eligible for compaction. */
export const COMPACTION_SCORE_THRESHOLD = 0.3;

// ---------------------------------------------------------------------------
// Stage registry
// ---------------------------------------------------------------------------

/**
 * Shared mutable context passed through every pipeline stage in a single
 * process() cycle. Stages read from and write to this object to communicate
 * intermediate results.
 */
export interface StageContext {
	/** The full pipeline input for this cycle. */
	input: PipelineInput;
	/** Total context window size (from PipelineOptions). */
	windowSize: number;
	/** Whether to emit verbose debug logs to stderr. */
	verbose: boolean;
	/** Operation registry — mutated in place by ingest / compact / budget stages. */
	operations: Operation[];
	/** Currently active operation ID — updated by the ingest stage. */
	activeOperationId: number | null;
	/** Next operation ID counter — updated by the ingest stage. Defaults to 1 if not provided. */
	nextOperationId?: number;
	/** Budget result — set by the budget stage, consumed by the render stage. */
	budgetUtil: BudgetUtilization | null;
	/** Final pipeline output — set by the render stage. */
	output: PipelineOutput | null;
}

/**
 * A single composable stage in the context pipeline.
 *
 * Stages are registered in order and called sequentially by StageRegistry.run().
 * Each stage reads from and writes to the shared StageContext.
 */
export interface PipelineStage {
	/** Unique name for this stage (e.g. "ingest", "evaluate", "compact"). */
	readonly name: string;
	/** Execute this stage, mutating ctx as needed. */
	execute(ctx: StageContext): void;
}
