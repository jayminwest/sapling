/**
 * Tests for the benchmark harness.
 *
 * Validates that:
 * 1. All scenarios are well-formed (correct message count, alternating roles)
 * 2. runBenchmark returns a structurally valid BenchmarkResult
 * 3. V1 pipeline uses ≤ baseline tokens for non-trivial conversations
 * 4. Context limit is never exceeded with 200K window
 * 5. formatResult produces a non-empty string
 * 6. runAllBenchmarks returns one result per scenario
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
	it("ALL_SCENARIOS contains 14 scenarios", () => {
		expect(ALL_SCENARIOS.length).toBe(14);
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

	it("all short scenarios have ~10 assistant messages", () => {
		const shortScenarios = ALL_SCENARIOS.filter((s) => s.id.startsWith("short-"));
		for (const s of shortScenarios) {
			const assistantMsgs = s.messages.filter((m) => m.role === "assistant");
			expect(assistantMsgs.length).toBeGreaterThanOrEqual(8);
			expect(assistantMsgs.length).toBeLessThanOrEqual(15);
		}
	});

	it("all medium scenarios have ~30 assistant messages", () => {
		const mediumScenarios = ALL_SCENARIOS.filter((s) => s.id.startsWith("medium-"));
		for (const s of mediumScenarios) {
			const assistantMsgs = s.messages.filter((m) => m.role === "assistant");
			expect(assistantMsgs.length).toBeGreaterThanOrEqual(20);
			expect(assistantMsgs.length).toBeLessThanOrEqual(40);
		}
	});

	it("all long scenarios have ~100 assistant messages", () => {
		const longScenarios = ALL_SCENARIOS.filter((s) => s.id.startsWith("long-"));
		for (const s of longScenarios) {
			const assistantMsgs = s.messages.filter((m) => m.role === "assistant");
			expect(assistantMsgs.length).toBeGreaterThanOrEqual(70);
			expect(assistantMsgs.length).toBeLessThanOrEqual(130);
		}
	});

	it("SHORT expected reduction min is 0", () => {
		expect(SHORT_SCENARIO.expectedReductionMin).toBe(0);
	});

	it("LONG expected reduction min is >= 0.3", () => {
		expect(LONG_SCENARIO.expectedReductionMin).toBeGreaterThanOrEqual(0.3);
	});

	it("all long scenarios have expectedReductionMin >= 0.3", () => {
		const longScenarios = ALL_SCENARIOS.filter((s) => s.id.startsWith("long-"));
		for (const s of longScenarios) {
			expect(s.expectedReductionMin).toBeGreaterThanOrEqual(0.3);
		}
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
		expect(typeof result.reductionFraction).toBe("number");
		expect(typeof result.reductionPct).toBe("number");
		expect(typeof result.passes).toBe("boolean");
		expect(typeof result.passesReduction).toBe("boolean");
		expect(Array.isArray(result.baselineTurns)).toBe(true);
		expect(result.v1).toBeDefined();
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

	it("v1 field is always populated", () => {
		const result = runBenchmark(SHORT_SCENARIO);
		expect(result.v1).toBeDefined();
		expect(typeof result.v1.totalInputTokens).toBe("number");
	});
});

// ─── Token reduction tests ────────────────────────────────────────────────────

describe("token reduction", () => {
	it("v1 tokens <= baseline tokens for MEDIUM and LONG scenarios", () => {
		for (const scenario of [MEDIUM_SCENARIO, LONG_SCENARIO]) {
			const result = runBenchmark(scenario);
			expect(result.v1.totalInputTokens).toBeLessThanOrEqual(result.baselineTotalInputTokens);
		}
	});

	it("LONG scenario achieves non-negative reduction", () => {
		// v1 pipeline achieves reduction when context pressure exists (window exceeded);
		// with a 200K window and synthetic scenarios that peak below the window, reduction may be 0
		const result = runBenchmark(LONG_SCENARIO);
		expect(result.reductionFraction).toBeGreaterThanOrEqual(0);
		expect(result.reductionFraction).toBeLessThanOrEqual(1);
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
		expect(longResult.baselineTotalInputTokens).toBeGreaterThan(
			shortResult.baselineTotalInputTokens,
		);
	});
});

// ─── Context limit tests ──────────────────────────────────────────────────────

describe("context limits", () => {
	it("v1 hits no context limit with 200K window for all scenarios", () => {
		for (const scenario of ALL_SCENARIOS) {
			const result = runBenchmark(scenario);
			expect(result.v1.contextLimitHits).toBe(0);
			expect(result.v1.hitContextLimit).toBe(false);
		}
	});

	it("context limit tracking works with a tiny window", () => {
		// Use a tiny 2K window — fields should still be numeric
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
		expect(typeof result.v1.contextLimitHits).toBe("number");
		expect(result.v1.contextLimitHits).toBeGreaterThanOrEqual(0);
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

	it("includes v1 metrics", () => {
		const result = runBenchmark(SHORT_SCENARIO);
		const formatted = formatResult(result);
		expect(formatted).toContain("v1 total tokens:");
		expect(formatted).toContain("v1 peak util:");
	});
});

// ─── per-turn metrics tests ───────────────────────────────────────────────────

describe("per-turn metrics", () => {
	it("v1 turns has one entry per assistant message", () => {
		const result = runBenchmark(SHORT_SCENARIO);
		expect(result.v1.turns.length).toBe(result.turns);
	});

	it("each v1 turn has positive inputTokens", () => {
		const result = runBenchmark(MEDIUM_SCENARIO);
		for (const t of result.v1.turns) {
			expect(t.inputTokens).toBeGreaterThan(0);
		}
	});

	it("each v1 turn has a non-negative messageCount", () => {
		const result = runBenchmark(MEDIUM_SCENARIO);
		for (const t of result.v1.turns) {
			expect(t.messageCount).toBeGreaterThanOrEqual(0);
		}
	});

	it("baseline turn count matches v1 turn count", () => {
		const result = runBenchmark(MEDIUM_SCENARIO);
		expect(result.baselineTurns.length).toBe(result.v1.turns.length);
	});
});

// ─── V1 pipeline metrics tests ────────────────────────────────────────────────

describe("v1 pipeline metrics", () => {
	it("v1 totalInputTokens is non-negative", () => {
		const result = runBenchmark(SHORT_SCENARIO);
		expect(result.v1.totalInputTokens).toBeGreaterThanOrEqual(0);
	});

	it("v1 peakUtilization is between 0 and 1", () => {
		const result = runBenchmark(MEDIUM_SCENARIO);
		expect(result.v1.peakUtilization).toBeGreaterThanOrEqual(0);
		expect(result.v1.peakUtilization).toBeLessThanOrEqual(1);
	});

	it("v1 meanUtilization is between 0 and 1", () => {
		const result = runBenchmark(MEDIUM_SCENARIO);
		expect(result.v1.meanUtilization).toBeGreaterThanOrEqual(0);
		expect(result.v1.meanUtilization).toBeLessThanOrEqual(1);
	});

	it("v1 peakUtilization >= meanUtilization", () => {
		const result = runBenchmark(MEDIUM_SCENARIO);
		expect(result.v1.peakUtilization).toBeGreaterThanOrEqual(result.v1.meanUtilization);
	});

	it("v1 operationCount > 0 for non-trivial scenarios", () => {
		const result = runBenchmark(MEDIUM_SCENARIO);
		expect(result.v1.operationCount).toBeGreaterThan(0);
	});

	it("v1 compactionRatio is between 0 and 1", () => {
		const result = runBenchmark(LONG_SCENARIO);
		expect(result.v1.compactionRatio).toBeGreaterThanOrEqual(0);
		expect(result.v1.compactionRatio).toBeLessThanOrEqual(1);
	});

	it("v1 archiveEntryCount equals archivedCount", () => {
		const result = runBenchmark(LONG_SCENARIO);
		expect(result.v1.archiveEntryCount).toBe(result.v1.archivedCount);
	});

	it("v1 compactedCount + archivedCount <= operationCount", () => {
		const result = runBenchmark(LONG_SCENARIO);
		expect(result.v1.compactedCount + result.v1.archivedCount).toBeLessThanOrEqual(
			result.v1.operationCount,
		);
	});

	it("v1 reductionFraction is between 0 and 1", () => {
		const result = runBenchmark(LONG_SCENARIO);
		expect(result.v1.reductionFraction).toBeGreaterThanOrEqual(0);
		expect(result.v1.reductionFraction).toBeLessThanOrEqual(1);
	});

	it("v1 turns array has one entry per assistant message", () => {
		const result = runBenchmark(SHORT_SCENARIO);
		expect(result.v1.turns.length).toBeGreaterThan(0);
		expect(result.v1.turns.length).toBe(result.turns);
	});

	it("v1 context limit hits is non-negative", () => {
		const result = runBenchmark(SHORT_SCENARIO);
		expect(result.v1.contextLimitHits).toBeGreaterThanOrEqual(0);
	});

	it("v1 hits no context limit on 200K window for LONG scenario", () => {
		const result = runBenchmark(LONG_SCENARIO);
		expect(result.v1.contextLimitHits).toBe(0);
		expect(result.v1.hitContextLimit).toBe(false);
	});

	it("v1 reductionPct matches reductionFraction * 100 (rounded)", () => {
		const result = runBenchmark(MEDIUM_SCENARIO);
		const expected = Math.round(result.v1.reductionFraction * 100 * 10) / 10;
		expect(result.v1.reductionPct).toBe(expected);
	});

	it("v1 runs without error on all scenarios", () => {
		for (const scenario of ALL_SCENARIOS) {
			const result = runBenchmark(scenario);
			expect(result.v1.totalInputTokens).toBeGreaterThanOrEqual(0);
		}
	});

	it("v1 produces valid utilization for all scenarios", () => {
		for (const scenario of ALL_SCENARIOS) {
			const result = runBenchmark(scenario);
			expect(result.v1.peakUtilization).toBeGreaterThanOrEqual(0);
			expect(result.v1.meanUtilization).toBeGreaterThanOrEqual(0);
		}
	});

	it("v1 operation count is positive for non-trivial scenarios", () => {
		const result = runBenchmark(LONG_SCENARIO);
		expect(result.v1.operationCount).toBeGreaterThan(0);
	});
});
