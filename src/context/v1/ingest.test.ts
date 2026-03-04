/**
 * Tests for the v1 context pipeline Ingest stage.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { Message } from "../../types.ts";
import {
	detectBoundary,
	extractTurns,
	hasFileScopeChange,
	hasIntentSignal,
	hasTemporalGap,
	hasToolTransition,
	inferOperationType,
	inferOutcome,
	ingest,
	ingestTurn,
	resetOperationIdCounter,
} from "./ingest.ts";
import type { Operation, Turn } from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAssistantMsg(
	tools: Array<{ name: string; path?: string }>,
	text = "",
): Message & { role: "assistant" } {
	return {
		role: "assistant",
		content: [
			...(text ? [{ type: "text" as const, text }] : []),
			...tools.map((t) => ({
				type: "tool_use" as const,
				id: `tu_${t.name}`,
				name: t.name,
				input: t.path ? { path: t.path } : {},
			})),
		],
	};
}

function makeUserMsg(
	toolIds: Array<{ id: string; isError?: boolean }>,
	content = "ok",
): Message & { role: "user" } {
	// ToolResultBlock[] at runtime; cast to satisfy Message's ContentBlock[] type
	const blocks = toolIds.map((t) => ({
		type: "tool_result" as const,
		tool_use_id: t.id,
		content,
		...(t.isError ? { is_error: true } : {}),
	})) as unknown as import("../../types.ts").ContentBlock[];
	return { role: "user", content: blocks };
}

function makeOperation(override: Partial<Operation> = {}): Operation {
	return {
		id: 1,
		status: "active",
		type: "explore",
		turns: [],
		files: new Set<string>(),
		tools: new Set<string>(),
		outcome: "in_progress",
		artifacts: [],
		dependsOn: [],
		score: 0,
		summary: null,
		startTurn: 0,
		endTurn: 0,
		...override,
	};
}

function makeTurn(
	index: number,
	tools: string[],
	files: string[],
	opts: { hasError?: boolean; hasDecision?: boolean; timestamp?: number } = {},
): Turn {
	const assistant = makeAssistantMsg(
		tools.map((t, i) => ({ name: t, path: files[i] ?? undefined })),
	);
	const userMsg = makeUserMsg(tools.map((t) => ({ id: `tu_${t}`, isError: opts.hasError })));
	return {
		index,
		assistant,
		toolResults: userMsg,
		meta: {
			tools,
			files,
			hasError: opts.hasError ?? false,
			hasDecision: opts.hasDecision ?? false,
			tokens: 100,
			timestamp: opts.timestamp ?? Date.now(),
		},
	};
}

// ---------------------------------------------------------------------------
// extractTurns
// ---------------------------------------------------------------------------

describe("extractTurns", () => {
	it("pairs assistant+user messages into turns", () => {
		const messages: Message[] = [
			makeAssistantMsg([{ name: "read", path: "src/foo.ts" }]),
			makeUserMsg([{ id: "tu_read" }], "file content"),
			makeAssistantMsg([{ name: "edit", path: "src/foo.ts" }]),
			makeUserMsg([{ id: "tu_edit" }], "ok"),
		];

		const turns = extractTurns(messages);
		expect(turns).toHaveLength(2);
		expect(turns[0]!.index).toBe(0);
		expect(turns[0]!.meta.tools).toContain("read");
		expect(turns[1]!.index).toBe(1);
		expect(turns[1]!.meta.tools).toContain("edit");
	});

	it("handles final assistant turn with no tool results", () => {
		const messages: Message[] = [
			makeAssistantMsg([{ name: "read", path: "src/foo.ts" }]),
			makeUserMsg([{ id: "tu_read" }], "content"),
			makeAssistantMsg([], "I'm done"),
		];

		const turns = extractTurns(messages);
		expect(turns).toHaveLength(2);
		expect(turns[1]!.toolResults).toBeNull();
	});

	it("skips leading user messages (e.g., task prompt)", () => {
		const messages: Message[] = [
			{ role: "user", content: "Do the thing" },
			makeAssistantMsg([{ name: "glob" }]),
			makeUserMsg([{ id: "tu_glob" }], "files"),
		];

		const turns = extractTurns(messages);
		expect(turns).toHaveLength(1);
		expect(turns[0]!.meta.tools).toContain("glob");
	});

	it("returns empty array for empty message list", () => {
		expect(extractTurns([])).toHaveLength(0);
	});

	it("extracts file paths from tool_use inputs", () => {
		const messages: Message[] = [
			makeAssistantMsg([{ name: "read", path: "src/context/v1/types.ts" }]),
			makeUserMsg([{ id: "tu_read" }], "content"),
		];

		const turns = extractTurns(messages);
		expect(turns[0]!.meta.files).toContain("src/context/v1/types.ts");
	});

	it("detects errors from tool results", () => {
		const messages: Message[] = [
			makeAssistantMsg([{ name: "bash" }]),
			makeUserMsg([{ id: "tu_bash", isError: true }], "command not found"),
		];

		const turns = extractTurns(messages);
		expect(turns[0]!.meta.hasError).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// hasToolTransition
// ---------------------------------------------------------------------------

describe("hasToolTransition", () => {
	it("detects read -> write transition", () => {
		expect(hasToolTransition(new Set(["read"]), ["write"])).toBe(true);
	});

	it("detects write -> verify transition", () => {
		expect(hasToolTransition(new Set(["write", "edit"]), ["bash"])).toBe(true);
	});

	it("returns false when phases overlap", () => {
		expect(hasToolTransition(new Set(["grep"]), ["glob"])).toBe(false); // both search
		expect(hasToolTransition(new Set(["write"]), ["edit"])).toBe(false); // both write
	});

	it("returns false when prev tools are empty", () => {
		expect(hasToolTransition(new Set(), ["write"])).toBe(false);
	});

	it("returns false when current tools are empty", () => {
		expect(hasToolTransition(new Set(["read"]), [])).toBe(false);
	});

	it("returns false for unknown tools", () => {
		expect(hasToolTransition(new Set(["unknown"]), ["also_unknown"])).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// hasFileScopeChange
// ---------------------------------------------------------------------------

describe("hasFileScopeChange", () => {
	it("detects when turn files are completely different", () => {
		const opFiles = new Set(["src/a.ts", "src/b.ts"]);
		expect(hasFileScopeChange(opFiles, ["src/x.ts", "src/y.ts"])).toBe(true);
	});

	it("returns false when there is file overlap", () => {
		const opFiles = new Set(["src/a.ts", "src/b.ts"]);
		expect(hasFileScopeChange(opFiles, ["src/a.ts"])).toBe(false);
	});

	it("returns false when operation files are empty", () => {
		expect(hasFileScopeChange(new Set(), ["src/a.ts"])).toBe(false);
	});

	it("returns false when turn files are empty", () => {
		expect(hasFileScopeChange(new Set(["src/a.ts"]), [])).toBe(false);
	});

	it("uses Jaccard < 0.2 threshold", () => {
		// 1 shared out of 9 union ≈ 0.11 < 0.2 → scope change (true)
		const opFiles = new Set(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
		expect(hasFileScopeChange(opFiles, ["a.ts", "x.ts", "y.ts", "z.ts", "w.ts"])).toBe(true); // 1/9 ≈ 0.11

		// 2 shared out of 3 union ≈ 0.67 >= 0.2 → no scope change (false)
		expect(hasFileScopeChange(new Set(["a.ts", "b.ts"]), ["a.ts", "b.ts", "c.ts"])).toBe(false); // 2/3 ≈ 0.67
	});
});

// ---------------------------------------------------------------------------
// hasIntentSignal
// ---------------------------------------------------------------------------

describe("hasIntentSignal", () => {
	it("detects 'now let me'", () => {
		expect(hasIntentSignal("Now let me look at the tests.")).toBe(true);
	});

	it("detects 'next, I'", () => {
		expect(hasIntentSignal("Next, I need to run the build.")).toBe(true);
	});

	it("detects 'moving on to'", () => {
		expect(hasIntentSignal("Moving on to the next file.")).toBe(true);
	});

	it("detects 'that's done'", () => {
		expect(hasIntentSignal("That's done. Now I'll write tests.")).toBe(true);
	});

	it("returns false for regular text", () => {
		expect(hasIntentSignal("Reading the file to understand the structure.")).toBe(false);
	});

	it("is case insensitive", () => {
		expect(hasIntentSignal("NOW LET ME proceed.")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// hasTemporalGap
// ---------------------------------------------------------------------------

describe("hasTemporalGap", () => {
	it("returns true when gap > 30s", () => {
		expect(hasTemporalGap(1000, 32_000)).toBe(true);
	});

	it("returns false when gap <= 30s", () => {
		expect(hasTemporalGap(1000, 31_000)).toBe(false);
	});

	it("returns false for same timestamp", () => {
		expect(hasTemporalGap(5000, 5000)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// detectBoundary
// ---------------------------------------------------------------------------

describe("detectBoundary", () => {
	it("returns false when no signals", () => {
		expect(
			detectBoundary({
				toolTypeTransition: false,
				fileScopeChange: false,
				intentSignal: false,
				temporalGap: false,
			}),
		).toBe(false);
	});

	it("returns true when toolTypeTransition + fileScopeChange (0.35+0.30=0.65 >= 0.5)", () => {
		expect(
			detectBoundary({
				toolTypeTransition: true,
				fileScopeChange: true,
				intentSignal: false,
				temporalGap: false,
			}),
		).toBe(true);
	});

	it("returns true when toolTypeTransition + intentSignal (0.35+0.20=0.55 >= 0.5)", () => {
		expect(
			detectBoundary({
				toolTypeTransition: true,
				fileScopeChange: false,
				intentSignal: true,
				temporalGap: false,
			}),
		).toBe(true);
	});

	it("returns false when only intentSignal + temporalGap (0.20+0.15=0.35 < 0.5)", () => {
		expect(
			detectBoundary({
				toolTypeTransition: false,
				fileScopeChange: false,
				intentSignal: true,
				temporalGap: true,
			}),
		).toBe(false);
	});

	it("returns true when all signals fire (1.0 >= 0.5)", () => {
		expect(
			detectBoundary({
				toolTypeTransition: true,
				fileScopeChange: true,
				intentSignal: true,
				temporalGap: true,
			}),
		).toBe(true);
	});

	it("returns false when only toolTypeTransition (0.35 < 0.5)", () => {
		expect(
			detectBoundary({
				toolTypeTransition: true,
				fileScopeChange: false,
				intentSignal: false,
				temporalGap: false,
			}),
		).toBe(false);
	});

	it("returns false when only fileScopeChange (0.30 < 0.5)", () => {
		expect(
			detectBoundary({
				toolTypeTransition: false,
				fileScopeChange: true,
				intentSignal: false,
				temporalGap: false,
			}),
		).toBe(false);
	});

	it("returns true when fileScopeChange + intentSignal (0.30+0.20=0.50 >= 0.5)", () => {
		expect(
			detectBoundary({
				toolTypeTransition: false,
				fileScopeChange: true,
				intentSignal: true,
				temporalGap: false,
			}),
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// inferOperationType
// ---------------------------------------------------------------------------

describe("inferOperationType", () => {
	it("returns 'explore' for read+search tools", () => {
		expect(inferOperationType(new Set(["read", "grep", "glob"]))).toBe("explore");
	});

	it("returns 'mutate' for write/edit tools", () => {
		expect(inferOperationType(new Set(["write"]))).toBe("mutate");
		expect(inferOperationType(new Set(["edit"]))).toBe("mutate");
	});

	it("returns 'verify' for bash only", () => {
		expect(inferOperationType(new Set(["bash"]))).toBe("verify");
	});

	it("returns 'mixed' for write+bash", () => {
		expect(inferOperationType(new Set(["write", "bash"]))).toBe("mixed");
		expect(inferOperationType(new Set(["edit", "bash"]))).toBe("mixed");
	});

	it("returns 'explore' for empty tools", () => {
		expect(inferOperationType(new Set())).toBe("explore");
	});
});

// ---------------------------------------------------------------------------
// inferOutcome
// ---------------------------------------------------------------------------

describe("inferOutcome", () => {
	it("returns 'partial' for empty operation", () => {
		const op = makeOperation({ turns: [] });
		expect(inferOutcome(op)).toBe("partial");
	});

	it("returns 'failure' when last turn has error", () => {
		const turn = makeTurn(0, ["bash"], [], { hasError: true });
		const op = makeOperation({ turns: [turn] });
		expect(inferOutcome(op)).toBe("failure");
	});

	it("returns 'success' for read-only operation", () => {
		const turn = makeTurn(0, ["read"], ["src/foo.ts"]);
		const op = makeOperation({ turns: [turn], tools: new Set(["read"]) });
		expect(inferOutcome(op)).toBe("success");
	});

	it("returns 'success' when write op ends with successful bash", () => {
		const t1 = makeTurn(0, ["write"], ["src/foo.ts"]);
		const t2 = makeTurn(1, ["bash"], []);
		const op = makeOperation({ turns: [t1, t2], tools: new Set(["write", "bash"]) });
		expect(inferOutcome(op)).toBe("success");
	});

	it("returns 'partial' when write op does not end with bash", () => {
		const t1 = makeTurn(0, ["write"], ["src/foo.ts"]);
		const op = makeOperation({ turns: [t1], tools: new Set(["write"]) });
		expect(inferOutcome(op)).toBe("partial");
	});
});

// ---------------------------------------------------------------------------
// ingestTurn
// ---------------------------------------------------------------------------

describe("ingestTurn", () => {
	beforeEach(() => {
		resetOperationIdCounter();
	});

	it("creates first operation when none exist", () => {
		const turn = makeTurn(0, ["read"], ["src/foo.ts"]);
		const result = ingestTurn([], null, turn);

		expect(result.operations).toHaveLength(1);
		expect(result.operations[0]!.status).toBe("active");
		expect(result.operations[0]!.turns).toHaveLength(1);
		expect(result.activeOperationId).toBe(result.operations[0]!.id);
	});

	it("adds turn to active operation when no boundary", () => {
		const t1 = makeTurn(0, ["read"], ["src/foo.ts"]);
		const t2 = makeTurn(1, ["read"], ["src/foo.ts"]); // same phase, same file

		const r1 = ingestTurn([], null, t1);
		const r2 = ingestTurn(r1.operations, r1.activeOperationId, t2);

		expect(r2.operations).toHaveLength(1);
		expect(r2.operations[0]!.turns).toHaveLength(2);
	});

	it("creates new operation when boundary detected", () => {
		const now = Date.now();
		const t1 = makeTurn(0, ["read"], ["src/foo.ts"], { timestamp: now });
		// read -> write transition (0.35) + different files (0.30) = 0.65 >= 0.5
		const t2 = makeTurn(1, ["write"], ["src/bar.ts"], { timestamp: now + 100 });

		const r1 = ingestTurn([], null, t1);
		// Manually set the active op's tools and files
		r1.operations[0]!.tools.add("read");
		r1.operations[0]!.files.add("src/foo.ts");

		const r2 = ingestTurn(r1.operations, r1.activeOperationId, t2);

		expect(r2.operations).toHaveLength(2);
		expect(r2.operations[0]!.status).toBe("completed");
		expect(r2.operations[1]!.status).toBe("active");
		expect(r2.activeOperationId).toBe(r2.operations[1]!.id);
	});

	it("finalizes operation with outcome on boundary", () => {
		const now = Date.now();
		const t1 = makeTurn(0, ["read"], ["src/a.ts"], { timestamp: now });
		const t2 = makeTurn(1, ["write"], ["src/b.ts"], { timestamp: now + 100 });

		const r1 = ingestTurn([], null, t1);
		r1.operations[0]!.tools.add("read");
		r1.operations[0]!.files.add("src/a.ts");

		const r2 = ingestTurn(r1.operations, r1.activeOperationId, t2);

		expect(r2.operations[0]!.outcome).not.toBe("in_progress");
	});
});

// ---------------------------------------------------------------------------
// ingest (full pipeline entry point)
// ---------------------------------------------------------------------------

describe("ingest", () => {
	beforeEach(() => {
		resetOperationIdCounter();
	});

	it("processes a sequence of messages into operations", () => {
		const messages: Message[] = [
			makeAssistantMsg([{ name: "read", path: "src/a.ts" }]),
			makeUserMsg([{ id: "tu_read" }], "content a"),
			makeAssistantMsg([{ name: "read", path: "src/b.ts" }]),
			makeUserMsg([{ id: "tu_read" }], "content b"),
		];

		const result = ingest(messages, [], null);

		expect(result.operations).toHaveLength(1);
		expect(result.operations[0]!.turns).toHaveLength(2);
	});

	it("is idempotent when called twice with the same messages", () => {
		const messages: Message[] = [
			makeAssistantMsg([{ name: "read", path: "src/a.ts" }]),
			makeUserMsg([{ id: "tu_read" }], "content"),
		];

		const r1 = ingest(messages, [], null);
		const r2 = ingest(messages, r1.operations, r1.activeOperationId);

		// No new turns — registry should be unchanged
		expect(r2.operations).toHaveLength(r1.operations.length);
		expect(r2.operations[0]!.turns).toHaveLength(r1.operations[0]!.turns.length);
	});

	it("handles incremental ingestion correctly", () => {
		const messages1: Message[] = [
			makeAssistantMsg([{ name: "read", path: "src/a.ts" }]),
			makeUserMsg([{ id: "tu_read" }], "content a"),
		];
		const messages2: Message[] = [
			...messages1,
			makeAssistantMsg([{ name: "read", path: "src/b.ts" }]),
			makeUserMsg([{ id: "tu_read2" }], "content b"),
		];

		const r1 = ingest(messages1, [], null);
		const r2 = ingest(messages2, r1.operations, r1.activeOperationId);

		expect(r2.operations[0]!.turns).toHaveLength(2);
	});

	it("starts with empty operations when no messages", () => {
		const result = ingest([], [], null);
		expect(result.operations).toHaveLength(0);
		expect(result.activeOperationId).toBeNull();
	});
});
