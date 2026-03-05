import { describe, expect, it } from "bun:test";
import {
	type ArchiveEntry,
	budget,
	enforceArchiveBudget,
	enforceBudget,
	estimateTokens,
	operationTokens,
	rebalanceBudget,
} from "./budget.ts";
import type { Operation } from "./types.ts";
import { MAX_SINGLE_OP_BUDGET_FRACTION, V1_BUDGET_ALLOCATIONS, V1_ZONE_BOUNDS } from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOp(overrides: Partial<Operation> = {}): Operation {
	return {
		id: 0,
		status: "completed",
		type: "explore",
		turns: [],
		files: new Set(),
		tools: new Set(),
		outcome: "success",
		artifacts: [],
		dependsOn: [],
		score: 0.5,
		summary: null,
		startTurn: 0,
		endTurn: 0,
		...overrides,
	};
}

function makeOpWithTurns(
	id: number,
	tokenCount: number,
	status: Operation["status"] = "completed",
): Operation {
	return makeOp({
		id,
		status,
		turns: [
			{
				index: 0,
				assistant: { role: "assistant", content: [] },
				toolResults: null,
				meta: {
					tools: [],
					files: [],
					hasError: false,
					hasDecision: false,
					tokens: tokenCount,
					timestamp: Date.now(),
				},
			},
		],
	});
}

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
	it("returns 0 for empty string", () => {
		expect(estimateTokens("")).toBe(0);
	});

	it("uses 4-chars-per-token heuristic", () => {
		expect(estimateTokens("abcd")).toBe(1);
		expect(estimateTokens("abcde")).toBe(2); // ceil(5/4) = 2
		expect(estimateTokens("a".repeat(100))).toBe(25); // ceil(100/4) = 25
	});
});

// ---------------------------------------------------------------------------
// operationTokens
// ---------------------------------------------------------------------------

describe("operationTokens", () => {
	it("sums turn tokens for completed operations", () => {
		const op = makeOp({
			status: "completed",
			turns: [
				{
					index: 0,
					assistant: { role: "assistant", content: [] },
					toolResults: null,
					meta: {
						tools: [],
						files: [],
						hasError: false,
						hasDecision: false,
						tokens: 100,
						timestamp: 0,
					},
				},
				{
					index: 1,
					assistant: { role: "assistant", content: [] },
					toolResults: null,
					meta: {
						tools: [],
						files: [],
						hasError: false,
						hasDecision: false,
						tokens: 200,
						timestamp: 0,
					},
				},
			],
		});
		expect(operationTokens(op)).toBe(300);
	});

	it("uses summary tokens for compacted operations", () => {
		const summary = "a".repeat(400); // 100 tokens
		const op = makeOp({ status: "compacted", summary, turns: [] });
		// estimateTokens("a".repeat(400)) = 100, + 10 overhead
		expect(operationTokens(op)).toBe(110);
	});

	it("sums turn tokens for compacted op with null summary", () => {
		const op = makeOp({
			status: "compacted",
			summary: null,
			turns: [
				{
					index: 0,
					assistant: { role: "assistant", content: [] },
					toolResults: null,
					meta: {
						tools: [],
						files: [],
						hasError: false,
						hasDecision: false,
						tokens: 50,
						timestamp: 0,
					},
				},
			],
		});
		// null summary falls back to summing turns
		expect(operationTokens(op)).toBe(50);
	});

	it("returns 0 for active op with no turns", () => {
		const op = makeOp({ status: "active", turns: [] });
		expect(operationTokens(op)).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// enforceBudget
// ---------------------------------------------------------------------------

describe("enforceBudget", () => {
	const WINDOW = 200_000; // 200K token window (typical Claude context)
	const OP_BUDGET = Math.floor(WINDOW * V1_BUDGET_ALLOCATIONS.activeOperations); // 50_000

	it("always retains active operation even if over budget", () => {
		// Active op uses more than the entire operation budget
		const active = makeOpWithTurns(0, OP_BUDGET + 10_000, "active");
		const result = enforceBudget([active], 5000, WINDOW);

		expect(result.retained).toHaveLength(1);
		expect(result.retained[0]?.id).toBe(0);
		expect(result.archived).toHaveLength(0);
	});

	it("retains completed ops that fit within budget", () => {
		const active = makeOpWithTurns(0, 1000, "active");
		const completed1 = makeOpWithTurns(1, 1000, "completed");
		const completed2 = makeOpWithTurns(2, 1000, "completed");

		const result = enforceBudget([active, completed1, completed2], 5000, WINDOW);

		expect(result.retained).toHaveLength(3);
		expect(result.archived).toHaveLength(0);
	});

	it("archives completed ops that exceed budget", () => {
		// Very small window to force archiving.
		// Pass systemPromptTokens at the full system budget to suppress rebalancing
		// so the test exercises the base 25% ops allocation.
		const smallWindow = 2000;
		const smallOpBudget = Math.floor(smallWindow * V1_BUDGET_ALLOCATIONS.activeOperations); // 500
		const smallSysBudget = Math.floor(smallWindow * V1_BUDGET_ALLOCATIONS.systemWithArchive); // 500

		const active = makeOpWithTurns(0, 200, "active"); // 200 tokens
		// These two together would exceed the 500-token budget
		const completed1 = makeOpWithTurns(1, 200, "completed");
		const completed2 = makeOpWithTurns(2, 200, "completed");
		const completed3 = makeOpWithTurns(3, 200, "completed");

		// Pass full system budget as systemPromptTokens → no surplus → no rebalancing
		const result = enforceBudget(
			[active, completed1, completed2, completed3],
			smallSysBudget,
			smallWindow,
		);

		// active (200) + at most one more 200-token op = 400 <= 500 budget
		// second 200-token op: 400+200=600 > 500 → archived
		expect(result.retained.some((op) => op.id === 0)).toBe(true); // active always kept
		expect(result.archived.length).toBeGreaterThan(0);
		// Sanity check that we used the expected base budget
		expect(smallOpBudget).toBe(500);
	});

	it("sorts completed ops by score (highest first)", () => {
		const smallWindow = 1200;
		const active = makeOpWithTurns(0, 100, "active");

		// Operation budget = 300 tokens
		// Three ops of 150 tokens each; only 2 fit (300 / 150 = 2 — but active takes 100 first → 200 left)
		// Actually: OP_BUDGET = floor(1200 * 0.25) = 300
		// Active takes 100 → remaining = 200
		// Can fit one more 150-token op; second 150-token op would make 100+150+150=400 > 300

		const lowScore = makeOp({
			id: 1,
			status: "completed",
			score: 0.1,
			turns: [
				{
					index: 0,
					assistant: { role: "assistant", content: [] },
					toolResults: null,
					meta: {
						tools: [],
						files: [],
						hasError: false,
						hasDecision: false,
						tokens: 150,
						timestamp: 0,
					},
				},
			],
		});
		const highScore = makeOp({
			id: 2,
			status: "completed",
			score: 0.9,
			turns: [
				{
					index: 0,
					assistant: { role: "assistant", content: [] },
					toolResults: null,
					meta: {
						tools: [],
						files: [],
						hasError: false,
						hasDecision: false,
						tokens: 150,
						timestamp: 0,
					},
				},
			],
		});

		// Pass full system budget to suppress rebalancing
		const smallSysBudget = Math.floor(smallWindow * V1_BUDGET_ALLOCATIONS.systemWithArchive); // 300
		const result = enforceBudget([active, lowScore, highScore], smallSysBudget, smallWindow);

		// High score should be retained, low score should be archived
		const retainedIds = result.retained.map((op) => op.id);
		const archivedIds = result.archived.map((op) => op.id);

		expect(retainedIds).toContain(2); // high score retained
		expect(archivedIds).toContain(1); // low score archived
	});

	it("returns correct BudgetUtilization shape", () => {
		const active = makeOpWithTurns(0, 500, "active");
		// systemPromptTokens=5000 causes rebalancing: system surplus flows to ops
		const result = enforceBudget([active], 5000, WINDOW);

		expect(result.budget.windowSize).toBe(WINDOW);
		// After rebalancing, systemWithArchive shrinks and headroom/ops grow
		expect(result.budget.systemWithArchive).toBeLessThanOrEqual(Math.floor(WINDOW * 0.25));
		expect(result.budget.systemWithArchive).toBeGreaterThanOrEqual(
			Math.floor(WINDOW * V1_ZONE_BOUNDS.systemWithArchive.min),
		);
		expect(result.budget.headroom).toBeGreaterThanOrEqual(
			Math.floor(WINDOW * V1_ZONE_BOUNDS.headroom.min),
		);
		expect(result.budget.utilization).toBeGreaterThanOrEqual(0);
		expect(result.budget.utilization).toBeLessThanOrEqual(1);
	});

	it("handles no operations", () => {
		const result = enforceBudget([], 0, WINDOW);
		expect(result.retained).toHaveLength(0);
		expect(result.archived).toHaveLength(0);
		expect(result.budget.activeOperations).toBe(0);
	});

	it("handles compacted operations using summary tokens", () => {
		const active = makeOpWithTurns(0, 100, "active");
		const summary = "x".repeat(40); // 10 tokens + 10 overhead = 20 tokens
		const compacted = makeOp({
			id: 1,
			status: "compacted",
			summary,
			score: 0.8,
			turns: [],
		});

		const result = enforceBudget([active, compacted], 1000, WINDOW);
		expect(result.retained.some((op) => op.id === 1)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// enforceArchiveBudget
// ---------------------------------------------------------------------------

describe("enforceArchiveBudget", () => {
	const WINDOW = 200_000;
	const SYSTEM_BUDGET = Math.floor(WINDOW * V1_BUDGET_ALLOCATIONS.systemWithArchive); // 50_000

	function makeEntry(id: number, tokens: number): ArchiveEntry {
		return { operationId: id, summary: "x".repeat(tokens * 4), tokens };
	}

	it("retains all entries when under budget", () => {
		const entries = [makeEntry(0, 100), makeEntry(1, 200)];
		const personaTokens = 2000;
		const { retained, dropped } = enforceArchiveBudget(entries, personaTokens, WINDOW);

		expect(retained).toHaveLength(2);
		expect(dropped).toHaveLength(0);
	});

	it("drops oldest entries first when over budget", () => {
		// personaTokens = 49_000, systemBudget = 50_000, so only 1_000 tokens for archive
		const personaTokens = 49_000;
		const entries = [
			makeEntry(0, 600), // oldest → dropped (used=400+700=1100>1000)
			makeEntry(1, 700), // → dropped (used=400+700=1100>1000)
			makeEntry(2, 400), // newest → retained (fits: 400<=1000)
		];

		const { retained, dropped } = enforceArchiveBudget(entries, personaTokens, WINDOW);

		expect(retained.map((e) => e.operationId)).toEqual([2]);
		expect(dropped.map((e) => e.operationId)).toContain(0);
		expect(dropped.map((e) => e.operationId)).toContain(1);
	});

	it("retains empty array when persona fills system budget", () => {
		const personaTokens = SYSTEM_BUDGET + 1000; // exceeds system budget
		const entries = [makeEntry(0, 100)];
		const { retained, dropped } = enforceArchiveBudget(entries, personaTokens, WINDOW);

		expect(retained).toHaveLength(0);
		expect(dropped).toHaveLength(1);
	});

	it("preserves chronological order in retained entries", () => {
		const personaTokens = 1000;
		const entries = [makeEntry(0, 100), makeEntry(1, 200), makeEntry(2, 300)];
		const { retained } = enforceArchiveBudget(entries, personaTokens, WINDOW);

		// All fit — should be in order oldest first
		expect(retained.map((e) => e.operationId)).toEqual([0, 1, 2]);
	});

	it("handles empty entries array", () => {
		const { retained, dropped } = enforceArchiveBudget([], 1000, WINDOW);
		expect(retained).toHaveLength(0);
		expect(dropped).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// budget (stage entry point)
// ---------------------------------------------------------------------------

describe("budget (stage entry point)", () => {
	it("marks over-budget operations as archived in-place", () => {
		const smallWindow = 1000;
		// OP budget = floor(1000 * 0.25) = 250 tokens (no rebalancing when sys is full)
		const smallSysBudget = Math.floor(smallWindow * V1_BUDGET_ALLOCATIONS.systemWithArchive); // 250

		const active = makeOpWithTurns(0, 100, "active"); // 100 tokens
		const completed1 = makeOpWithTurns(1, 100, "completed"); // 100 tokens — fits (200 <= 250)
		const completed2 = makeOpWithTurns(2, 100, "completed"); // 100 tokens — 300 > 250, archived

		// Give completed1 higher score so it wins over completed2
		completed1.score = 0.9;
		completed2.score = 0.1;

		const ops = [active, completed1, completed2];
		// Pass full system budget → no surplus → no rebalancing
		budget(ops, smallSysBudget, smallWindow);

		// Active and highest-score completed should be retained
		expect(ops[0]?.status).toBe("active");
		expect(ops[1]?.status).toBe("completed");
		expect(ops[2]?.status).toBe("archived");
	});

	it("returns BudgetUtilization", () => {
		const ops = [makeOpWithTurns(0, 1000, "active")];
		const result = budget(ops, 5000, 200_000);

		expect(result.windowSize).toBe(200_000);
		expect(typeof result.utilization).toBe("number");
	});

	it("does not archive active operations", () => {
		const smallWindow = 400;
		// OP budget = 100 tokens; active op uses 200 (over budget)
		const active = makeOpWithTurns(0, 200, "active");
		const ops = [active];

		budget(ops, 50, smallWindow);

		// Active is never archived regardless of token count
		expect(ops[0]?.status).toBe("active");
	});

	it("does not modify already-archived operations", () => {
		const alreadyArchived = makeOp({ id: 0, status: "archived", score: 1.0 });
		const ops = [alreadyArchived];

		budget(ops, 1000, 200_000);

		expect(ops[0]?.status).toBe("archived");
	});
});

// ---------------------------------------------------------------------------
// Per-operation cap (MAX_SINGLE_OP_BUDGET_FRACTION)
// ---------------------------------------------------------------------------

describe("enforceBudget — per-operation cap", () => {
	it("archives a completed op that individually exceeds the per-op cap", () => {
		const WINDOW = 10_000;
		// Pass full system budget to suppress rebalancing so the base per-op cap applies
		const sysBudget = Math.floor(WINDOW * V1_BUDGET_ALLOCATIONS.systemWithArchive); // 2500
		const opBudget = Math.floor(WINDOW * V1_BUDGET_ALLOCATIONS.activeOperations); // 2500
		const perOpCap = Math.floor(opBudget * MAX_SINGLE_OP_BUDGET_FRACTION); // 1250

		const active = makeOpWithTurns(0, 100, "active");
		// This op exceeds the per-op cap (1300 > 1250)
		const oversizedOp = makeOpWithTurns(1, perOpCap + 50, "completed");
		oversizedOp.score = 1.0; // high score — would be retained by normal logic

		// Pass systemPromptTokens = sysBudget so no surplus → operationBudget stays at base 2500
		const result = enforceBudget([active, oversizedOp], sysBudget, WINDOW);

		// Despite having budget remaining, oversized op exceeds per-op cap → archived
		expect(result.retained.some((op) => op.id === 1)).toBe(false);
		expect(result.archived.some((op) => op.id === 1)).toBe(true);
	});

	it("retains a completed op within the per-op cap", () => {
		const WINDOW = 10_000;
		const opBudget = Math.floor(WINDOW * V1_BUDGET_ALLOCATIONS.activeOperations); // 2500
		const perOpCap = Math.floor(opBudget * MAX_SINGLE_OP_BUDGET_FRACTION); // 1250

		const active = makeOpWithTurns(0, 100, "active");
		// This op is within the per-op cap (1200 <= 1250)
		const normalOp = makeOpWithTurns(1, perOpCap - 50, "completed");
		normalOp.score = 1.0;

		const result = enforceBudget([active, normalOp], 500, WINDOW);

		expect(result.retained.some((op) => op.id === 1)).toBe(true);
		expect(result.archived).toHaveLength(0);
	});

	it("active operations are not subject to the per-op cap", () => {
		const WINDOW = 10_000;
		const opBudget = Math.floor(WINDOW * V1_BUDGET_ALLOCATIONS.activeOperations); // 2500
		const perOpCap = Math.floor(opBudget * MAX_SINGLE_OP_BUDGET_FRACTION); // 1250

		// Active op exceeds the per-op cap — should still be retained
		const hugeActive = makeOpWithTurns(0, perOpCap * 3, "active");

		const result = enforceBudget([hugeActive], 0, WINDOW);

		expect(result.retained.some((op) => op.id === 0)).toBe(true);
		expect(result.archived).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// rebalanceBudget
// ---------------------------------------------------------------------------

describe("rebalanceBudget", () => {
	const WINDOW = 200_000;
	const defaultSystem = Math.floor(WINDOW * V1_BUDGET_ALLOCATIONS.systemWithArchive); // 50_000
	const defaultOps = Math.floor(WINDOW * V1_BUDGET_ALLOCATIONS.activeOperations); // 50_000
	const defaultHead = Math.floor(WINDOW * V1_BUDGET_ALLOCATIONS.headroom); // 100_000

	it("returns defaults when system prompt fills its budget", () => {
		// systemActualTokens >= systemBudget → no surplus → no rebalancing
		const zones = rebalanceBudget(WINDOW, defaultSystem);

		expect(zones.systemWithArchive).toBe(defaultSystem);
		expect(zones.activeOperations).toBe(defaultOps);
		expect(zones.headroom).toBe(defaultHead);
	});

	it("flows system surplus to activeOperations up to its max", () => {
		// Small system prompt → lots of surplus → ops should grow
		const zones = rebalanceBudget(WINDOW, 0);

		const opsMax = Math.floor(WINDOW * V1_ZONE_BOUNDS.activeOperations.max);
		expect(zones.activeOperations).toBe(opsMax);
		expect(zones.systemWithArchive).toBeLessThan(defaultSystem);
	});

	it("flows remaining surplus to headroom after ops hits max", () => {
		// System prompt is 0 → maximum surplus; ops hits max, remainder goes to headroom
		const zones = rebalanceBudget(WINDOW, 0);

		const opsMax = Math.floor(WINDOW * V1_ZONE_BOUNDS.activeOperations.max);
		const headMax = Math.floor(WINDOW * V1_ZONE_BOUNDS.headroom.max);
		// ops hits max
		expect(zones.activeOperations).toBe(opsMax);
		// headroom gets any remaining surplus
		expect(zones.headroom).toBeGreaterThanOrEqual(defaultHead);
		expect(zones.headroom).toBeLessThanOrEqual(headMax);
	});

	it("never drops systemWithArchive below its min bound", () => {
		// Even with 0 system prompt tokens, system zone stays above sysMin
		const sysMin = Math.floor(WINDOW * V1_ZONE_BOUNDS.systemWithArchive.min);
		const zones = rebalanceBudget(WINDOW, 0);

		expect(zones.systemWithArchive).toBeGreaterThanOrEqual(sysMin);
	});

	it("zone totals sum to approximately windowSize", () => {
		for (const sysTokens of [0, 5_000, 25_000, 50_000, 70_000]) {
			const zones = rebalanceBudget(WINDOW, sysTokens);
			const total = zones.systemWithArchive + zones.activeOperations + zones.headroom;
			// Allow ±3 tokens for floor() rounding across three zones
			expect(Math.abs(total - WINDOW)).toBeLessThanOrEqual(3);
		}
	});

	it("ops zone grows proportionally to system surplus", () => {
		// With half the system budget used, ops should gain roughly half the max surplus
		const halfSystem = Math.floor(defaultSystem / 2); // 25_000
		const fullSystem = rebalanceBudget(WINDOW, defaultSystem).activeOperations;
		const halfSystem_ = rebalanceBudget(WINDOW, halfSystem).activeOperations;

		// ops with half system usage should be > default ops
		expect(halfSystem_).toBeGreaterThan(fullSystem);
	});

	it("does not exceed opsMax or headMax", () => {
		const opsMax = Math.floor(WINDOW * V1_ZONE_BOUNDS.activeOperations.max);
		const headMax = Math.floor(WINDOW * V1_ZONE_BOUNDS.headroom.max);
		const zones = rebalanceBudget(WINDOW, 0);

		expect(zones.activeOperations).toBeLessThanOrEqual(opsMax);
		expect(zones.headroom).toBeLessThanOrEqual(headMax);
	});

	it("larger system prompt → less surplus → smaller ops budget", () => {
		const small = rebalanceBudget(WINDOW, 1_000).activeOperations;
		const large = rebalanceBudget(WINDOW, 40_000).activeOperations;

		expect(small).toBeGreaterThanOrEqual(large);
	});
});

// ---------------------------------------------------------------------------
// enforceBudget — rebalanced operation budget
// ---------------------------------------------------------------------------

describe("enforceBudget — rebalanced zone integration", () => {
	it("retains more completed ops when system prompt is small", () => {
		const WINDOW = 100_000;
		// With tiny system prompt, ops budget grows from default 25K to up to 40K
		const active = makeOpWithTurns(0, 5_000, "active");
		// Fill with completed ops of 5000 tokens each (score descending)
		const completed = Array.from({ length: 6 }, (_, i) =>
			makeOp({
				id: i + 1,
				status: "completed",
				score: 1.0 - i * 0.1,
				turns: [
					{
						index: 0,
						assistant: { role: "assistant", content: [] },
						toolResults: null,
						meta: {
							tools: [],
							files: [],
							hasError: false,
							hasDecision: false,
							tokens: 5_000,
							timestamp: 0,
						},
					},
				],
			}),
		);

		// Small system → rebalanced ops budget is larger
		const smallSys = enforceBudget([active, ...completed], 2_000, WINDOW);
		// Full system → ops budget stays at default 25K
		const fullSys = enforceBudget([active, ...completed], 25_000, WINDOW);

		// Smaller system prompt should result in at least as many retained ops
		expect(smallSys.retained.length).toBeGreaterThanOrEqual(fullSys.retained.length);
	});
});
