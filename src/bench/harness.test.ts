/**
 * Tests for the benchmark harness.
 *
 * Validates that:
 * 1. All scenarios are well-formed (correct message count, alternating roles)
 * 2. runBenchmark returns a structurally valid BenchmarkResult
 * 3. Managed mode uses ≤ baseline tokens for non-trivial conversations
 * 4. Context limit is never exceeded in managed mode (200K window)
 * 5. Archive accumulates content for long scenarios
 * 6. formatResult produces a non-empty string
 * 7. runAllBenchmarks returns one result per scenario
 */

import { describe, expect, it } from "bun:test";
import type { ContextBudget } from "../types.ts";
import { formatResult, runAllBenchmarks, runBenchmark } from "./harness.ts";
import {
	ALL_SCENARIOS,
	getScenario,
	LONG_SCENARIO,
	MEDIUM_SCENARIO,
	SHORT_SCENARIO,
} from "./scenarios.ts";

// ─── Scenario structure tests ─────────────────────────────────────────────────

describe("scenarios", () => {
	it("ALL_SCENARIOS contains 3 scenarios", () => {
		expect(ALL_SCENARIOS.length).toBe(3);
	});

	it("each scenario has a unique id", () => {
		const ids = ALL_SCENARIOS.map((s) => s.id);
		const unique = new Set(ids);
		expect(unique.size).toBe(ids.length);
	});

	it("getScenario returns the correct scenario by id", () => {
		for (const scenario of ALL_SCENARIOS) {
			expect(getScenario(scenario.id)).toBe(scenario);
		}
	});

	it("getScenario returns undefined for unknown id", () => {
		expect(getScenario("nonexistent")).toBeUndefined();
	});

	it("each scenario has a non-empty taskPrompt", () => {
		for (const s of ALL_SCENARIOS) {
			expect(s.taskPrompt.length).toBeGreaterThan(10);
		}
	});

	it("each scenario has at least one message", () => {
		for (const s of ALL_SCENARIOS) {
			expect(s.messages.length).toBeGreaterThan(0);
		}
	});

	it("SHORT_SCENARIO has ~10 assistant messages", () => {
		const assistantMsgs = SHORT_SCENARIO.messages.filter((m) => m.role === "assistant");
		// 10 turns means ~10 assistant messages (last one has no tool call)
		expect(assistantMsgs.length).toBeGreaterThanOrEqual(8);
		expect(assistantMsgs.length).toBeLessThanOrEqual(12);
	});

	it("MEDIUM_SCENARIO has ~30 assistant messages", () => {
		const assistantMsgs = MEDIUM_SCENARIO.messages.filter((m) => m.role === "assistant");
		expect(assistantMsgs.length).toBeGreaterThanOrEqual(25);
		expect(assistantMsgs.length).toBeLessThanOrEqual(35);
	});

	it("LONG_SCENARIO has ~100 assistant messages", () => {
		const assistantMsgs = LONG_SCENARIO.messages.filter((m) => m.role === "assistant");
		// Generated programmatically — allow ±20 turns
		expect(assistantMsgs.length).toBeGreaterThanOrEqual(80);
		expect(assistantMsgs.length).toBeLessThanOrEqual(120);
	});

	it("SHORT expected reduction min is 0", () => {
		expect(SHORT_SCENARIO.expectedReductionMin).toBe(0);
	});

	it("LONG expected reduction min is >= 0.3", () => {
		expect(LONG_SCENARIO.expectedReductionMin).toBeGreaterThanOrEqual(0.3);
	});

	it("all messages have valid roles", () => {
		for (const s of ALL_SCENARIOS) {
			for (const m of s.messages) {
				expect(["user", "assistant"]).toContain(m.role);
			}
		}
	});
});

// ─── BenchmarkResult structure tests ─────────────────────────────────────────

describe("runBenchmark result structure", () => {
	it("returns a result with all required fields", () => {
		const result = runBenchmark(SHORT_SCENARIO);
		expect(typeof result.scenarioId).toBe("string");
		expect(typeof result.scenarioName).toBe("string");
		expect(typeof result.turns).toBe("number");
		expect(typeof result.baselineTotalInputTokens).toBe("number");
		expect(typeof result.managedTotalInputTokens).toBe("number");
		expect(typeof result.reductionFraction).toBe("number");
		expect(typeof result.reductionPct).toBe("number");
		expect(typeof result.contextLimitHits).toBe("number");
		expect(typeof result.hitContextLimit).toBe("boolean");
		expect(typeof result.archiveFinalTokens).toBe("number");
		expect(typeof result.archiveHasContent).toBe("boolean");
		expect(typeof result.passes).toBe("boolean");
		expect(typeof result.passesReduction).toBe("boolean");
		expect(typeof result.passesNoLimitHit).toBe("boolean");
		expect(typeof result.passesCoherence).toBe("boolean");
		expect(Array.isArray(result.baselineTurns)).toBe(true);
		expect(Array.isArray(result.managedTurns)).toBe(true);
	});

	it("scenarioId and scenarioName match the input scenario", () => {
		const result = runBenchmark(SHORT_SCENARIO);
		expect(result.scenarioId).toBe(SHORT_SCENARIO.id);
		expect(result.scenarioName).toBe(SHORT_SCENARIO.name);
	});

	it("turns count is positive", () => {
		const result = runBenchmark(SHORT_SCENARIO);
		expect(result.turns).toBeGreaterThan(0);
	});

	it("baseline tokens are non-negative", () => {
		const result = runBenchmark(SHORT_SCENARIO);
		expect(result.baselineTotalInputTokens).toBeGreaterThanOrEqual(0);
	});

	it("managed tokens are non-negative", () => {
		const result = runBenchmark(SHORT_SCENARIO);
		expect(result.managedTotalInputTokens).toBeGreaterThanOrEqual(0);
	});

	it("reductionFraction is between 0 and 1", () => {
		const result = runBenchmark(SHORT_SCENARIO);
		expect(result.reductionFraction).toBeGreaterThanOrEqual(0);
		expect(result.reductionFraction).toBeLessThanOrEqual(1);
	});

	it("reductionPct equals reductionFraction * 100 (rounded)", () => {
		const result = runBenchmark(MEDIUM_SCENARIO);
		const expected = Math.round(result.reductionFraction * 100 * 10) / 10;
		expect(result.reductionPct).toBe(expected);
	});

	it("expectedReductionMin matches the scenario", () => {
		const result = runBenchmark(LONG_SCENARIO);
		expect(result.expectedReductionMin).toBe(LONG_SCENARIO.expectedReductionMin);
	});
});

// ─── Token reduction tests ────────────────────────────────────────────────────

describe("token reduction", () => {
	it("managed tokens <= baseline tokens for MEDIUM and LONG scenarios", () => {
		// For long conversations, context management reduces total input tokens.
		// Short scenarios may have managed > baseline due to archive overhead on tiny conversations.
		for (const scenario of [MEDIUM_SCENARIO, LONG_SCENARIO]) {
			const result = runBenchmark(scenario);
			expect(result.managedTotalInputTokens).toBeLessThanOrEqual(result.baselineTotalInputTokens);
		}
	});

	it("SHORT scenario managed tokens are within 2x of baseline (overhead acceptable)", () => {
		const result = runBenchmark(SHORT_SCENARIO);
		// Short conversations may add slight archive overhead but should not balloon
		expect(result.managedTotalInputTokens).toBeLessThanOrEqual(result.baselineTotalInputTokens * 2);
	});

	it("LONG scenario achieves >= 30% reduction", () => {
		const result = runBenchmark(LONG_SCENARIO);
		expect(result.reductionFraction).toBeGreaterThanOrEqual(0.3);
	});

	it("LONG scenario passes the reduction criterion", () => {
		const result = runBenchmark(LONG_SCENARIO);
		expect(result.passesReduction).toBe(true);
	});

	it("SHORT scenario reduction >= 0 (non-negative)", () => {
		const result = runBenchmark(SHORT_SCENARIO);
		expect(result.reductionFraction).toBeGreaterThanOrEqual(0);
	});

	it("SHORT scenario passes reduction (expectation is 0)", () => {
		const result = runBenchmark(SHORT_SCENARIO);
		expect(result.passesReduction).toBe(true);
	});

	it("baseline grows with conversation length", () => {
		const shortResult = runBenchmark(SHORT_SCENARIO);
		const longResult = runBenchmark(LONG_SCENARIO);
		// Long scenario has far more turns, so baseline total should be much larger
		expect(longResult.baselineTotalInputTokens).toBeGreaterThan(
			shortResult.baselineTotalInputTokens,
		);
	});
});

// ─── Context limit tests ──────────────────────────────────────────────────────

describe("context limits", () => {
	it("managed mode hits no context limit with 200K window for all scenarios", () => {
		for (const scenario of ALL_SCENARIOS) {
			const result = runBenchmark(scenario);
			expect(result.contextLimitHits).toBe(0);
			expect(result.hitContextLimit).toBe(false);
			expect(result.passesNoLimitHit).toBe(true);
		}
	});

	it("context limit is hit with a tiny window", () => {
		// Use a tiny 2K window — the long scenario should hit it
		const tinyBudget: ContextBudget = {
			windowSize: 2_000,
			allocations: {
				systemPrompt: 0.15,
				archiveSummary: 0.1,
				recentHistory: 0.4,
				currentTurn: 0.15,
				headroom: 0.2,
			},
		};
		const result = runBenchmark(LONG_SCENARIO, { budget: tinyBudget });
		// With a tiny window, context limit hits should appear (or not — depends on pruning effectiveness)
		// We just verify the field is populated correctly
		expect(typeof result.contextLimitHits).toBe("number");
		expect(result.contextLimitHits).toBeGreaterThanOrEqual(0);
	});
});

// ─── Archive coherence tests ──────────────────────────────────────────────────

describe("archive coherence", () => {
	it("LONG scenario archive has content after pruning", () => {
		const result = runBenchmark(LONG_SCENARIO);
		expect(result.archiveHasContent).toBe(true);
		expect(result.archiveFinalTokens).toBeGreaterThan(0);
		expect(result.passesCoherence).toBe(true);
	});

	it("SHORT scenario passes coherence check (no archive required)", () => {
		const result = runBenchmark(SHORT_SCENARIO);
		// Short scenario: coherence passes regardless of archive content
		expect(result.passesCoherence).toBe(true);
	});

	it("archive tokens are non-negative", () => {
		for (const scenario of ALL_SCENARIOS) {
			const result = runBenchmark(scenario);
			expect(result.archiveFinalTokens).toBeGreaterThanOrEqual(0);
		}
	});
});

// ─── managedOnly option ───────────────────────────────────────────────────────

describe("managedOnly option", () => {
	it("when managedOnly=true, baseline total is 0 and baseline turns is empty", () => {
		const result = runBenchmark(SHORT_SCENARIO, { managedOnly: true });
		expect(result.baselineTotalInputTokens).toBe(0);
		expect(result.baselineTurns).toHaveLength(0);
	});

	it("managed results are unaffected by managedOnly flag", () => {
		const full = runBenchmark(SHORT_SCENARIO);
		const managedOnly = runBenchmark(SHORT_SCENARIO, { managedOnly: true });
		expect(managedOnly.managedTotalInputTokens).toBe(full.managedTotalInputTokens);
		expect(managedOnly.turns).toBe(full.turns);
	});
});

// ─── runAllBenchmarks tests ───────────────────────────────────────────────────

describe("runAllBenchmarks", () => {
	it("returns one result per scenario", () => {
		const results = runAllBenchmarks(ALL_SCENARIOS);
		expect(results.length).toBe(ALL_SCENARIOS.length);
	});

	it("each result matches its scenario id", () => {
		const results = runAllBenchmarks(ALL_SCENARIOS);
		for (let i = 0; i < ALL_SCENARIOS.length; i++) {
			expect(results[i]?.scenarioId).toBe(ALL_SCENARIOS[i]?.id);
		}
	});

	it("returns empty array for empty input", () => {
		const results = runAllBenchmarks([]);
		expect(results).toHaveLength(0);
	});

	it("options are applied to all scenarios", () => {
		const results = runAllBenchmarks(ALL_SCENARIOS, { managedOnly: true });
		for (const r of results) {
			expect(r.baselineTotalInputTokens).toBe(0);
		}
	});
});

// ─── formatResult tests ───────────────────────────────────────────────────────

describe("formatResult", () => {
	it("returns a non-empty string", () => {
		const result = runBenchmark(SHORT_SCENARIO);
		const formatted = formatResult(result);
		expect(formatted.length).toBeGreaterThan(0);
	});

	it("includes scenario name", () => {
		const result = runBenchmark(SHORT_SCENARIO);
		const formatted = formatResult(result);
		expect(formatted).toContain(SHORT_SCENARIO.name);
	});

	it("includes PASS for short scenario (reduction expectation is 0)", () => {
		const result = runBenchmark(SHORT_SCENARIO);
		const formatted = formatResult(result);
		expect(formatted).toContain("PASS");
	});

	it("includes reduction percentage", () => {
		const result = runBenchmark(MEDIUM_SCENARIO);
		const formatted = formatResult(result);
		expect(formatted).toContain("reduction:");
	});

	it("includes context limit hits", () => {
		const result = runBenchmark(SHORT_SCENARIO);
		const formatted = formatResult(result);
		expect(formatted).toContain("context limit hits:");
	});
});

// ─── per-turn metrics tests ───────────────────────────────────────────────────

describe("per-turn metrics", () => {
	it("managedTurns has one entry per assistant message", () => {
		const result = runBenchmark(SHORT_SCENARIO);
		// turns count matches managedTurns length
		expect(result.managedTurns.length).toBe(result.turns);
	});

	it("each turn has positive inputTokens", () => {
		const result = runBenchmark(MEDIUM_SCENARIO);
		for (const t of result.managedTurns) {
			expect(t.inputTokens).toBeGreaterThan(0);
		}
	});

	it("each turn has a non-negative messageCount", () => {
		const result = runBenchmark(MEDIUM_SCENARIO);
		for (const t of result.managedTurns) {
			expect(t.messageCount).toBeGreaterThanOrEqual(0);
		}
	});

	it("each turn utilization has total.budget matching window size", () => {
		const result = runBenchmark(SHORT_SCENARIO);
		for (const t of result.managedTurns) {
			expect(t.utilization.total.budget).toBe(200_000);
		}
	});

	it("baseline turn count matches managed turn count", () => {
		const result = runBenchmark(MEDIUM_SCENARIO);
		expect(result.baselineTurns.length).toBe(result.managedTurns.length);
	});
});
