/**
 * Tests for the v1 context pipeline Compact stage and Templates module.
 */

import { describe, expect, it } from "bun:test";
import type { ContentBlock, Message } from "../../types.ts";
import {
	compact,
	compactOperation,
	truncateOperationOutputs,
	truncateToolOutput,
} from "./compact.ts";
import {
	buildActionSummary,
	describeOutcome,
	extractPurpose,
	renderArchiveEntry,
	renderCompactSummary,
} from "./templates.ts";
import type { Operation, Turn } from "./types.ts";
import { COMPACTION_SCORE_THRESHOLD, TOOL_OUTPUT_TRUNCATION } from "./types.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeAssistantMsg(
	tools: Array<{ name: string; id?: string; path?: string }>,
	text = "",
): Message & { role: "assistant" } {
	return {
		role: "assistant",
		content: [
			...(text ? [{ type: "text" as const, text }] : []),
			...tools.map((t) => ({
				type: "tool_use" as const,
				id: t.id ?? `tu_${t.name}`,
				name: t.name,
				input: t.path ? { path: t.path } : {},
			})),
		],
	};
}

function makeUserMsg(
	toolIds: Array<{ id: string; content?: string; isError?: boolean }>,
): Message & { role: "user" } {
	const blocks = toolIds.map((t) => ({
		type: "tool_result" as const,
		tool_use_id: t.id,
		content: t.content ?? "ok",
		...(t.isError ? { is_error: true } : {}),
	})) as unknown as ContentBlock[];
	return { role: "user", content: blocks };
}

function makeTurn(
	index: number,
	tools: Array<{ name: string; id?: string; path?: string; resultContent?: string }>,
	opts: { hasError?: boolean; hasDecision?: boolean; text?: string } = {},
): Turn {
	const assistant = makeAssistantMsg(tools, opts.text ?? "");
	const toolResults = makeUserMsg(
		tools.map((t) => ({
			id: t.id ?? `tu_${t.name}`,
			content: t.resultContent ?? "ok",
			isError: opts.hasError,
		})),
	);
	return {
		index,
		assistant,
		toolResults,
		meta: {
			tools: tools.map((t) => t.name),
			files: tools.flatMap((t) => (t.path ? [t.path] : [])),
			hasError: opts.hasError ?? false,
			hasDecision: opts.hasDecision ?? false,
			tokens: 100,
			timestamp: Date.now(),
		},
	};
}

function makeOp(overrides: Partial<Operation> = {}): Operation {
	return {
		id: 1,
		status: "completed",
		type: "explore",
		turns: [],
		files: new Set<string>(),
		tools: new Set<string>(),
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

// ---------------------------------------------------------------------------
// extractPurpose
// ---------------------------------------------------------------------------

describe("extractPurpose", () => {
	it("extracts purpose from 'I'll' pattern in first turn", () => {
		const op = makeOp({
			turns: [
				makeTurn(0, [{ name: "read", path: "src/foo.ts" }], {
					text: "I'll implement the authentication flow.",
				}),
			],
		});
		const purpose = extractPurpose(op);
		expect(purpose).toContain("implement the authentication flow");
	});

	it("extracts purpose from 'Let me' pattern", () => {
		const op = makeOp({
			turns: [
				makeTurn(0, [{ name: "bash" }], {
					text: "Let me run the test suite to check for failures.",
				}),
			],
		});
		const purpose = extractPurpose(op);
		expect(purpose).toContain("run the test suite");
	});

	it("falls back to type + files when no regex matches", () => {
		const op = makeOp({
			type: "explore",
			files: new Set(["src/foo.ts", "src/bar.ts"]),
			turns: [makeTurn(0, [{ name: "read" }], { text: "Checking." })],
		});
		const purpose = extractPurpose(op);
		expect(purpose).toMatch(/explore operation on/);
		expect(purpose).toContain("src/foo.ts");
	});

	it("falls back to type only when no files", () => {
		const op = makeOp({
			type: "verify",
			files: new Set(),
			turns: [],
		});
		const purpose = extractPurpose(op);
		expect(purpose).toBe("verify operation");
	});

	it("caps extracted purpose at 100 chars", () => {
		const longText = "I'll " + "x".repeat(200) + ".";
		const op = makeOp({
			turns: [makeTurn(0, [{ name: "bash" }], { text: longText })],
		});
		const purpose = extractPurpose(op);
		expect(purpose.length).toBeLessThanOrEqual(100);
	});
});

// ---------------------------------------------------------------------------
// buildActionSummary
// ---------------------------------------------------------------------------

describe("buildActionSummary", () => {
	it("builds deduplicated tool(file) list", () => {
		const op = makeOp({
			turns: [
				makeTurn(0, [
					{ name: "read", path: "src/foo.ts" },
					{ name: "edit", path: "src/foo.ts" },
				]),
			],
		});
		const summary = buildActionSummary(op);
		expect(summary).toContain("read(src/foo.ts)");
		expect(summary).toContain("edit(src/foo.ts)");
	});

	it("deduplicates identical tool(file) pairs across turns", () => {
		const op = makeOp({
			turns: [
				makeTurn(0, [{ name: "read", path: "src/foo.ts" }]),
				makeTurn(1, [{ name: "read", path: "src/foo.ts" }]),
			],
		});
		const summary = buildActionSummary(op);
		const count = (summary.match(/read\(src\/foo\.ts\)/g) ?? []).length;
		expect(count).toBe(1);
	});

	it("uses bare tool name when no files", () => {
		const op = makeOp({
			turns: [makeTurn(0, [{ name: "bash" }])],
		});
		const summary = buildActionSummary(op);
		expect(summary).toContain("bash");
		expect(summary).not.toContain("bash(");
	});

	it("returns empty string for op with no turns", () => {
		const op = makeOp({ turns: [] });
		expect(buildActionSummary(op)).toBe("");
	});
});

// ---------------------------------------------------------------------------
// describeOutcome
// ---------------------------------------------------------------------------

describe("describeOutcome", () => {
	it("describes success with artifacts", () => {
		const op = makeOp({ outcome: "success", artifacts: ["src/foo.ts"] });
		expect(describeOutcome(op)).toContain("Artifacts: src/foo.ts");
	});

	it("describes success without artifacts", () => {
		const op = makeOp({ outcome: "success", artifacts: [] });
		expect(describeOutcome(op)).toBe("Completed successfully");
	});

	it("describes failure", () => {
		const op = makeOp({ outcome: "failure" });
		expect(describeOutcome(op)).toContain("Failed");
	});

	it("describes partial completion", () => {
		const op = makeOp({ outcome: "partial" });
		expect(describeOutcome(op)).toContain("Partial");
	});

	it("describes in_progress", () => {
		const op = makeOp({ outcome: "in_progress" });
		expect(describeOutcome(op)).toContain("In progress");
	});
});

// ---------------------------------------------------------------------------
// renderCompactSummary
// ---------------------------------------------------------------------------

describe("renderCompactSummary", () => {
	it("includes op id, purpose, actions, and outcome", () => {
		const op = makeOp({
			id: 3,
			outcome: "success",
			artifacts: ["src/out.ts"],
			turns: [
				makeTurn(0, [{ name: "write", path: "src/out.ts" }], {
					text: "I'll write the output module.",
				}),
			],
		});
		const summary = renderCompactSummary(op);
		expect(summary).toContain("[Op 3]");
		expect(summary).toContain("write the output module");
		expect(summary).toContain("Actions:");
		expect(summary).toContain("Outcome:");
	});

	it("omits Actions line when there are no turns", () => {
		const op = makeOp({ id: 1, turns: [] });
		const summary = renderCompactSummary(op);
		expect(summary).not.toContain("Actions:");
	});
});

// ---------------------------------------------------------------------------
// renderArchiveEntry
// ---------------------------------------------------------------------------

describe("renderArchiveEntry", () => {
	it("produces a one-liner with op id, purpose, and outcome", () => {
		const op = makeOp({
			id: 5,
			outcome: "success",
			turns: [
				makeTurn(0, [{ name: "bash" }], { text: "I'll run the linter to check for issues." }),
			],
		});
		const entry = renderArchiveEntry(op);
		expect(entry).toMatch(/^Op5:/);
		expect(entry).toContain("[success]");
		expect(entry).not.toContain("\n");
	});
});

// ---------------------------------------------------------------------------
// truncateToolOutput
// ---------------------------------------------------------------------------

describe("truncateToolOutput", () => {
	it("returns content unchanged when under bash budget", () => {
		const content = "short output";
		expect(truncateToolOutput("bash", content)).toBe(content);
	});

	it("truncates bash output over budget using head+tail strategy", () => {
		const bashBudget = TOOL_OUTPUT_TRUNCATION.bashMaxTokens * 4;
		const manyLines = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
		// Force over budget by using content > bashBudget chars
		const longContent = manyLines + "\n" + "x".repeat(bashBudget);
		const result = truncateToolOutput("bash", longContent);
		expect(result).toContain("lines omitted");
		expect(result.length).toBeLessThan(longContent.length);
	});

	it("truncates grep output with simple char truncation", () => {
		const grepBudget = TOOL_OUTPUT_TRUNCATION.grepMaxTokens * 4;
		const content = "x".repeat(grepBudget + 100);
		const result = truncateToolOutput("grep", content);
		expect(result).toContain("truncated");
		expect(result.length).toBeLessThan(content.length);
	});

	it("truncates read output using head+tail strategy", () => {
		const readBudget = TOOL_OUTPUT_TRUNCATION.readMaxTokens * 4;
		const manyLines = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
		const longContent = manyLines + "\n" + "x".repeat(readBudget);
		const result = truncateToolOutput("read", longContent);
		expect(result).toContain("lines omitted");
	});

	it("truncates glob output to max results", () => {
		const max = TOOL_OUTPUT_TRUNCATION.globMaxResults;
		const lines = Array.from({ length: max + 10 }, (_, i) => `file${i}.ts`).join("\n");
		const result = truncateToolOutput("glob", lines);
		expect(result).toContain("more results");
		const keptLines = result.split("\n").filter((l) => !l.startsWith("[") && l.trim().length > 0);
		expect(keptLines.length).toBe(max);
	});

	it("returns unchanged content for unknown tools", () => {
		const content = "some output";
		expect(truncateToolOutput("write", content)).toBe(content);
		expect(truncateToolOutput("edit", content)).toBe(content);
	});
});

// ---------------------------------------------------------------------------
// compactOperation
// ---------------------------------------------------------------------------

describe("compactOperation", () => {
	it("sets status to compacted and generates a summary", () => {
		const op = makeOp({
			id: 2,
			status: "completed",
			score: 0.1,
			turns: [makeTurn(0, [{ name: "read", path: "src/foo.ts" }])],
		});
		compactOperation(op);
		expect(op.status).toBe("compacted");
		expect(op.summary).not.toBeNull();
		expect(typeof op.summary).toBe("string");
		expect(op.summary).toContain("[Op 2]");
	});
});

// ---------------------------------------------------------------------------
// truncateOperationOutputs
// ---------------------------------------------------------------------------

describe("truncateOperationOutputs", () => {
	it("truncates bash tool_result content when over budget", () => {
		const bashBudget = TOOL_OUTPUT_TRUNCATION.bashMaxTokens * 4;
		const largeOutput = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
		const longContent = largeOutput + "\n" + "x".repeat(bashBudget);

		const turn = makeTurn(0, [{ name: "bash", id: "tu_bash", resultContent: longContent }]);
		const op = makeOp({ turns: [turn], score: 0.5 });

		truncateOperationOutputs(op);

		const resultBlocks = turn.toolResults?.content as unknown as Array<{
			type: string;
			content: string;
		}>;
		const bashResult = resultBlocks.find((b) => b.type === "tool_result");
		expect(bashResult?.content).toContain("lines omitted");
		expect(bashResult?.content.length).toBeLessThan(longContent.length);
	});

	it("does not truncate short content", () => {
		const turn = makeTurn(0, [{ name: "bash", id: "tu_bash", resultContent: "short" }]);
		const op = makeOp({ turns: [turn] });

		truncateOperationOutputs(op);

		const resultBlocks = turn.toolResults?.content as unknown as Array<{
			type: string;
			content: string;
		}>;
		const bashResult = resultBlocks.find((b) => b.type === "tool_result");
		expect(bashResult?.content).toBe("short");
	});

	it("handles turns with null toolResults", () => {
		const turn = makeTurn(0, [{ name: "bash" }]);
		const turnWithNoResults = { ...turn, toolResults: null };
		const op = makeOp({ turns: [turnWithNoResults] });
		// Should not throw
		expect(() => truncateOperationOutputs(op)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// compact (stage entry point)
// ---------------------------------------------------------------------------

describe("compact", () => {
	it("compacts operations with score below threshold", () => {
		const op = makeOp({
			id: 1,
			status: "completed",
			score: COMPACTION_SCORE_THRESHOLD - 0.01,
			turns: [makeTurn(0, [{ name: "read", path: "src/foo.ts" }])],
		});
		compact([op], null);
		expect(op.status).toBe("compacted");
		expect(op.summary).not.toBeNull();
	});

	it("keeps operations with score at or above threshold", () => {
		const op = makeOp({
			id: 1,
			status: "completed",
			score: COMPACTION_SCORE_THRESHOLD,
			turns: [makeTurn(0, [{ name: "read", path: "src/foo.ts" }])],
		});
		compact([op], null);
		expect(op.status).toBe("completed");
		expect(op.summary).toBeNull();
	});

	it("never compacts the active operation", () => {
		const op = makeOp({
			id: 1,
			status: "active",
			score: 0.0, // below threshold, but active
		});
		compact([op], 1);
		expect(op.status).toBe("active");
		expect(op.summary).toBeNull();
	});

	it("skips already-compacted operations", () => {
		const op = makeOp({
			id: 1,
			status: "compacted",
			score: 0.0,
			summary: "existing summary",
		});
		compact([op], null);
		expect(op.summary).toBe("existing summary");
	});

	it("skips archived operations", () => {
		const op = makeOp({
			id: 1,
			status: "archived",
			score: 0.0,
		});
		compact([op], null);
		expect(op.status).toBe("archived");
	});

	it("processes multiple operations correctly", () => {
		const lowOp = makeOp({ id: 1, status: "completed", score: 0.1 });
		const highOp = makeOp({ id: 2, status: "completed", score: 0.8 });
		const activeOp = makeOp({ id: 3, status: "active", score: 0.0 });

		compact([lowOp, highOp, activeOp], 3);

		expect(lowOp.status).toBe("compacted");
		expect(highOp.status).toBe("completed"); // kept, possibly truncated
		expect(activeOp.status).toBe("active"); // never touched
	});

	it("threshold boundary: score exactly at threshold is kept", () => {
		const op = makeOp({ id: 1, status: "completed", score: COMPACTION_SCORE_THRESHOLD });
		compact([op], null);
		expect(op.status).toBe("completed");
	});

	it("threshold boundary: score just below threshold is compacted", () => {
		const op = makeOp({
			id: 1,
			status: "completed",
			score: COMPACTION_SCORE_THRESHOLD - Number.EPSILON,
		});
		compact([op], null);
		expect(op.status).toBe("compacted");
	});
});
