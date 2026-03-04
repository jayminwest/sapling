/**
 * Benchmark harness for the Sapling context pipeline.
 *
 * Measures token usage with and without context management on synthetic
 * conversation traces. Computes reduction ratios, context limit hit rates,
 * and archive coherence proxies.
 *
 * ## Modes
 * - **baseline**: no context management — accumulate all messages each turn
 * - **v1**: SaplingPipelineV1 runs between every turn
 *
 * ## Success Criteria
 * 1. Token usage 30–50% less than baseline on long tasks
 * 2. Agent never hits context limit unexpectedly (v1 total < window)
 */

import { extractTurnHint, SaplingPipelineV1 } from "../context/v1/pipeline.ts";
import type { BudgetUtilization, ContextBudget, Message, TokenUsage } from "../types.ts";
import type { BenchmarkScenario } from "./scenarios.ts";

// ─── Result Types ─────────────────────────────────────────────────────────────

export interface TurnMetrics {
	turn: number;
	/** Total estimated input tokens sent to the LLM this turn (context window size). */
	inputTokens: number;
	/** Messages in context window this turn. */
	messageCount: number;
	/** Utilization snapshot after context manager ran. */
	utilization: BudgetUtilization;
}

/** Per-turn metrics specific to the v1 pipeline. */
export interface V1TurnMetrics {
	turn: number;
	inputTokens: number;
	messageCount: number;
	/** Overall context utilization fraction (0.0–1.0) from PipelineState. */
	utilization: number;
	operationCount: number;
}

export interface BenchmarkResult {
	scenarioId: string;
	scenarioName: string;
	/** Number of turns executed. */
	turns: number;

	// ── Baseline (no context management) ──────────────────────────────────────
	/** Sum of estimated input tokens across all turns without context management. */
	baselineTotalInputTokens: number;
	/** Average input tokens per turn without context management. */
	baselineAvgInputTokens: number;

	// ── V1 pipeline ──────────────────────────────────────────────────────────
	v1: V1BenchmarkMetrics;

	// ── Reduction ─────────────────────────────────────────────────────────────
	/** Fraction of baseline tokens saved: (baseline - v1) / baseline. 0 if baseline == 0. */
	reductionFraction: number;
	/** reductionFraction as a percentage (0–100). */
	reductionPct: number;

	// ── Per-turn detail ───────────────────────────────────────────────────────
	baselineTurns: TurnMetrics[];

	// ── Pass / Fail ───────────────────────────────────────────────────────────
	/** Expected minimum reduction fraction for this scenario. */
	expectedReductionMin: number;
	/** Whether reduction met or exceeded the minimum expectation. */
	passesReduction: boolean;
	/** All criteria pass. */
	passes: boolean;
}

/** v1 pipeline-specific metrics appended to BenchmarkResult. */
export interface V1BenchmarkMetrics {
	/** Sum of estimated input tokens across all turns with v1 context management. */
	totalInputTokens: number;
	/** Average input tokens per turn. */
	avgInputTokens: number;
	/** Fraction of baseline tokens saved by v1. */
	reductionFraction: number;
	reductionPct: number;
	/** Peak utilization fraction across all turns. */
	peakUtilization: number;
	/** Mean utilization fraction across all turns. */
	meanUtilization: number;
	/** Total operations created during the run. */
	operationCount: number;
	/** Operations that were compacted. */
	compactedCount: number;
	/** Operations that were archived. */
	archivedCount: number;
	/** Fraction of operations compacted (compacted / total). */
	compactionRatio: number;
	/** Archive entry count at end of run (= archivedCount). */
	archiveEntryCount: number;
	/** Turns where v1 context exceeded the window budget. */
	contextLimitHits: number;
	hitContextLimit: boolean;
	/** Per-turn detail. */
	turns: V1TurnMetrics[];
}

// ─── Harness Options ──────────────────────────────────────────────────────────

export interface HarnessOptions {
	/**
	 * Context budget override. Defaults to a 200K window matching DEFAULT_BUDGET.
	 * Override for testing smaller windows.
	 */
	budget?: ContextBudget;
	/**
	 * System prompt text (used for token accounting). Defaults to a short placeholder.
	 */
	systemPrompt?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Estimate token count for a string using the 4-chars ≈ 1 token heuristic.
 */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * Estimate tokens for a single block, handling all block types including tool_result.
 * The canonical estimateBlockTokens only handles text/tool_use; benchmark messages
 * can also include tool_result blocks (from synthetic user turns).
 */
function estimateBenchBlockTokens(block: Record<string, unknown>): number {
	if (typeof block.text === "string") return estimateTokens(block.text);
	if (typeof block.name === "string") {
		// tool_use
		return estimateTokens(block.name) + estimateTokens(JSON.stringify(block.input ?? {}));
	}
	if (typeof block.content === "string") {
		// tool_result
		return estimateTokens(block.content);
	}
	return 10; // unknown block type: small constant
}

/**
 * Estimate total tokens for a message array (simulating what the LLM receives).
 * Uses a local implementation that handles all block types, including tool_result.
 */
function estimateContextTokens(messages: Message[]): number {
	return messages.reduce((sum, m) => {
		const roleOverhead = 4;
		if (typeof m.content === "string") return sum + roleOverhead + estimateTokens(m.content);
		return (
			sum +
			roleOverhead +
			(m.content as unknown as Record<string, unknown>[]).reduce(
				(blockSum: number, block: Record<string, unknown>) =>
					blockSum + estimateBenchBlockTokens(block),
				0,
			)
		);
	}, 0);
}

/**
 * Dummy token usage for driving context manager (no real LLM calls).
 */
function dummyUsage(inputTokens: number): TokenUsage {
	return { inputTokens, outputTokens: 50 };
}

/**
 * Build a zero-utilization snapshot (for baseline where there's no manager).
 */
function zeroUtilization(budget: ContextBudget): BudgetUtilization {
	const w = budget.windowSize;
	return {
		systemPrompt: { used: 0, budget: Math.floor(w * budget.allocations.systemPrompt) },
		archiveSummary: { used: 0, budget: Math.floor(w * budget.allocations.archiveSummary) },
		recentHistory: { used: 0, budget: Math.floor(w * budget.allocations.recentHistory) },
		currentTurn: { used: 0, budget: Math.floor(w * budget.allocations.currentTurn) },
		headroom: { used: w, budget: Math.floor(w * budget.allocations.headroom) },
		total: { used: 0, budget: w },
	};
}

// ─── Baseline Runner ──────────────────────────────────────────────────────────

/**
 * Run the baseline pass: accumulate all messages without pruning.
 *
 * Simulates what a naive agent would send — the full conversation grows every turn.
 * Returns per-turn input token counts and total.
 */
function runBaseline(
	taskPrompt: string,
	scenarioMessages: Message[],
	budget: ContextBudget,
): { total: number; turns: TurnMetrics[] } {
	const turnMetrics: TurnMetrics[] = [];
	let totalInputTokens = 0;

	// Seed with task prompt
	const messages: Message[] = [{ role: "user", content: taskPrompt }];

	// Walk through scenario messages pair-by-pair (assistant + user result)
	// Each assistant message triggers an LLM call; we measure the context at that point.
	let turn = 0;
	let i = 0;

	while (i < scenarioMessages.length) {
		const msg = scenarioMessages[i];
		if (!msg) break;

		if (msg.role === "assistant") {
			turn++;
			// LLM call: measure input tokens (everything in messages so far + this assistant response)
			// Before LLM call, messages contains: task + all previous turns
			const inputTokens = estimateContextTokens(messages);
			totalInputTokens += inputTokens;

			const util = zeroUtilization(budget);
			util.total.used = inputTokens;
			util.recentHistory.used = inputTokens;

			turnMetrics.push({
				turn,
				inputTokens,
				messageCount: messages.length,
				utilization: util,
			});

			// Append assistant message to the accumulating history
			messages.push(msg);
			i++;
		} else {
			// User/tool-result message: append and continue
			messages.push(msg);
			i++;
		}
	}

	return { total: totalInputTokens, turns: turnMetrics };
}

// ─── V1 Runner ────────────────────────────────────────────────────────────────

/**
 * Run the v1 pipeline pass: apply SaplingPipelineV1 between every turn.
 *
 * Extracts TurnHint from each turn's assistant+toolResults pair using the
 * same extractTurnHint helper used in loop.ts.
 */
function runV1(
	taskPrompt: string,
	scenarioMessages: Message[],
	windowSize: number,
	systemPrompt: string,
): V1BenchmarkMetrics {
	const pipeline = new SaplingPipelineV1({ windowSize });

	const turnMetrics: V1TurnMetrics[] = [];
	let totalInputTokens = 0;
	let contextLimitHits = 0;

	// Seed with task prompt
	let messages: Message[] = [{ role: "user", content: taskPrompt }];

	let turnNumber = 0;
	let i = 0;

	while (i < scenarioMessages.length) {
		const msg = scenarioMessages[i];
		if (!msg) break;

		if (msg.role === "assistant") {
			turnNumber++;

			// Measure input tokens (current managed context)
			const inputTokens = estimateContextTokens(messages);
			totalInputTokens += inputTokens;

			if (inputTokens > windowSize) {
				contextLimitHits++;
			}

			// Append assistant message
			messages.push(msg);

			// Collect tool results if present
			const next = scenarioMessages[i + 1];
			const hasResults = next !== undefined && next.role === "user";

			if (hasResults && next) {
				i++;
				messages.push(next);
			}
			i++;

			// Build TurnHint from recent messages (assistant + toolResults pair)
			const turnHint = extractTurnHint(messages, turnNumber);

			// Run v1 pipeline
			const output = pipeline.process({
				messages,
				systemPrompt,
				turnHint,
				usage: dummyUsage(inputTokens),
			});

			messages = output.messages;
			const state = output.state;

			turnMetrics.push({
				turn: turnNumber,
				inputTokens,
				messageCount: messages.length,
				utilization: state.utilization,
				operationCount: state.operations.length,
			});
		} else {
			// Standalone user message — just append
			messages.push(msg);
			i++;
		}
	}

	// Compute v1 aggregate metrics from final pipeline state
	const finalState = pipeline.getState();
	const allOps = finalState?.operations ?? [];
	const operationCount = allOps.length;
	const compactedCount = allOps.filter((op) => op.status === "compacted").length;
	const archivedCount = allOps.filter((op) => op.status === "archived").length;
	const compactionRatio = operationCount > 0 ? compactedCount / operationCount : 0;

	const utilizationValues = turnMetrics.map((t) => t.utilization);
	const peakUtilization = utilizationValues.length > 0 ? Math.max(...utilizationValues) : 0;
	const meanUtilization =
		utilizationValues.length > 0
			? utilizationValues.reduce((s, u) => s + u, 0) / utilizationValues.length
			: 0;

	return {
		totalInputTokens,
		avgInputTokens: turnMetrics.length > 0 ? Math.round(totalInputTokens / turnMetrics.length) : 0,
		reductionFraction: 0, // computed later against baseline
		reductionPct: 0,
		peakUtilization,
		meanUtilization,
		operationCount,
		compactedCount,
		archivedCount,
		compactionRatio,
		archiveEntryCount: archivedCount,
		contextLimitHits,
		hitContextLimit: contextLimitHits > 0,
		turns: turnMetrics,
	};
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run a benchmark scenario through baseline and v1 pipeline modes and return a result report.
 *
 * @param scenario - The benchmark scenario to run
 * @param options  - Harness configuration (budget override, system prompt, etc.)
 */
export function runBenchmark(
	scenario: BenchmarkScenario,
	options: HarnessOptions = {},
): BenchmarkResult {
	const budget: ContextBudget = options.budget ?? {
		windowSize: 200_000,
		allocations: {
			systemPrompt: 0.15,
			archiveSummary: 0.1,
			recentHistory: 0.4,
			currentTurn: 0.15,
			headroom: 0.2,
		},
	};
	const systemPrompt =
		options.systemPrompt ?? "You are a coding agent. Use the available tools to complete the task.";

	// Run baseline
	const baseline = runBaseline(scenario.taskPrompt, scenario.messages, budget);

	// Run v1 pipeline
	const raw = runV1(scenario.taskPrompt, scenario.messages, budget.windowSize, systemPrompt);
	const baseTotal = baseline.total;
	const v1ReductionFraction =
		baseTotal > 0 ? Math.max(0, (baseTotal - raw.totalInputTokens) / baseTotal) : 0;
	const v1Metrics: V1BenchmarkMetrics = {
		...raw,
		reductionFraction: v1ReductionFraction,
		reductionPct: Math.round(v1ReductionFraction * 100 * 10) / 10,
	};

	const baselineTotalInputTokens = baseline.total;
	const baselineTurns = baseline.turns.length;

	const turns = v1Metrics.turns.length > 0 ? v1Metrics.turns.length : baselineTurns;

	const reductionFraction =
		baselineTotalInputTokens > 0
			? Math.max(
					0,
					(baselineTotalInputTokens - v1Metrics.totalInputTokens) / baselineTotalInputTokens,
				)
			: 0;

	const passesReduction = reductionFraction >= scenario.expectedReductionMin;

	return {
		scenarioId: scenario.id,
		scenarioName: scenario.name,
		turns,

		baselineTotalInputTokens,
		baselineAvgInputTokens:
			baselineTurns > 0 ? Math.round(baselineTotalInputTokens / baselineTurns) : 0,

		v1: v1Metrics,

		reductionFraction,
		reductionPct: Math.round(reductionFraction * 100 * 10) / 10,

		baselineTurns: baseline.turns,

		expectedReductionMin: scenario.expectedReductionMin,
		passesReduction,
		passes: passesReduction,
	};
}

/**
 * Run all scenarios and return results.
 */
export function runAllBenchmarks(
	scenarios: BenchmarkScenario[],
	options: HarnessOptions = {},
): BenchmarkResult[] {
	return scenarios.map((s) => runBenchmark(s, options));
}

/**
 * Format a BenchmarkResult as a human-readable summary string.
 */
export function formatResult(result: BenchmarkResult): string {
	const status = result.passes ? "PASS" : "FAIL";
	const v1 = result.v1;
	const lines = [
		`[${status}] ${result.scenarioName}`,
		`  turns: ${result.turns}`,
		`  baseline total input tokens: ${result.baselineTotalInputTokens.toLocaleString()} (avg ${result.baselineAvgInputTokens.toLocaleString()}/turn)`,
		`  v1 total tokens: ${v1.totalInputTokens.toLocaleString()} (avg ${v1.avgInputTokens.toLocaleString()}/turn)`,
		`  reduction: ${result.reductionPct}% (expected ≥${Math.round(result.expectedReductionMin * 100)}%)  ${result.passesReduction ? "✓" : "✗"}`,
		`  context limit hits: ${v1.contextLimitHits}`,
		`  v1 peak util: ${(v1.peakUtilization * 100).toFixed(1)}%  mean util: ${(v1.meanUtilization * 100).toFixed(1)}%`,
		`  v1 ops: ${v1.operationCount} total, ${v1.compactedCount} compacted, ${v1.archivedCount} archived (compaction ratio: ${(v1.compactionRatio * 100).toFixed(0)}%)`,
	];
	return lines.join("\n");
}
