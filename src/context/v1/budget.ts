/**
 * Context Pipeline v1 — Budget stage
 *
 * Enforces the 25/25/50 budget allocation:
 *   - 25% system prompt + archive (persona + working memory)
 *   - 25% active operations (retained full turns)
 *   - 50% headroom (LLM output + safety margin)
 *
 * Completed/compacted operations are sorted by score and greedily filled into
 * the operation budget. Operations that don't fit are moved to "archived" status.
 *
 * Archive overflow: when the archive section of the system prompt exceeds its
 * budget, the oldest entries are dropped (FIFO).
 *
 * See docs/context-pipeline-v1.md §4.4 for the full specification.
 */

import {
	type BudgetUtilization,
	MAX_SINGLE_OP_BUDGET_FRACTION,
	type Operation,
	V1_BUDGET_ALLOCATIONS,
	V1_ZONE_BOUNDS,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/** Characters-per-token heuristic (matches the rest of the pipeline). */
const CHARS_PER_TOKEN = 4;

/**
 * Estimate the token count for a string using the 4-chars/token heuristic.
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Estimate the total token footprint of an operation (all its turns).
 *
 * For compacted operations the summary string is used directly.
 * For active/completed operations the raw turn messages are counted.
 */
export function operationTokens(op: Operation): number {
	if (op.status === "compacted" && op.summary !== null) {
		// Compact representation: summary + small overhead for the ack message
		return estimateTokens(op.summary) + 10;
	}

	// Full turns: count every assistant message and tool results message
	let total = 0;
	for (const turn of op.turns) {
		total += turn.meta.tokens;
	}
	return total;
}

// ---------------------------------------------------------------------------
// Dynamic budget rebalancing
// ---------------------------------------------------------------------------

/**
 * Rebalance budget zones based on actual system prompt usage.
 *
 * Starting from the default 25/25/50 split, unused system budget (surplus)
 * flows to activeOperations (up to its max bound), then any remaining surplus
 * flows to headroom (up to its max bound). The system zone never drops below
 * its min bound.
 *
 * The returned token counts sum to approximately windowSize (floor rounding may
 * cause ±1-token drift).
 *
 * @param windowSize          - Total context window size in tokens.
 * @param systemActualTokens  - Actual token count of the current system prompt.
 * @returns Rebalanced token budgets for each zone.
 */
export function rebalanceBudget(
	windowSize: number,
	systemActualTokens: number,
): { systemWithArchive: number; activeOperations: number; headroom: number } {
	const defaultSystem = Math.floor(windowSize * V1_BUDGET_ALLOCATIONS.systemWithArchive);
	const defaultOps = Math.floor(windowSize * V1_BUDGET_ALLOCATIONS.activeOperations);
	const defaultHead = Math.floor(windowSize * V1_BUDGET_ALLOCATIONS.headroom);

	const sysMin = Math.floor(windowSize * V1_ZONE_BOUNDS.systemWithArchive.min);
	const opsMax = Math.floor(windowSize * V1_ZONE_BOUNDS.activeOperations.max);
	const headMax = Math.floor(windowSize * V1_ZONE_BOUNDS.headroom.max);

	// System zone keeps at least sysMin regardless of actual usage.
	// The surplus is what the system zone can give away.
	const effectiveSysFloor = Math.max(sysMin, systemActualTokens);
	const surplus = Math.max(0, defaultSystem - effectiveSysFloor);

	// Step 1: redistribute surplus to activeOperations (up to opsMax)
	const opsGain = Math.min(surplus, Math.max(0, opsMax - defaultOps));
	const remainingSurplus = surplus - opsGain;

	// Step 2: any remaining surplus goes to headroom (up to headMax)
	const headGain = Math.min(remainingSurplus, Math.max(0, headMax - defaultHead));

	return {
		systemWithArchive: defaultSystem - opsGain - headGain,
		activeOperations: defaultOps + opsGain,
		headroom: defaultHead + headGain,
	};
}

// ---------------------------------------------------------------------------
// Core budget enforcement
// ---------------------------------------------------------------------------

export interface BudgetResult {
	/** Operations to keep in the message history (active + retained completed). */
	retained: Operation[];
	/** Operations moved to archived status (their summaries go to system prompt). */
	archived: Operation[];
	/** Budget utilization breakdown. */
	budget: BudgetUtilization;
}

/**
 * Enforce the active-operations budget.
 *
 * 1. Active operation is always retained.
 * 2. Completed/compacted operations are sorted by score (descending).
 * 3. Greedily add operations until the budget is exhausted.
 * 4. Remaining operations are archived.
 *
 * @param operations       - All operations in the registry.
 * @param systemPromptTokens - Current system prompt token count (persona + existing archive).
 * @param windowSize       - Total context window size in tokens.
 */
export function enforceBudget(
	operations: Operation[],
	systemPromptTokens: number,
	windowSize: number,
): BudgetResult {
	// Rebalance zones: unused system budget flows to operations (and headroom).
	const zones = rebalanceBudget(windowSize, systemPromptTokens);
	const operationBudget = zones.activeOperations;

	// Active operation is always retained regardless of score or budget
	const activeOps = operations.filter((op) => op.status === "active");

	// Completed and compacted operations compete for the operation budget
	const completed = operations
		.filter((op) => op.status === "completed" || op.status === "compacted")
		.sort((a, b) => b.score - a.score);

	const retained: Operation[] = [...activeOps];
	const archived: Operation[] = [];

	let usedTokens = activeOps.reduce((sum, op) => sum + operationTokens(op), 0);

	// Per-operation cap: no single completed/compacted operation may consume more than this
	// fraction of the operation budget, preventing large failure-output turns from monopolizing
	// the history zone even when budget technically remains.
	const perOpCap = Math.floor(operationBudget * MAX_SINGLE_OP_BUDGET_FRACTION);

	for (const op of completed) {
		const tokens = operationTokens(op);
		// Archive operations that individually exceed the per-op cap regardless of budget remaining
		if (tokens > perOpCap) {
			archived.push(op);
			continue;
		}
		if (usedTokens + tokens <= operationBudget) {
			retained.push(op);
			usedTokens += tokens;
		} else {
			archived.push(op);
		}
	}

	// Build utilization breakdown using rebalanced zone allocations
	const systemBudget = zones.systemWithArchive;
	const headroomBudget = zones.headroom;
	const utilization = (systemPromptTokens + usedTokens) / windowSize;

	const budget: BudgetUtilization = {
		windowSize,
		systemWithArchive: systemBudget,
		activeOperations: usedTokens,
		headroom: headroomBudget,
		utilization: Math.min(1.0, utilization),
	};

	return { retained, archived, budget };
}

// ---------------------------------------------------------------------------
// Archive overflow management
// ---------------------------------------------------------------------------

export interface ArchiveEntry {
	/** Operation ID this entry was derived from. */
	operationId: number;
	/** The summary text for this archived operation. */
	summary: string;
	/** Estimated token count for this entry. */
	tokens: number;
}

/**
 * Enforce the archive size limit within the system prompt zone.
 *
 * Available archive budget = systemBudget - personaTokens.
 * Drops oldest entries first (FIFO) when the archive overflows.
 *
 * @param entries        - Current archive entries in chronological order (oldest first).
 * @param personaTokens  - Token count of the agent persona section.
 * @param windowSize     - Total context window size in tokens.
 * @returns              - Entries that fit within the budget (oldest dropped first).
 */
export function enforceArchiveBudget(
	entries: ArchiveEntry[],
	personaTokens: number,
	windowSize: number,
): { retained: ArchiveEntry[]; dropped: ArchiveEntry[] } {
	const systemBudget = Math.floor(windowSize * V1_BUDGET_ALLOCATIONS.systemWithArchive);
	const availableForArchive = Math.max(0, systemBudget - personaTokens);

	const dropped: ArchiveEntry[] = [];
	// Work on a copy so we don't mutate the caller's array
	const candidate = [...entries];

	// Drop oldest entries (FIFO) until total fits within budget
	let totalTokens = candidate.reduce((sum, e) => sum + e.tokens, 0);
	while (totalTokens > availableForArchive && candidate.length > 0) {
		const oldest = candidate.shift();
		if (!oldest) break;
		dropped.push(oldest);
		totalTokens -= oldest.tokens;
	}

	return { retained: candidate, dropped };
}

// ---------------------------------------------------------------------------
// Stage entry point
// ---------------------------------------------------------------------------

/**
 * Budget stage: move over-budget operations to "archived" status in-place,
 * and return budget utilization details.
 *
 * Operations marked "archived" by this function should have their summaries
 * moved to the system prompt's working memory section by the Render stage.
 *
 * @param operations         - All operations in the registry (mutated in-place).
 * @param systemPromptTokens - Token count of the current system prompt.
 * @param windowSize         - Total context window size in tokens.
 * @returns                  - Budget utilization breakdown.
 */
export function budget(
	operations: Operation[],
	systemPromptTokens: number,
	windowSize: number,
): BudgetUtilization {
	const result = enforceBudget(operations, systemPromptTokens, windowSize);

	// Mark archived operations in-place
	for (const op of result.archived) {
		op.status = "archived";
	}

	return result.budget;
}
