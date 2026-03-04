/**
 * Tests for the v1 context pipeline Render stage.
 */

import { describe, expect, it } from "bun:test";
import type { Message } from "../../types.ts";
import { composeSystemPrompt, render, renderMessages, renderPipelineState } from "./render.ts";
import type { BudgetUtilization, Operation, Turn } from "./types.ts";

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
	text = "",
	hasError = false,
): Turn {
	const assistant = makeAssistantMsg(
		tools.map((name, i) => ({ name, path: files[i] })),
		text,
	);
	const toolIds = tools.map((name) => ({ id: `tu_${name}`, isError: hasError }));
	const toolResults = makeUserMsg(toolIds);
	return {
		index,
		assistant,
		toolResults,
		meta: {
			tools,
			files,
			hasError,
			hasDecision: false,
			tokens: 100,
			timestamp: Date.now(),
		},
	};
}

function makeTaskMessage(text = "Build the feature"): Message {
	return { role: "user", content: text };
}

function makeBudget(partial: Partial<BudgetUtilization> = {}): BudgetUtilization {
	return {
		windowSize: 200_000,
		systemWithArchive: 10_000,
		activeOperations: 20_000,
		headroom: 170_000,
		utilization: 0.15,
		...partial,
	};
}

// ---------------------------------------------------------------------------
// renderMessages
// ---------------------------------------------------------------------------

describe("renderMessages", () => {
	it("returns [taskMessage] when no retained ops", () => {
		const task = makeTaskMessage();
		const messages = renderMessages(task, []);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toBe(task);
	});

	it("includes task message first", () => {
		const task = makeTaskMessage();
		const turn = makeTurn(0, ["read"], ["src/foo.ts"]);
		const op = makeOperation({ id: 1, status: "active", turns: [turn] });
		const messages = renderMessages(task, [op]);
		expect(messages[0]).toBe(task);
	});

	it("adds full turns from retained active op", () => {
		const task = makeTaskMessage();
		const turn = makeTurn(0, ["read"], ["src/foo.ts"]);
		const op = makeOperation({ id: 1, status: "active", turns: [turn] });
		const messages = renderMessages(task, [op]);
		// task + assistant + user = 3
		expect(messages).toHaveLength(3);
		expect(messages[1]).toBe(turn.assistant);
		expect(messages[2]).toBe(turn.toolResults ?? undefined);
	});

	it("adds full turns from retained completed op", () => {
		const task = makeTaskMessage();
		const turn0 = makeTurn(0, ["read"], ["src/a.ts"]);
		const turn1 = makeTurn(1, ["edit"], ["src/b.ts"]);
		const op = makeOperation({ id: 1, status: "completed", turns: [turn0, turn1] });
		const messages = renderMessages(task, [op]);
		// task + 2 pairs = 5
		expect(messages).toHaveLength(5);
		expect(messages[1]).toBe(turn0.assistant);
		expect(messages[2]).toBe(turn0.toolResults ?? undefined);
		expect(messages[3]).toBe(turn1.assistant);
		expect(messages[4]).toBe(turn1.toolResults ?? undefined);
	});

	it("renders compacted op as synthetic assistant+user pair", () => {
		const task = makeTaskMessage();
		const op = makeOperation({
			id: 2,
			status: "compacted",
			summary: "[Operation #2: explore] Read src/loop.ts\nFiles: loop.ts\nOutcome: success",
			startTurn: 0,
		});
		const messages = renderMessages(task, [op]);
		// task + assistant + user(ack) = 3
		expect(messages).toHaveLength(3);
		const assistant = messages[1] as Message & { role: "assistant" };
		expect(assistant.role).toBe("assistant");
		expect(Array.isArray(assistant.content)).toBe(true);
		const textBlock = (assistant.content as Array<{ type: string; text?: string }>)[0];
		expect(textBlock?.type).toBe("text");
		expect(textBlock?.text).toBe(op.summary ?? undefined);
		const ack = messages[2] as Message;
		expect(ack.role).toBe("user");
		expect(ack.content).toBe("[continued]");
	});

	it("sorts chronologically when compacted op precedes full op turns", () => {
		const task = makeTaskMessage();
		// Compacted op at turn index 0
		const compactedOp = makeOperation({
			id: 1,
			status: "compacted",
			summary: "summary",
			startTurn: 0,
		});
		// Full op starting at turn index 2
		const turn = makeTurn(2, ["edit"], ["src/b.ts"]);
		const fullOp = makeOperation({ id: 2, status: "active", turns: [turn] });

		const messages = renderMessages(task, [compactedOp, fullOp]);
		// task + compacted(assistant,user) + turn(assistant,user) = 5
		expect(messages).toHaveLength(5);
		// Second slot should be the compacted op's synthetic assistant
		const second = messages[1] as Message & { role: "assistant" };
		expect(second.role).toBe("assistant");
		// Fourth slot should be the full op's assistant
		const fourth = messages[3] as Message & { role: "assistant" };
		expect(fourth.role).toBe("assistant");
	});

	it("handles turn without toolResults (final incomplete turn)", () => {
		const task = makeTaskMessage();
		const assistant = makeAssistantMsg([{ name: "read", path: "src/x.ts" }]);
		const turn: Turn = {
			index: 0,
			assistant,
			toolResults: null,
			meta: {
				tools: ["read"],
				files: ["src/x.ts"],
				hasError: false,
				hasDecision: false,
				tokens: 50,
				timestamp: Date.now(),
			},
		};
		const op = makeOperation({ id: 1, status: "active", turns: [turn] });
		const messages = renderMessages(task, [op]);
		// task + assistant only (no toolResults)
		expect(messages).toHaveLength(2);
		expect(messages[1]).toBe(turn.assistant);
	});

	it("sorts turns from multiple ops chronologically", () => {
		const task = makeTaskMessage();
		const turn0 = makeTurn(0, ["read"], ["src/a.ts"]);
		const turn1 = makeTurn(1, ["read"], ["src/b.ts"]);
		const turn2 = makeTurn(2, ["edit"], ["src/c.ts"]);
		// Provide ops in reverse order to test sorting
		const op1 = makeOperation({ id: 2, status: "active", turns: [turn2] });
		const op2 = makeOperation({ id: 1, status: "completed", turns: [turn0, turn1] });
		const messages = renderMessages(task, [op1, op2]);
		// task + 3 pairs = 7
		expect(messages).toHaveLength(7);
		expect(messages[1]).toBe(turn0.assistant);
		expect(messages[3]).toBe(turn1.assistant);
		expect(messages[5]).toBe(turn2.assistant);
	});
});

// ---------------------------------------------------------------------------
// composeSystemPrompt
// ---------------------------------------------------------------------------

describe("composeSystemPrompt", () => {
	const BASE = "You are a helpful builder agent.";

	it("returns basePrompt when no archives and no active context", () => {
		const result = composeSystemPrompt(BASE, [], null, []);
		expect(result).toBe(BASE);
	});

	it("does not include Working Memory section when archivedOps is empty", () => {
		const result = composeSystemPrompt(BASE, [], null, []);
		expect(result).not.toContain("Working Memory");
	});

	it("includes Working Memory section when archivedOps exist", () => {
		const archived = makeOperation({
			id: 1,
			status: "archived",
			type: "explore",
			outcome: "success",
			files: new Set(["src/loop.ts"]),
		});
		const result = composeSystemPrompt(BASE, [archived], null, [archived]);
		expect(result).toContain("## Working Memory");
		expect(result).toContain("Completed Operations (oldest first)");
		expect(result).toContain("[Op #1: explore]");
	});

	it("orders Working Memory entries by id ascending", () => {
		const op1 = makeOperation({ id: 1, status: "archived", type: "explore", outcome: "success" });
		const op2 = makeOperation({ id: 2, status: "archived", type: "mutate", outcome: "success" });
		// Pass in reverse order to confirm sorting
		const result = composeSystemPrompt(BASE, [op2, op1], null, [op1, op2]);
		const idx1 = result.indexOf("[Op #1:");
		const idx2 = result.indexOf("[Op #2:");
		expect(idx1).toBeGreaterThan(-1);
		expect(idx2).toBeGreaterThan(-1);
		expect(idx1).toBeLessThan(idx2);
	});

	it("includes Active Context when activeOp exists", () => {
		const activeOp = makeOperation({
			id: 3,
			status: "active",
			type: "mutate",
			outcome: "in_progress",
			files: new Set(["src/render.ts"]),
		});
		const result = composeSystemPrompt(BASE, [], activeOp, [activeOp]);
		expect(result).toContain("## Active Context");
		expect(result).toContain("**Current operation:**");
		expect(result).toContain("[Op #3: mutate]");
	});

	it("shows None for current operation when no activeOp but artifacts exist", () => {
		// Force active context via artifacts
		const completedOp = makeOperation({
			id: 1,
			status: "completed",
			type: "mutate",
			artifacts: ["src/foo.ts"],
		});
		const result = composeSystemPrompt(BASE, [], null, [completedOp]);
		expect(result).toContain("**Current operation:** None");
	});

	it("lists artifact files in modified files section", () => {
		const op = makeOperation({
			id: 1,
			status: "completed",
			type: "mutate",
			artifacts: ["src/context/render.ts", "src/context/render.test.ts"],
		});
		const result = composeSystemPrompt(BASE, [], null, [op]);
		expect(result).toContain("**Files modified this session:**");
		expect(result).toContain("- src/context/render.ts");
		expect(result).toContain("- src/context/render.test.ts");
	});

	it("deduplicates artifact files across operations", () => {
		const op1 = makeOperation({
			id: 1,
			status: "completed",
			type: "mutate",
			artifacts: ["src/foo.ts"],
		});
		const op2 = makeOperation({
			id: 2,
			status: "active",
			type: "mutate",
			artifacts: ["src/foo.ts", "src/bar.ts"],
		});
		const result = composeSystemPrompt(BASE, [], op2, [op1, op2]);
		// src/foo.ts should appear exactly once
		const count = (result.match(/src\/foo\.ts/g) ?? []).length;
		expect(count).toBe(1);
	});

	it("shows Unresolved errors for failure ops not subsequently fixed", () => {
		const failOp = makeOperation({
			id: 1,
			status: "completed",
			outcome: "failure",
			type: "verify",
			files: new Set(["src/loop.ts"]),
		});
		const result = composeSystemPrompt(BASE, [], null, [failOp]);
		expect(result).toContain("**Unresolved errors:**");
		expect(result).not.toContain("Unresolved errors: None");
	});

	it("shows None for errors when failure ops are subsequently resolved", () => {
		const failOp = makeOperation({
			id: 1,
			status: "completed",
			outcome: "failure",
			type: "verify",
			files: new Set(["src/loop.ts"]),
		});
		const fixOp = makeOperation({
			id: 2,
			status: "active",
			outcome: "success",
			type: "mutate",
			files: new Set(["src/loop.ts"]),
			// Give fixOp an artifact so active context is rendered
			artifacts: ["src/loop.ts"],
		});
		const result = composeSystemPrompt(BASE, [], fixOp, [failOp, fixOp]);
		expect(result).toContain("**Unresolved errors:** None");
	});

	it("does not include archived ops in files modified section", () => {
		const archivedOp = makeOperation({
			id: 1,
			status: "archived",
			type: "mutate",
			artifacts: ["src/old.ts"],
		});
		const result = composeSystemPrompt(BASE, [archivedOp], null, [archivedOp]);
		// archived ops should not appear in active context files
		expect(result).not.toContain("- src/old.ts");
	});
});

// ---------------------------------------------------------------------------
// renderPipelineState
// ---------------------------------------------------------------------------

describe("renderPipelineState", () => {
	it("counts operations by status", () => {
		const ops: Operation[] = [
			makeOperation({ id: 1, status: "active" }),
			makeOperation({ id: 2, status: "completed" }),
			makeOperation({ id: 3, status: "completed" }),
			makeOperation({ id: 4, status: "compacted" }),
			makeOperation({ id: 5, status: "archived" }),
		];
		const budget = makeBudget({ utilization: 0.35 });
		const state = renderPipelineState(ops, 1, budget);
		expect(state.operationCounts.active).toBe(1);
		expect(state.operationCounts.completed).toBe(2);
		expect(state.operationCounts.compacted).toBe(1);
		expect(state.operationCounts.archived).toBe(1);
	});

	it("sets utilization from budget", () => {
		const budget = makeBudget({ utilization: 0.42 });
		const state = renderPipelineState([], null, budget);
		expect(state.utilization).toBe(0.42);
	});

	it("sets activeOperationId", () => {
		const ops: Operation[] = [makeOperation({ id: 7, status: "active" })];
		const state = renderPipelineState(ops, 7, makeBudget());
		expect(state.activeOperationId).toBe(7);
	});

	it("includes all operations in state", () => {
		const ops: Operation[] = [
			makeOperation({ id: 1, status: "archived" }),
			makeOperation({ id: 2, status: "active" }),
		];
		const state = renderPipelineState(ops, 2, makeBudget());
		expect(state.operations).toBe(ops);
	});

	it("handles empty operations list", () => {
		const state = renderPipelineState([], null, makeBudget());
		expect(state.operations).toHaveLength(0);
		expect(state.activeOperationId).toBeNull();
		expect(state.operationCounts.active).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// render (integration)
// ---------------------------------------------------------------------------

describe("render", () => {
	it("returns valid PipelineOutput with all fields", () => {
		const task = makeTaskMessage();
		const turn = makeTurn(0, ["read"], ["src/foo.ts"]);
		const activeOp = makeOperation({ id: 1, status: "active", turns: [turn] });
		const budget = makeBudget({ utilization: 0.2 });
		const output = render(task, [activeOp], [], "Agent persona.", [activeOp], 1, budget);

		expect(output).toHaveProperty("messages");
		expect(output).toHaveProperty("systemPrompt");
		expect(output).toHaveProperty("state");
	});

	it("messages start with task message", () => {
		const task = makeTaskMessage("Do something");
		const output = render(task, [], [], "Persona.", [], null, makeBudget());
		expect(output.messages[0]).toBe(task);
	});

	it("systemPrompt starts with basePrompt", () => {
		const task = makeTaskMessage();
		const output = render(task, [], [], "My agent persona.", [], null, makeBudget());
		expect(output.systemPrompt.startsWith("My agent persona.")).toBe(true);
	});

	it("state reflects all operations including archived", () => {
		const task = makeTaskMessage();
		const archivedOp = makeOperation({ id: 1, status: "archived" });
		const activeOp = makeOperation({ id: 2, status: "active", turns: [makeTurn(0, ["read"], [])] });
		const allOps = [archivedOp, activeOp];
		const output = render(task, [activeOp], [archivedOp], "Persona.", allOps, 2, makeBudget());

		expect(output.state.operationCounts.archived).toBe(1);
		expect(output.state.operationCounts.active).toBe(1);
		expect(output.state.activeOperationId).toBe(2);
	});

	it("includes working memory in system prompt when archived ops present", () => {
		const task = makeTaskMessage();
		const archivedOp = makeOperation({
			id: 1,
			status: "archived",
			type: "explore",
			outcome: "success",
			files: new Set(["src/types.ts"]),
		});
		const output = render(task, [], [archivedOp], "Persona.", [archivedOp], null, makeBudget());
		expect(output.systemPrompt).toContain("## Working Memory");
	});

	it("handles null activeOperationId gracefully", () => {
		const task = makeTaskMessage();
		const output = render(task, [], [], "Persona.", [], null, makeBudget());
		expect(output.state.activeOperationId).toBeNull();
	});
});
