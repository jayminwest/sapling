import { describe, expect, it } from "bun:test";
import {
	causalDependencyScore,
	evaluate,
	evaluateOperation,
	fileOverlapScore,
	operationTypeScore,
	outcomeSignificanceScore,
	recencyScore,
} from "./evaluate.ts";
import type { Operation } from "./types.ts";
import { EVAL_WEIGHTS, RECENCY_HALF_LIFE_OPS } from "./types.ts";

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
		score: 0,
		summary: null,
		startTurn: 0,
		endTurn: 0,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// recencyScore
// ---------------------------------------------------------------------------

describe("recencyScore", () => {
	it("returns 1.0 for 0 ops ago", () => {
		expect(recencyScore(0)).toBeCloseTo(1.0, 6);
	});

	it("returns 0.5 for exactly one half-life ago", () => {
		expect(recencyScore(RECENCY_HALF_LIFE_OPS)).toBeCloseTo(0.5, 6);
	});

	it("returns 0.25 for two half-lives ago", () => {
		expect(recencyScore(RECENCY_HALF_LIFE_OPS * 2)).toBeCloseTo(0.25, 6);
	});

	it("decays monotonically", () => {
		const scores = [0, 1, 2, 4, 8, 12].map(recencyScore);
		for (let i = 1; i < scores.length; i++) {
			expect(scores[i]).toBeLessThan(scores[i - 1] as number);
		}
	});
});

// ---------------------------------------------------------------------------
// fileOverlapScore
// ---------------------------------------------------------------------------

describe("fileOverlapScore", () => {
	it("returns 0 when either set is empty", () => {
		expect(fileOverlapScore(new Set(["a"]), new Set())).toBe(0);
		expect(fileOverlapScore(new Set(), new Set(["a"]))).toBe(0);
		expect(fileOverlapScore(new Set(), new Set())).toBe(0);
	});

	it("returns 1.0 for identical sets", () => {
		expect(fileOverlapScore(new Set(["a", "b"]), new Set(["a", "b"]))).toBeCloseTo(1.0);
	});

	it("returns 0 for disjoint sets", () => {
		expect(fileOverlapScore(new Set(["a"]), new Set(["b"]))).toBe(0);
	});

	it("computes correct Jaccard for partial overlap", () => {
		// intersection = {a}, union = {a, b, c} → 1/3
		const score = fileOverlapScore(new Set(["a", "b"]), new Set(["a", "c"]));
		expect(score).toBeCloseTo(1 / 3, 6);
	});
});

// ---------------------------------------------------------------------------
// causalDependencyScore
// ---------------------------------------------------------------------------

describe("causalDependencyScore", () => {
	it("returns 0 when no dependency", () => {
		const op = makeOp({ id: 1, artifacts: ["x.ts"] });
		const active = makeOp({ id: 2, files: new Set(["y.ts"]), dependsOn: [] });
		expect(causalDependencyScore(op, active)).toBe(0);
	});

	it("returns 1.0 when active reads a file this op produced", () => {
		const op = makeOp({ id: 1, artifacts: ["src/foo.ts"] });
		const active = makeOp({ id: 2, files: new Set(["src/foo.ts"]), dependsOn: [] });
		expect(causalDependencyScore(op, active)).toBe(1.0);
	});

	it("returns 1.0 when active explicitly depends on this op", () => {
		const op = makeOp({ id: 3 });
		const active = makeOp({ id: 5, files: new Set(), dependsOn: [3] });
		expect(causalDependencyScore(op, active)).toBe(1.0);
	});

	it("explicit dependsOn takes priority even with no artifact overlap", () => {
		const op = makeOp({ id: 2, artifacts: [] });
		const active = makeOp({ id: 4, files: new Set(), dependsOn: [2] });
		expect(causalDependencyScore(op, active)).toBe(1.0);
	});
});

// ---------------------------------------------------------------------------
// outcomeSignificanceScore
// ---------------------------------------------------------------------------

describe("outcomeSignificanceScore", () => {
	it("failure → 1.0", () => {
		expect(outcomeSignificanceScore(makeOp({ outcome: "failure" }))).toBeCloseTo(1.0);
	});

	it("in_progress → 0.8", () => {
		expect(outcomeSignificanceScore(makeOp({ outcome: "in_progress" }))).toBeCloseTo(0.8);
	});

	it("partial → 0.6", () => {
		expect(outcomeSignificanceScore(makeOp({ outcome: "partial" }))).toBeCloseTo(0.6);
	});

	it("success → 0.3", () => {
		expect(outcomeSignificanceScore(makeOp({ outcome: "success" }))).toBeCloseTo(0.3);
	});

	it("adds 0.2 bonus for decision content", () => {
		const op = makeOp({
			outcome: "success",
			turns: [
				{
					index: 0,
					assistant: { role: "assistant", content: [] },
					toolResults: null,
					meta: {
						tools: [],
						files: [],
						hasError: false,
						hasDecision: true,
						tokens: 10,
						timestamp: Date.now(),
					},
				},
			],
		});
		expect(outcomeSignificanceScore(op)).toBeCloseTo(0.5);
	});

	it("caps decision bonus at 1.0", () => {
		const op = makeOp({
			outcome: "failure",
			turns: [
				{
					index: 0,
					assistant: { role: "assistant", content: [] },
					toolResults: null,
					meta: {
						tools: [],
						files: [],
						hasError: true,
						hasDecision: true,
						tokens: 10,
						timestamp: Date.now(),
					},
				},
			],
		});
		// failure (1.0) + 0.2 bonus → capped at 1.0
		expect(outcomeSignificanceScore(op)).toBeCloseTo(1.0);
	});
});

// ---------------------------------------------------------------------------
// operationTypeScore
// ---------------------------------------------------------------------------

describe("operationTypeScore", () => {
	it("mutate scores highest (1.0)", () => {
		expect(operationTypeScore("mutate")).toBeCloseTo(1.0);
	});

	it("mixed (0.8) > investigate (0.7) > verify (0.6) > explore (0.3)", () => {
		expect(operationTypeScore("mixed")).toBeGreaterThan(operationTypeScore("investigate"));
		expect(operationTypeScore("investigate")).toBeGreaterThan(operationTypeScore("verify"));
		expect(operationTypeScore("verify")).toBeGreaterThan(operationTypeScore("explore"));
	});

	it("explore scores lowest (0.3)", () => {
		expect(operationTypeScore("explore")).toBeCloseTo(0.3);
	});
});

// ---------------------------------------------------------------------------
// evaluateOperation
// ---------------------------------------------------------------------------

describe("evaluateOperation", () => {
	it("returns score in [0, 1]", () => {
		const op = makeOp({ id: 0, type: "mutate", outcome: "failure" });
		const score = evaluateOperation(op, null, 1);
		expect(score).toBeGreaterThanOrEqual(0);
		expect(score).toBeLessThanOrEqual(1);
	});

	it("active operation scores higher than an older one", () => {
		const ops: Operation[] = [
			makeOp({ id: 0, status: "completed", type: "mutate", outcome: "success" }),
			makeOp({ id: 1, status: "active", type: "explore", outcome: "in_progress" }),
		];
		const activeOp = ops[1] as Operation;
		const totalOps = ops.length;

		const scoreOld = evaluateOperation(ops[0] as Operation, activeOp, totalOps);
		const scoreActive = evaluateOperation(activeOp, activeOp, totalOps);
		expect(scoreActive).toBeGreaterThan(scoreOld);
	});

	it("op with file overlap scores higher than disjoint op", () => {
		const activeOp = makeOp({ id: 2, status: "active", files: new Set(["src/a.ts"]) });
		const overlapping = makeOp({ id: 0, files: new Set(["src/a.ts"]), outcome: "success" });
		const disjoint = makeOp({ id: 1, files: new Set(["src/b.ts"]), outcome: "success" });

		const s1 = evaluateOperation(overlapping, activeOp, 3);
		const s2 = evaluateOperation(disjoint, activeOp, 3);
		expect(s1).toBeGreaterThan(s2);
	});

	it("causal dependency boosts score", () => {
		const activeOp = makeOp({ id: 2, status: "active", files: new Set(["out.ts"]) });
		const producerOp = makeOp({ id: 0, artifacts: ["out.ts"], outcome: "success" });
		const unrelatedOp = makeOp({ id: 1, artifacts: [], outcome: "success" });

		const sProducer = evaluateOperation(producerOp, activeOp, 3);
		const sUnrelated = evaluateOperation(unrelatedOp, activeOp, 3);
		expect(sProducer).toBeGreaterThan(sUnrelated);
	});

	it("applies all weights correctly for a known configuration", () => {
		// Construct a deterministic scenario with known component values
		const activeOp = makeOp({
			id: 1,
			status: "active",
			files: new Set(["a.ts", "b.ts"]),
			dependsOn: [],
		});
		// op with id=0 → opsAgo = totalOps-1 - op.id = 2-1-0 = 1
		const op = makeOp({
			id: 0,
			files: new Set(["a.ts"]), // overlap: 1/{a,b} = 1/2 Jaccard? wait: union = {a,b} → 1/2
			artifacts: [],
			outcome: "success",
			type: "explore",
			turns: [],
		});

		const totalOps = 2;
		const opsAgo = 1;

		const expectedRecency = Math.exp((-Math.log(2) * opsAgo) / RECENCY_HALF_LIFE_OPS);
		const expectedFileOverlap = 1 / 2; // intersection={a}, union={a,b}
		const expectedCausal = 0;
		const expectedOutcome = 0.3;
		const expectedType = 0.3;

		const expected =
			EVAL_WEIGHTS.recency * expectedRecency +
			EVAL_WEIGHTS.fileOverlap * expectedFileOverlap +
			EVAL_WEIGHTS.causalDependency * expectedCausal +
			EVAL_WEIGHTS.outcomeSignificance * expectedOutcome +
			EVAL_WEIGHTS.operationType * expectedType;

		expect(evaluateOperation(op, activeOp, totalOps)).toBeCloseTo(expected, 6);
	});

	it("returns 0 when activeOp is null (no causal or file overlap contribution)", () => {
		// With no active op: recency uses opsAgo=0 → 1.0; causal=0; fileOverlap=0
		const op = makeOp({ id: 0, outcome: "success", type: "explore" });
		const expected =
			EVAL_WEIGHTS.recency * 1.0 +
			0 + // fileOverlap
			0 + // causal
			EVAL_WEIGHTS.outcomeSignificance * 0.3 +
			EVAL_WEIGHTS.operationType * 0.3;
		expect(evaluateOperation(op, null, 1)).toBeCloseTo(expected, 6);
	});
});

// ---------------------------------------------------------------------------
// evaluate (stage entry point)
// ---------------------------------------------------------------------------

describe("evaluate", () => {
	it("updates score in-place on all operations", () => {
		const ops: Operation[] = [
			makeOp({ id: 0, status: "completed", outcome: "success", type: "explore" }),
			makeOp({ id: 1, status: "active", outcome: "in_progress", type: "mutate" }),
		];

		evaluate(ops);

		for (const op of ops) {
			expect(op.score).toBeGreaterThanOrEqual(0);
			expect(op.score).toBeLessThanOrEqual(1);
		}
	});

	it("active operation gets a higher score than distant completed one", () => {
		const ops: Operation[] = [
			makeOp({ id: 0, status: "completed", outcome: "success", type: "explore" }),
			makeOp({
				id: 1,
				status: "completed",
				outcome: "success",
				type: "explore",
				files: new Set(["x.ts"]),
			}),
			makeOp({
				id: 2,
				status: "active",
				outcome: "in_progress",
				type: "mutate",
				files: new Set(["x.ts"]),
			}),
		];

		evaluate(ops);

		// Active op (id=2) should score higher than most-distant op (id=0)
		expect((ops[2] as Operation).score).toBeGreaterThan((ops[0] as Operation).score);
	});

	it("handles empty operations array without error", () => {
		expect(() => evaluate([])).not.toThrow();
	});

	it("handles operations with no active op", () => {
		const ops: Operation[] = [
			makeOp({ id: 0, status: "completed" }),
			makeOp({ id: 1, status: "compacted" }),
		];
		evaluate(ops);
		for (const op of ops) {
			expect(op.score).toBeGreaterThanOrEqual(0);
			expect(op.score).toBeLessThanOrEqual(1);
		}
	});
});
