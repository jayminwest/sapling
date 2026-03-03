/**
 * Benchmark harness for the Sapling context pipeline.
 *
 * Measures token usage with and without context management on synthetic
 * conversation traces. Computes reduction ratios, context limit hit rates,
 * and archive coherence proxies.
 *
 * ## Modes
 * - **baseline**: no context management — accumulate all messages each turn
 * - **managed**: SaplingContextManager runs between every turn
 *
 * ## Success Criteria (from MVP spec step 7)
 * 1. Token usage 30–50% less than baseline on long tasks
 * 2. Agent never hits context limit unexpectedly (managed total < window)
 * 3. Coherence doesn't degrade: archive is non-empty after pruning
 */

import { renderArchive } from "../context/archive.ts";
import { SaplingContextManager } from "../context/manager.ts";
import { estimateTokens } from "../context/measure.ts";
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

	// ── Managed (with context management) ─────────────────────────────────────
	/** Sum of estimated input tokens across all turns with context management. */
	managedTotalInputTokens: number;
	/** Average input tokens per turn with context management. */
	managedAvgInputTokens: number;

	// ── Reduction ─────────────────────────────────────────────────────────────
	/** Fraction of baseline tokens saved: (baseline - managed) / baseline. 0 if baseline == 0. */
	reductionFraction: number;
	/** reductionFraction as a percentage (0–100). */
	reductionPct: number;

	// ── Context Limit ─────────────────────────────────────────────────────────
	/** Turns where managed context exceeded the window budget. */
	contextLimitHits: number;
	/** Whether any turn exceeded the budget. */
	hitContextLimit: boolean;

	// ── Archive (coherence proxy) ──────────────────────────────────────────────
	/** Token count of the archive at the end of the run. */
	archiveFinalTokens: number;
	/** Whether the archive accumulated any content (coherence proxy). */
	archiveHasContent: boolean;

	// ── Per-turn detail ───────────────────────────────────────────────────────
	baselineTurns: TurnMetrics[];
	managedTurns: TurnMetrics[];

	// ── Pass / Fail ───────────────────────────────────────────────────────────
	/** Expected minimum reduction fraction for this scenario. */
	expectedReductionMin: number;
	/** Whether reduction met or exceeded the minimum expectation. */
	passesReduction: boolean;
	/** Whether no context limit was exceeded. */
	passesNoLimitHit: boolean;
	/** Whether coherence proxy passed (archive has content for scenarios > 10 turns). */
	passesCoherence: boolean;
	/** All criteria pass. */
	passes: boolean;
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
	/**
	 * If true, run only the managed pass (skip baseline). Useful when you only
	 * need the managed metrics.
	 */
	managedOnly?: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
 * Extract file paths from a message array for context manager currentFiles hints.
 * Looks at the last 5 messages for tool_use blocks with file paths.
 */
function extractCurrentFiles(messages: Message[]): string[] {
	const files = new Set<string>();
	const recent = messages.slice(-5);
	for (const msg of recent) {
		if (typeof msg.content === "string") continue;
		for (const block of msg.content) {
			if (block.type === "tool_use") {
				const { input } = block;
				if (typeof input.file_path === "string") files.add(input.file_path);
				if (typeof input.path === "string") files.add(input.path);
			}
		}
	}
	return Array.from(files);
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

// ─── Managed Runner ───────────────────────────────────────────────────────────

/**
 * Run the managed pass: apply SaplingContextManager between every turn.
 *
 * The context manager prunes, archives, and reshapes the message array.
 * Returns per-turn input token counts, context limit hits, and the final archive.
 */
function runManaged(
	taskPrompt: string,
	scenarioMessages: Message[],
	budget: ContextBudget,
	systemPrompt: string,
): {
	total: number;
	turns: TurnMetrics[];
	contextLimitHits: number;
	archiveFinalTokens: number;
} {
	const systemTokens = estimateTokens(systemPrompt);
	const manager = new SaplingContextManager({ budget, systemPromptTokens: systemTokens });

	const turnMetrics: TurnMetrics[] = [];
	let totalInputTokens = 0;
	let contextLimitHits = 0;

	// Seed with task prompt
	let messages: Message[] = [{ role: "user", content: taskPrompt }];

	let turn = 0;
	let i = 0;

	while (i < scenarioMessages.length) {
		const msg = scenarioMessages[i];
		if (!msg) break;

		if (msg.role === "assistant") {
			turn++;
			// Measure input tokens (current managed context)
			const inputTokens = estimateContextTokens(messages);
			totalInputTokens += inputTokens;

			// Check if we exceeded the budget
			if (inputTokens > budget.windowSize) {
				contextLimitHits++;
			}

			// Append assistant message
			messages.push(msg);

			// If this is the final turn (no following user result), run manager and stop
			const next = scenarioMessages[i + 1];
			if (!next || next.role === "assistant") {
				// Final assistant message: run manager to finalize archive
				const currentFiles = extractCurrentFiles(messages);
				messages = manager.process(messages, dummyUsage(inputTokens), currentFiles);

				const util = manager.getUtilization();
				turnMetrics.push({ turn, inputTokens, messageCount: messages.length, utilization: util });
				i++;
				continue;
			}

			// Append the following user result message
			i++;
			const userMsg = scenarioMessages[i];
			if (userMsg) {
				messages.push(userMsg);
			}
			i++;

			// Run context manager
			const currentFiles = extractCurrentFiles(messages);
			messages = manager.process(messages, dummyUsage(inputTokens), currentFiles);

			const util = manager.getUtilization();
			turnMetrics.push({ turn, inputTokens, messageCount: messages.length, utilization: util });
		} else {
			// Standalone user message (e.g., "[Acknowledged]") — just append
			messages.push(msg);
			i++;
		}
	}

	const archiveFinalTokens = estimateTokens(renderArchive(manager.getArchive()));

	return { total: totalInputTokens, turns: turnMetrics, contextLimitHits, archiveFinalTokens };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run a benchmark scenario through baseline and managed modes and return a result report.
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
	const baseline = options.managedOnly
		? { total: 0, turns: [] as TurnMetrics[] }
		: runBaseline(scenario.taskPrompt, scenario.messages, budget);

	// Run managed
	const managed = runManaged(scenario.taskPrompt, scenario.messages, budget, systemPrompt);

	const baselineTotalInputTokens = baseline.total;
	const managedTotalInputTokens = managed.total;

	const baselineTurns = baseline.turns.length;
	const managedTurns = managed.turns.length;

	const turns = managedTurns > 0 ? managedTurns : baselineTurns;

	const reductionFraction =
		baselineTotalInputTokens > 0
			? Math.max(0, (baselineTotalInputTokens - managedTotalInputTokens) / baselineTotalInputTokens)
			: 0;

	const archiveHasContent = managed.archiveFinalTokens > 0;
	const passesReduction = reductionFraction >= scenario.expectedReductionMin;
	const passesNoLimitHit = managed.contextLimitHits === 0;
	// Coherence proxy: for scenarios with >10 turns, archive should have content
	const passesCoherence = turns <= 10 || archiveHasContent;

	return {
		scenarioId: scenario.id,
		scenarioName: scenario.name,
		turns,

		baselineTotalInputTokens,
		baselineAvgInputTokens:
			baselineTurns > 0 ? Math.round(baselineTotalInputTokens / baselineTurns) : 0,

		managedTotalInputTokens,
		managedAvgInputTokens:
			managedTurns > 0 ? Math.round(managedTotalInputTokens / managedTurns) : 0,

		reductionFraction,
		reductionPct: Math.round(reductionFraction * 100 * 10) / 10,

		contextLimitHits: managed.contextLimitHits,
		hitContextLimit: managed.contextLimitHits > 0,

		archiveFinalTokens: managed.archiveFinalTokens,
		archiveHasContent,

		baselineTurns: baseline.turns,
		managedTurns: managed.turns,

		expectedReductionMin: scenario.expectedReductionMin,
		passesReduction,
		passesNoLimitHit,
		passesCoherence,
		passes: passesReduction && passesNoLimitHit && passesCoherence,
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
	const lines = [
		`[${status}] ${result.scenarioName}`,
		`  turns: ${result.turns}`,
		`  baseline total input tokens: ${result.baselineTotalInputTokens.toLocaleString()} (avg ${result.baselineAvgInputTokens.toLocaleString()}/turn)`,
		`  managed  total input tokens: ${result.managedTotalInputTokens.toLocaleString()} (avg ${result.managedAvgInputTokens.toLocaleString()}/turn)`,
		`  reduction: ${result.reductionPct}% (expected ≥${Math.round(result.expectedReductionMin * 100)}%)  ${result.passesReduction ? "✓" : "✗"}`,
		`  context limit hits: ${result.contextLimitHits}  ${result.passesNoLimitHit ? "✓" : "✗"}`,
		`  archive tokens: ${result.archiveFinalTokens}  ${result.passesCoherence ? "✓" : "✗"}`,
	];
	return lines.join("\n");
}
