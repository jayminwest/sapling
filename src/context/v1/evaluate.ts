/**
 * Context Pipeline v1 — Evaluate stage
 *
 * Scores each operation for relevance to the current work.
 * See docs/context-pipeline-v1.md §4.2 for the full specification.
 */

import {
	EVAL_WEIGHTS,
	type Operation,
	type OperationType,
	RECENCY_HALF_LIFE_OPS,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Individual scoring functions (exported for testability)
// ---------------------------------------------------------------------------

/**
 * Exponential decay based on how many operations ago this one ended.
 * Half-life = RECENCY_HALF_LIFE_OPS (4 ops → score halves every 4 ops).
 */
export function recencyScore(opsAgo: number): number {
	return Math.exp((-Math.log(2) * opsAgo) / RECENCY_HALF_LIFE_OPS);
}

/**
 * Jaccard similarity between the operation's files and the active operation's files.
 * Returns 0 when either set is empty.
 */
export function fileOverlapScore(opFiles: Set<string>, activeFiles: Set<string>): number {
	if (opFiles.size === 0 || activeFiles.size === 0) return 0;
	const intersection = [...opFiles].filter((f) => activeFiles.has(f)).length;
	const union = new Set([...opFiles, ...activeFiles]).size;
	return intersection / union;
}

/**
 * Binary causal dependency: 1.0 if the active operation reads files this operation
 * produced, or if the active operation explicitly lists this operation in dependsOn.
 * Otherwise 0.0.
 */
export function causalDependencyScore(op: Operation, activeOp: Operation): number {
	// Explicit dependency recorded in the operation registry
	if (activeOp.dependsOn.includes(op.id)) return 1.0;

	// Implicit: active operation touches files this operation produced
	const opArtifacts = new Set(op.artifacts);
	if (opArtifacts.size > 0) {
		for (const f of activeOp.files) {
			if (opArtifacts.has(f)) return 1.0;
		}
	}

	return 0.0;
}

/**
 * Outcome significance with a decision-content bonus.
 * Base values: failure=1.0, in_progress=0.8, partial=0.6, success=0.3.
 * +0.2 if any turn in the operation contains decision language (capped at 1.0).
 */
export function outcomeSignificanceScore(op: Operation): number {
	let base: number;
	switch (op.outcome) {
		case "failure":
			base = 1.0;
			break;
		case "in_progress":
			base = 0.8;
			break;
		case "partial":
			base = 0.6;
			break;
		case "success":
			base = 0.3;
			break;
	}

	const hasDecision = op.turns.some((t) => t.meta.hasDecision);
	return Math.min(1.0, hasDecision ? base + 0.2 : base);
}

/**
 * Operation type score: mutate > mixed > investigate > verify > explore.
 */
export function operationTypeScore(type: OperationType): number {
	switch (type) {
		case "mutate":
			return 1.0;
		case "mixed":
			return 0.8;
		case "investigate":
			return 0.7;
		case "verify":
			return 0.6;
		case "explore":
			return 0.3;
	}
}

// ---------------------------------------------------------------------------
// Per-operation evaluation
// ---------------------------------------------------------------------------

/**
 * Compute a relevance score for a single operation.
 *
 * @param op        - The operation being scored.
 * @param activeOp  - The currently active operation (null when there is none).
 * @param totalOps  - Total number of operations in the registry (including active).
 */
export function evaluateOperation(
	op: Operation,
	activeOp: Operation | null,
	totalOps: number,
): number {
	// opsAgo = how many operations have run since this one ended.
	// When op IS the active operation, opsAgo = 0.
	const opsAgo = activeOp !== null ? totalOps - 1 - op.id : 0;
	const activeFiles = activeOp?.files ?? new Set<string>();

	const score =
		EVAL_WEIGHTS.recency * recencyScore(opsAgo) +
		EVAL_WEIGHTS.fileOverlap * fileOverlapScore(op.files, activeFiles) +
		EVAL_WEIGHTS.causalDependency * (activeOp !== null ? causalDependencyScore(op, activeOp) : 0) +
		EVAL_WEIGHTS.outcomeSignificance * outcomeSignificanceScore(op) +
		EVAL_WEIGHTS.operationType * operationTypeScore(op.type);

	return Math.min(1.0, Math.max(0.0, score));
}

// ---------------------------------------------------------------------------
// Stage entry point
// ---------------------------------------------------------------------------

/**
 * Evaluate stage: update the `score` field on every operation in-place.
 *
 * The active operation (status === "active") always receives the recency score
 * of 0 opsAgo (i.e. 1.0 recency), full self-overlap, and maximum causal weight.
 */
export function evaluate(operations: Operation[]): void {
	const totalOps = operations.length;
	const activeOp = operations.find((o) => o.status === "active") ?? null;

	for (const op of operations) {
		op.score = evaluateOperation(op, activeOp, totalOps);
	}
}
