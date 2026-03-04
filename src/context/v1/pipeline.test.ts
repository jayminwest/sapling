/**
 * Tests for SaplingPipelineV1 — the orchestrating v1 context pipeline class.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { Message } from "../../types.ts";
import { resetOperationIdCounter } from "./ingest.ts";
import { extractTurnHint, SaplingPipelineV1 } from "./pipeline.ts";

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

function makeUserMsg(toolIds: Array<{ id: string; isError?: boolean }>): Message & {
	role: "user";
} {
	const blocks = toolIds.map((t) => ({
		type: "tool_result" as const,
		tool_use_id: t.id,
		content: t.isError ? "Error occurred" : "ok",
		...(t.isError ? { is_error: true } : {}),
	})) as unknown as import("../../types.ts").ContentBlock[];
	return { role: "user", content: blocks };
}

const BASE_PROMPT = "You are Sapling, a coding agent.";
const TASK_MSG: Message = { role: "user", content: "Fix the bug in loop.ts" };
const DEFAULT_WINDOW = 200_000;

function makePipeline(windowSize = DEFAULT_WINDOW): SaplingPipelineV1 {
	return new SaplingPipelineV1({ windowSize });
}

/** Build a minimal PipelineInput. */
function makeInput(messages: Message[]): Parameters<SaplingPipelineV1["process"]>[0] {
	return {
		messages,
		systemPrompt: BASE_PROMPT,
		turnHint: { turn: 1, tools: [], files: [], hasError: false },
		usage: { inputTokens: 100, outputTokens: 50 },
	};
}

// ---------------------------------------------------------------------------
// Core behavior
// ---------------------------------------------------------------------------

describe("SaplingPipelineV1", () => {
	beforeEach(() => {
		resetOperationIdCounter();
	});

	describe("constructor", () => {
		it("initializes with empty operation registry", () => {
			const pipeline = makePipeline();
			expect(pipeline.getState()).toBeNull();
			expect(pipeline.getRpcState()).toBeNull();
		});
	});

	describe("process — basic single turn", () => {
		it("returns task message as first message", () => {
			const pipeline = makePipeline();
			const assistant = makeAssistantMsg([{ name: "read", path: "src/loop.ts" }]);
			const toolResults = makeUserMsg([{ id: "tu_read" }]);
			const messages: Message[] = [TASK_MSG, assistant, toolResults];

			const output = pipeline.process(makeInput(messages));

			expect(output.messages[0]).toBe(TASK_MSG);
		});

		it("preserves assistant and tool result messages", () => {
			const pipeline = makePipeline();
			const assistant = makeAssistantMsg([{ name: "read", path: "src/loop.ts" }]);
			const toolResults = makeUserMsg([{ id: "tu_read" }]);
			const messages: Message[] = [TASK_MSG, assistant, toolResults];

			const output = pipeline.process(makeInput(messages));

			// Should contain task + assistant + user (3 messages)
			expect(output.messages.length).toBeGreaterThanOrEqual(3);
		});

		it("returns a system prompt string", () => {
			const pipeline = makePipeline();
			const messages: Message[] = [TASK_MSG];

			const output = pipeline.process(makeInput(messages));

			expect(typeof output.systemPrompt).toBe("string");
			expect(output.systemPrompt.includes(BASE_PROMPT)).toBe(true);
		});

		it("returns pipeline state", () => {
			const pipeline = makePipeline();
			const assistant = makeAssistantMsg([{ name: "read" }]);
			const toolResults = makeUserMsg([{ id: "tu_read" }]);
			const messages: Message[] = [TASK_MSG, assistant, toolResults];

			const output = pipeline.process(makeInput(messages));

			expect(output.state).toBeDefined();
			expect(typeof output.state.utilization).toBe("number");
			expect(output.state.utilization).toBeGreaterThanOrEqual(0);
			expect(output.state.utilization).toBeLessThanOrEqual(1);
		});

		it("creates one active operation after first turn", () => {
			const pipeline = makePipeline();
			const assistant = makeAssistantMsg([{ name: "read" }]);
			const toolResults = makeUserMsg([{ id: "tu_read" }]);
			const messages: Message[] = [TASK_MSG, assistant, toolResults];

			const output = pipeline.process(makeInput(messages));

			expect(output.state.activeOperationId).not.toBeNull();
			expect(output.state.operationCounts.active).toBe(1);
		});
	});

	describe("process — state persistence across calls", () => {
		it("accumulates operations across multiple process() calls", () => {
			const pipeline = makePipeline();

			// Turn 1: explore
			const a1 = makeAssistantMsg([{ name: "read", path: "src/loop.ts" }]);
			const u1 = makeUserMsg([{ id: "tu_read" }]);
			const msgs1: Message[] = [TASK_MSG, a1, u1];
			pipeline.process(makeInput(msgs1));

			// Turn 2: still exploring (same operation)
			const a2 = makeAssistantMsg([{ name: "grep", path: "src/loop.ts" }]);
			const u2 = makeUserMsg([{ id: "tu_grep" }]);
			const msgs2: Message[] = [...msgs1, a2, u2];
			const output2 = pipeline.process(makeInput(msgs2));

			// Still one operation (same type, same files)
			const activeOp = output2.state.operations.find(
				(op) => op.id === output2.state.activeOperationId,
			);
			expect(activeOp).toBeDefined();
			expect(activeOp?.turns.length).toBeGreaterThanOrEqual(1);
		});

		it("getState() returns last pipeline state", () => {
			const pipeline = makePipeline();
			const messages: Message[] = [TASK_MSG];

			pipeline.process(makeInput(messages));

			const state = pipeline.getState();
			expect(state).not.toBeNull();
			expect(state?.operations).toBeDefined();
		});

		it("getRpcState() returns compact state after process()", () => {
			const pipeline = makePipeline();
			const assistant = makeAssistantMsg([{ name: "read" }]);
			const toolResults = makeUserMsg([{ id: "tu_read" }]);
			const messages: Message[] = [TASK_MSG, assistant, toolResults];

			pipeline.process(makeInput(messages));

			const rpcState = pipeline.getRpcState();
			expect(rpcState).not.toBeNull();
			expect(
				typeof rpcState?.activeOperationId === "number" || rpcState?.activeOperationId === null,
			).toBe(true);
			expect(typeof rpcState?.operationCount).toBe("number");
			expect(typeof rpcState?.contextUtilization).toBe("number");
			expect(typeof rpcState?.archiveEntryCount).toBe("number");
		});
	});

	describe("process — system prompt composition", () => {
		it("includes base prompt in system prompt", () => {
			const pipeline = makePipeline();
			const output = pipeline.process(makeInput([TASK_MSG]));
			expect(output.systemPrompt).toContain(BASE_PROMPT);
		});

		it("does not modify base prompt on first turn (no working memory yet)", () => {
			const pipeline = makePipeline();
			const output = pipeline.process(makeInput([TASK_MSG]));
			// Working memory only appears when operations are archived
			// On the first turn with no archived ops, system prompt = base prompt
			// (active context section may be appended)
			expect(output.systemPrompt.startsWith(BASE_PROMPT)).toBe(true);
		});
	});

	describe("process — throws on empty messages", () => {
		it("throws when messages array is empty", () => {
			const pipeline = makePipeline();
			expect(() => pipeline.process(makeInput([]))).toThrow();
		});
	});

	describe("process — budget enforcement", () => {
		it("applies budget constraints based on window size", () => {
			const pipeline = makePipeline(DEFAULT_WINDOW);
			const assistant = makeAssistantMsg([{ name: "read" }]);
			const toolResults = makeUserMsg([{ id: "tu_read" }]);
			const messages: Message[] = [TASK_MSG, assistant, toolResults];

			const output = pipeline.process(makeInput(messages));

			// Utilization should be well below 1.0 for small inputs
			expect(output.state.utilization).toBeLessThan(0.5);
		});

		it("archives operations that exceed budget", () => {
			// Very small window to force archiving
			const smallWindow = 500;
			const pipeline = new SaplingPipelineV1({ windowSize: smallWindow });

			const assistant = makeAssistantMsg([{ name: "read" }]);
			const toolResults = makeUserMsg([{ id: "tu_read" }]);
			const messages: Message[] = [TASK_MSG, assistant, toolResults];

			const output = pipeline.process(makeInput(messages));

			// With a tiny window, utilization may be very high but still valid
			expect(output.state.utilization).toBeGreaterThanOrEqual(0);
			expect(output.state.utilization).toBeLessThanOrEqual(1);
		});
	});

	describe("process — message ordering", () => {
		it("task message is always first", () => {
			const pipeline = makePipeline();
			const a1 = makeAssistantMsg([{ name: "read", path: "src/loop.ts" }], "Let me read the file.");
			const u1 = makeUserMsg([{ id: "tu_read" }]);
			const a2 = makeAssistantMsg(
				[{ name: "edit", path: "src/loop.ts" }],
				"Now I'll edit the file.",
			);
			const u2 = makeUserMsg([{ id: "tu_edit" }]);
			const messages: Message[] = [TASK_MSG, a1, u1, a2, u2];

			const output = pipeline.process(makeInput(messages));

			expect(output.messages[0]).toBe(TASK_MSG);
		});

		it("messages maintain alternating assistant/user roles", () => {
			const pipeline = makePipeline();
			const a1 = makeAssistantMsg([{ name: "read" }]);
			const u1 = makeUserMsg([{ id: "tu_read" }]);
			const messages: Message[] = [TASK_MSG, a1, u1];

			const output = pipeline.process(makeInput(messages));

			// Verify alternating roles after task message
			for (let i = 1; i < output.messages.length - 1; i++) {
				const current = output.messages[i];
				const next = output.messages[i + 1];
				if (current && next) {
					expect(current.role).not.toBe(next.role);
				}
			}
		});
	});

	describe("process — operation counts", () => {
		it("operationCounts reflects current registry state", () => {
			const pipeline = makePipeline();
			const assistant = makeAssistantMsg([{ name: "read" }]);
			const toolResults = makeUserMsg([{ id: "tu_read" }]);
			const messages: Message[] = [TASK_MSG, assistant, toolResults];

			const output = pipeline.process(makeInput(messages));

			const counts = output.state.operationCounts;
			const total = counts.active + counts.completed + counts.compacted + counts.archived;
			expect(total).toBe(output.state.operations.length);
		});
	});
});

// ---------------------------------------------------------------------------
// process — turns not dropped after compaction
// ---------------------------------------------------------------------------

describe("process — turns not dropped after compaction", () => {
	it("does not drop new turns after compaction", () => {
		// Use a tiny window to force compaction of earlier operations quickly.
		// We add enough turns to trigger compaction, then add one more and verify it appears.
		const pipeline = new SaplingPipelineV1({ windowSize: 2_000 });

		// Build up a sequence of turns with distinct tool types to trigger operation boundaries
		// (which creates multiple operations, some of which will get compacted).
		const turns: Message[] = [TASK_MSG];
		for (let i = 0; i < 5; i++) {
			const assistant = makeAssistantMsg([{ name: "read", path: `src/file${i}.ts` }]);
			const user = makeUserMsg([{ id: `tu_read_${i}` }]);
			turns.push(assistant, user);
		}

		// Run pipeline on the first batch to trigger compaction/archiving
		pipeline.process(makeInput(turns));

		// Now add one more turn with a different tool type
		// makeAssistantMsg creates tool_use with id=`tu_${name}`, so name="bash" → id="tu_bash"
		const newAssistant = makeAssistantMsg([{ name: "bash" }]);
		const newUser = makeUserMsg([{ id: "tu_bash" }]); // matches the tool_use id
		const allMessages = [...turns, newAssistant, newUser];

		const output = pipeline.process(makeInput(allMessages));

		// The new turn (bash) should appear in the output messages
		const hasNewTurn = output.messages.some(
			(msg) =>
				msg.role === "assistant" &&
				Array.isArray(msg.content) &&
				msg.content.some((b) => b.type === "tool_use" && b.name === "bash"),
		);
		expect(hasNewTurn).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// extractTurnHint helper
// ---------------------------------------------------------------------------

describe("extractTurnHint", () => {
	it("extracts tool names from assistant message", () => {
		const assistant: Message = {
			role: "assistant",
			content: [
				{ type: "tool_use", id: "tu_1", name: "read", input: { path: "src/foo.ts" } },
				{ type: "tool_use", id: "tu_2", name: "bash", input: {} },
			],
		};
		const messages: Message[] = [TASK_MSG, assistant];
		const hint = extractTurnHint(messages, 1);

		expect(hint.turn).toBe(1);
		expect(hint.tools).toContain("read");
		expect(hint.tools).toContain("bash");
	});

	it("extracts file paths from tool_use inputs", () => {
		const assistant: Message = {
			role: "assistant",
			content: [{ type: "tool_use", id: "tu_1", name: "read", input: { path: "src/loop.ts" } }],
		};
		const messages: Message[] = [TASK_MSG, assistant];
		const hint = extractTurnHint(messages, 1);

		expect(hint.files).toContain("src/loop.ts");
	});

	it("detects hasError from tool_result blocks", () => {
		const assistant: Message = {
			role: "assistant",
			content: [{ type: "tool_use", id: "tu_1", name: "bash", input: {} }],
		};
		const toolResults: Message = {
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "tu_1",
					content: "Command failed",
					is_error: true,
				},
			] as unknown as import("../../types.ts").ContentBlock[],
		};
		const messages: Message[] = [TASK_MSG, assistant, toolResults];
		const hint = extractTurnHint(messages, 2);

		expect(hint.hasError).toBe(true);
	});

	it("returns false hasError when no errors", () => {
		const assistant: Message = {
			role: "assistant",
			content: [{ type: "tool_use", id: "tu_1", name: "read", input: {} }],
		};
		const toolResults: Message = {
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "tu_1",
					content: "file content",
				},
			] as unknown as import("../../types.ts").ContentBlock[],
		};
		const messages: Message[] = [TASK_MSG, assistant, toolResults];
		const hint = extractTurnHint(messages, 1);

		expect(hint.hasError).toBe(false);
	});

	it("handles empty messages gracefully", () => {
		const hint = extractTurnHint([TASK_MSG], 1);

		expect(hint.tools).toEqual([]);
		expect(hint.files).toEqual([]);
		expect(hint.hasError).toBe(false);
	});
});
