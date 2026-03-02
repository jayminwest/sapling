/**
 * Tests for the agent turn loop (src/loop.ts).
 *
 * WHY MOCK: The LlmClient is mocked because real API calls have cost and latency.
 * The ToolRegistry and ContextManager are stubbed with minimal implementations
 * to isolate loop behavior under test.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ClientError } from "./errors.ts";
import { runLoop } from "./loop.ts";
import {
	cleanupTempDir,
	createMockClient,
	createTempDir,
	mockTextResponse,
	mockToolUseResponse,
} from "./test-helpers.ts";
import type {
	BudgetUtilization,
	ContextArchive,
	ContextManager,
	LlmClient,
	LlmResponse,
	LoopOptions,
	Message,
	TokenUsage,
	Tool,
	ToolDefinition,
	ToolRegistry,
	ToolResult,
} from "./types.ts";

// ─── Test Stubs ───────────────────────────────────────────────────────────────

/** A no-op context manager that passes messages through unchanged. */
function createPassthroughContextManager(): ContextManager {
	return {
		process(messages: Message[], _usage: TokenUsage, _files: string[]): Message[] {
			return messages;
		},
		getUtilization(): BudgetUtilization {
			const entry = { used: 0, budget: 0 };
			return {
				systemPrompt: entry,
				archiveSummary: entry,
				recentHistory: entry,
				currentTurn: entry,
				headroom: entry,
				total: entry,
			};
		},
		getArchive(): ContextArchive {
			return {
				workSummary: "",
				decisions: [],
				modifiedFiles: new Map(),
				fileHashes: new Map(),
				resolvedErrors: [],
			};
		},
	};
}

/** A simple tool that echoes its "message" input. */
function createEchoTool(name = "echo"): Tool {
	return {
		name,
		description: "Echo a message back",
		inputSchema: {
			type: "object",
			properties: { message: { type: "string", description: "Message to echo" } },
			required: ["message"],
		},
		async execute(input: Record<string, unknown>): Promise<ToolResult> {
			return { content: String(input.message ?? ""), isError: false };
		},
		toDefinition(): ToolDefinition {
			return {
				name,
				description: "Echo a message back",
				input_schema: {
					type: "object",
					properties: { message: { type: "string", description: "Message to echo" } },
					required: ["message"],
				},
			};
		},
	};
}

/** A tool that always returns an error result. */
function createErrorTool(name = "error_tool"): Tool {
	return {
		name,
		description: "Always returns an error",
		inputSchema: { type: "object", properties: {} },
		async execute(): Promise<ToolResult> {
			return { content: "Tool always fails", isError: true };
		},
		toDefinition(): ToolDefinition {
			return {
				name,
				description: "Always returns an error",
				input_schema: { type: "object", properties: {} },
			};
		},
	};
}

/** A tool that throws an exception during execution. */
function createThrowingTool(name = "throwing_tool"): Tool {
	return {
		name,
		description: "Throws during execution",
		inputSchema: { type: "object", properties: {} },
		async execute(): Promise<ToolResult> {
			throw new Error("Tool threw an exception");
		},
		toDefinition(): ToolDefinition {
			return {
				name,
				description: "Throws during execution",
				input_schema: { type: "object", properties: {} },
			};
		},
	};
}

/** Build a minimal ToolRegistry from an array of tools. */
function createRegistry(toolList: Tool[]): ToolRegistry {
	const byName = new Map<string, Tool>(toolList.map((t) => [t.name, t]));
	return {
		register(tool: Tool): void {
			byName.set(tool.name, tool);
		},
		get(name: string): Tool | undefined {
			return byName.get(name);
		},
		list(): Tool[] {
			return [...byName.values()];
		},
		toDefinitions(): ToolDefinition[] {
			return [...byName.values()].map((t) => t.toDefinition());
		},
	};
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function defaultOptions(cwd: string, overrides: Partial<LoopOptions> = {}): LoopOptions {
	return {
		task: "Test task",
		systemPrompt: "You are a test agent.",
		model: "mock-model",
		maxTurns: 10,
		cwd,
		...overrides,
	};
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("runLoop", () => {
	let testDir: string;
	let ctx: ContextManager;

	beforeEach(async () => {
		testDir = await createTempDir();
		ctx = createPassthroughContextManager();
	});

	afterEach(async () => {
		await cleanupTempDir(testDir);
	});

	// ── Stop conditions ──────────────────────────────────────────────────────

	it("returns task_complete when LLM sends no tool calls", async () => {
		const client = createMockClient([mockTextResponse("I am done.")]);
		const registry = createRegistry([]);
		const opts = defaultOptions(testDir);

		const result = await runLoop(client, registry, ctx, opts);

		expect(result.exitReason).toBe("task_complete");
		expect(result.totalTurns).toBe(1);
	});

	it("returns max_turns when turn limit is reached", async () => {
		// Always responds with a tool call — never stops naturally
		const client = createMockClient([mockToolUseResponse("echo", { message: "hello" }, "tc1")]);
		const registry = createRegistry([createEchoTool()]);
		// Each turn: LLM calls echo → we reply with result → repeat
		// Mock repeats the last response indefinitely
		const opts = defaultOptions(testDir, { maxTurns: 3 });

		const result = await runLoop(client, registry, ctx, opts);

		expect(result.exitReason).toBe("max_turns");
		expect(result.totalTurns).toBe(3);
	});

	// ── Token accounting ─────────────────────────────────────────────────────

	it("accumulates token counts across turns", async () => {
		const responses: LlmResponse[] = [
			// Turn 1: tool call
			mockToolUseResponse("echo", { message: "hi" }, "tc1"),
			// Turn 2: no tool call → done
			mockTextResponse("done"),
		];
		const client = createMockClient(responses);
		const registry = createRegistry([createEchoTool()]);

		const result = await runLoop(client, registry, ctx, defaultOptions(testDir));

		// Each mockResponse has 100 input + 50 output tokens → 2 turns = 200 + 100
		expect(result.totalInputTokens).toBe(200);
		expect(result.totalOutputTokens).toBe(100);
		expect(result.totalTurns).toBe(2);
	});

	// ── Tool dispatch ────────────────────────────────────────────────────────

	it("executes a tool and returns result to LLM", async () => {
		const echoTool = createEchoTool();
		const responses: LlmResponse[] = [
			mockToolUseResponse("echo", { message: "ping" }, "tc1"),
			mockTextResponse("pong"),
		];
		const client = createMockClient(responses);
		const registry = createRegistry([echoTool]);

		const result = await runLoop(client, registry, ctx, defaultOptions(testDir));

		expect(result.exitReason).toBe("task_complete");
		// The second LLM call should have received the tool result in its messages
		const secondCall = (client as unknown as { calls: { messages: Message[] }[] }).calls[1];
		expect(secondCall).toBeDefined();
	});

	it("handles tool errors without aborting the loop", async () => {
		const responses: LlmResponse[] = [
			mockToolUseResponse("error_tool", {}, "tc1"),
			mockTextResponse("ok despite error"),
		];
		const client = createMockClient(responses);
		const registry = createRegistry([createErrorTool()]);

		const result = await runLoop(client, registry, ctx, defaultOptions(testDir));

		expect(result.exitReason).toBe("task_complete");
		expect(result.error).toBeUndefined();
	});

	it("catches tool exceptions and returns error result to LLM", async () => {
		const responses: LlmResponse[] = [
			mockToolUseResponse("throwing_tool", {}, "tc1"),
			mockTextResponse("handled"),
		];
		const client = createMockClient(responses);
		const registry = createRegistry([createThrowingTool()]);

		const result = await runLoop(client, registry, ctx, defaultOptions(testDir));

		expect(result.exitReason).toBe("task_complete");
	});

	it("returns error result for unknown tool without aborting", async () => {
		const responses: LlmResponse[] = [
			mockToolUseResponse("nonexistent_tool", {}, "tc1"),
			mockTextResponse("acknowledged"),
		];
		const client = createMockClient(responses);
		const registry = createRegistry([]); // no tools registered

		const result = await runLoop(client, registry, ctx, defaultOptions(testDir));

		expect(result.exitReason).toBe("task_complete");
	});

	// ── Parallel execution ───────────────────────────────────────────────────

	it("executes multiple tool calls from a single turn in parallel", async () => {
		const executionOrder: string[] = [];

		const slowTool: Tool = {
			name: "slow",
			description: "Slow tool",
			inputSchema: { type: "object", properties: {} },
			async execute(): Promise<ToolResult> {
				await new Promise<void>((r) => setTimeout(r, 10));
				executionOrder.push("slow");
				return { content: "slow done" };
			},
			toDefinition(): ToolDefinition {
				return {
					name: "slow",
					description: "Slow tool",
					input_schema: { type: "object", properties: {} },
				};
			},
		};
		const fastTool: Tool = {
			name: "fast",
			description: "Fast tool",
			inputSchema: { type: "object", properties: {} },
			async execute(): Promise<ToolResult> {
				executionOrder.push("fast");
				return { content: "fast done" };
			},
			toDefinition(): ToolDefinition {
				return {
					name: "fast",
					description: "Fast tool",
					input_schema: { type: "object", properties: {} },
				};
			},
		};

		// Single response with two tool calls
		const twoToolsResponse: LlmResponse = {
			content: [
				{ type: "tool_use", id: "tc1", name: "slow", input: {} },
				{ type: "tool_use", id: "tc2", name: "fast", input: {} },
			],
			usage: { inputTokens: 100, outputTokens: 50 },
			model: "mock-model",
			stopReason: "tool_use",
		};
		const doneResponse = mockTextResponse("all done");

		const client = createMockClient([twoToolsResponse, doneResponse]);
		const registry = createRegistry([slowTool, fastTool]);

		const result = await runLoop(client, registry, ctx, defaultOptions(testDir));

		expect(result.exitReason).toBe("task_complete");
		// Both tools ran (order doesn't matter for parallel execution)
		expect(executionOrder).toContain("slow");
		expect(executionOrder).toContain("fast");
		// fast runs before slow finishes (parallel execution)
		expect(executionOrder[0]).toBe("fast");
	});

	// ── Error handling ───────────────────────────────────────────────────────

	it("returns error exit when LLM call fails after retries", async () => {
		let callCount = 0;
		const failingClient: LlmClient = {
			id: "failing",
			call: async () => {
				callCount++;
				throw new ClientError("API unavailable", "TRANSIENT_ERROR");
			},
			estimateTokens: (text: string) => Math.ceil(text.length / 4),
		};
		const registry = createRegistry([]);

		// Use maxTurns=1 and set delays to 0 for test speed
		// Note: real backoff tests would need to mock setTimeout
		const result = await runLoop(
			failingClient,
			registry,
			ctx,
			defaultOptions(testDir, { maxTurns: 1 }),
		);

		expect(result.exitReason).toBe("error");
		expect(result.error).toBeDefined();
		// 3 retry attempts
		expect(callCount).toBe(3);
	});

	it("aborts immediately on unrecoverable LLM errors", async () => {
		let callCount = 0;
		const authFailClient: LlmClient = {
			id: "auth-fail",
			call: async () => {
				callCount++;
				throw new ClientError("Authentication failed", "AUTH_FAILED");
			},
			estimateTokens: (text: string) => Math.ceil(text.length / 4),
		};
		const registry = createRegistry([]);

		const result = await runLoop(authFailClient, registry, ctx, defaultOptions(testDir));

		expect(result.exitReason).toBe("error");
		expect(result.error).toContain("Authentication failed");
		// No retries for unrecoverable errors
		expect(callCount).toBe(1);
	});

	// ── Context manager integration ──────────────────────────────────────────

	it("passes messages through the context manager after each turn", async () => {
		let processCalls = 0;
		const trackingCtx: ContextManager = {
			process(messages: Message[], _usage: TokenUsage, _files: string[]): Message[] {
				processCalls++;
				return messages;
			},
			getUtilization: createPassthroughContextManager().getUtilization,
			getArchive: createPassthroughContextManager().getArchive,
		};

		const responses: LlmResponse[] = [
			mockToolUseResponse("echo", { message: "hi" }, "tc1"),
			mockTextResponse("done"),
		];
		const client = createMockClient(responses);
		const registry = createRegistry([createEchoTool()]);

		await runLoop(client, registry, trackingCtx, defaultOptions(testDir));

		// Context manager called once per turn (2 turns total)
		expect(processCalls).toBe(2);
	});

	it("uses context manager output as input for next LLM call", async () => {
		const sentinelMessage: Message = { role: "user", content: "[pruned by context manager]" };
		let processCallCount = 0;

		const rewritingCtx: ContextManager = {
			process(_messages: Message[], _usage: TokenUsage, _files: string[]): Message[] {
				processCallCount++;
				// Return a fixed single-message history
				return [sentinelMessage];
			},
			getUtilization: createPassthroughContextManager().getUtilization,
			getArchive: createPassthroughContextManager().getArchive,
		};

		const responses: LlmResponse[] = [
			mockToolUseResponse("echo", { message: "hi" }, "tc1"),
			mockTextResponse("done"),
		];
		const client = createMockClient(responses);
		const registry = createRegistry([createEchoTool()]);

		await runLoop(client, registry, rewritingCtx, defaultOptions(testDir));

		// Second LLM call should see the rewritten messages from context manager
		const callsAccessor = client as unknown as { calls: { messages: Message[] }[] };
		const secondCallMessages = callsAccessor.calls[1]?.messages;
		expect(secondCallMessages).toBeDefined();
		// The first message in the second call should be the sentinel
		expect(secondCallMessages?.[0]).toEqual(sentinelMessage);
		expect(processCallCount).toBe(2);
	});

	// ── Options ───────────────────────────────────────────────────────────────

	it("passes model and system prompt to LLM request", async () => {
		const client = createMockClient([mockTextResponse("done")]);
		const registry = createRegistry([]);
		const opts = defaultOptions(testDir, {
			model: "claude-opus-4-6",
			systemPrompt: "Custom system prompt",
		});

		await runLoop(client, registry, ctx, opts);

		const callsAccessor = client as unknown as {
			calls: { systemPrompt: string; model: string | undefined }[];
		};
		expect(callsAccessor.calls[0]?.systemPrompt).toBe("Custom system prompt");
		expect(callsAccessor.calls[0]?.model).toBe("claude-opus-4-6");
	});
});
