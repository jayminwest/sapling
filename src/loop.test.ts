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
	IRpcServer,
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

	it("returns responseText in the result when task completes with text", async () => {
		const client = createMockClient([mockTextResponse("The answer is 42.")]);
		const registry = createRegistry([]);

		const result = await runLoop(client, registry, ctx, defaultOptions(testDir));

		expect(result.exitReason).toBe("task_complete");
		expect(result.responseText).toBe("The answer is 42.");
	});

	it("returns undefined responseText when LLM response has no text blocks", async () => {
		// A response with only tool_use blocks that somehow has no text when done
		// We simulate: first call uses a tool, second call responds with empty text
		const emptyTextResponse: LlmResponse = {
			content: [],
			usage: { inputTokens: 100, outputTokens: 50 },
			model: "mock-model",
			stopReason: "end_turn",
		};
		const responses: LlmResponse[] = [
			mockToolUseResponse("echo", { message: "hi" }, "tc1"),
			emptyTextResponse,
		];
		const client = createMockClient(responses);
		const registry = createRegistry([createEchoTool()]);

		const result = await runLoop(client, registry, ctx, defaultOptions(testDir));

		expect(result.exitReason).toBe("task_complete");
		expect(result.responseText).toBeUndefined();
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

	// ── Hook manager ─────────────────────────────────────────────────────────

	it("blocks tool call when hookManager.preToolCall returns false", async () => {
		const blocked: string[] = [];
		const hookManager = {
			preToolCall(toolName: string, _input: Record<string, unknown>): boolean {
				blocked.push(toolName);
				return false; // always block
			},
			postToolCall(_toolName: string, _result: string): void {},
		};

		const responses: LlmResponse[] = [
			mockToolUseResponse("echo", { message: "hi" }, "tc1"),
			mockTextResponse("done after block"),
		];
		const client = createMockClient(responses);
		const registry = createRegistry([createEchoTool()]);

		const result = await runLoop(client, registry, ctx, defaultOptions(testDir, { hookManager }));

		expect(result.exitReason).toBe("task_complete");
		// The hook was called for "echo"
		expect(blocked).toContain("echo");
		// Loop completed with 2 turns (tool call was blocked, LLM got error result and responded)
		expect(result.totalTurns).toBe(2);
	});

	it("allows tool call when hookManager.preToolCall returns true", async () => {
		const allowed: string[] = [];
		const hookManager = {
			preToolCall(toolName: string, _input: Record<string, unknown>): boolean {
				allowed.push(toolName);
				return true;
			},
			postToolCall(_toolName: string, _result: string): void {},
		};

		const responses: LlmResponse[] = [
			mockToolUseResponse("echo", { message: "hello" }, "tc1"),
			mockTextResponse("done"),
		];
		const client = createMockClient(responses);
		const registry = createRegistry([createEchoTool()]);

		const result = await runLoop(client, registry, ctx, defaultOptions(testDir, { hookManager }));

		expect(result.exitReason).toBe("task_complete");
		expect(allowed).toContain("echo");
	});

	it("calls hookManager.postToolCall after successful tool execution", async () => {
		const postCalls: { toolName: string; result: string }[] = [];
		const hookManager = {
			preToolCall(_toolName: string, _input: Record<string, unknown>): boolean {
				return true;
			},
			postToolCall(toolName: string, result: string): void {
				postCalls.push({ toolName, result });
			},
		};

		const responses: LlmResponse[] = [
			mockToolUseResponse("echo", { message: "world" }, "tc1"),
			mockTextResponse("done"),
		];
		const client = createMockClient(responses);
		const registry = createRegistry([createEchoTool()]);

		await runLoop(client, registry, ctx, defaultOptions(testDir, { hookManager }));

		expect(postCalls).toHaveLength(1);
		expect(postCalls[0]?.toolName).toBe("echo");
		expect(postCalls[0]?.result).toBe("world");
	});

	it("does not call hookManager when no hookManager is provided", async () => {
		// No hookManager — loop should work normally
		const responses: LlmResponse[] = [
			mockToolUseResponse("echo", { message: "ok" }, "tc1"),
			mockTextResponse("done"),
		];
		const client = createMockClient(responses);
		const registry = createRegistry([createEchoTool()]);

		const result = await runLoop(client, registry, ctx, defaultOptions(testDir));
		expect(result.exitReason).toBe("task_complete");
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

	// ── RPC server integration ───────────────────────────────────────────────

	it("returns aborted when rpcServer.isAbortRequested() is true before first turn", async () => {
		const rpcServer: IRpcServer = {
			dequeue: () => undefined,
			isAbortRequested: () => true,
		};
		const client = createMockClient([mockTextResponse("should not be called")]);
		const registry = createRegistry([]);
		const opts = defaultOptions(testDir, { rpcServer });

		const result = await runLoop(client, registry, ctx, opts);

		expect(result.exitReason).toBe("aborted");
		expect(result.totalTurns).toBe(0);
	});

	it("returns aborted after one tool turn when abort is set", async () => {
		let abortAfterFirstTurn = false;
		const rpcServer: IRpcServer = {
			dequeue: () => undefined,
			isAbortRequested: () => abortAfterFirstTurn,
		};

		const responses: LlmResponse[] = [
			mockToolUseResponse("echo", { message: "hi" }, "tc1"),
			// Second turn should not be reached
			mockTextResponse("done"),
		];
		const client = createMockClient(responses);
		const registry = createRegistry([createEchoTool()]);
		const opts = defaultOptions(testDir, { rpcServer });

		// Set abort flag after tool turn completes
		const origCtx = ctx;
		let processCount = 0;
		const trackingCtx: ContextManager = {
			process(messages: Message[], usage: TokenUsage, files: string[]): Message[] {
				processCount++;
				if (processCount === 1) abortAfterFirstTurn = true;
				return origCtx.process(messages, usage, files);
			},
			getUtilization: origCtx.getUtilization,
			getArchive: origCtx.getArchive,
		};

		const result = await runLoop(client, registry, trackingCtx, opts);

		expect(result.exitReason).toBe("aborted");
		expect(result.totalTurns).toBe(1);
	});

	it("injects steer request into tool results when dequeued", async () => {
		let dequeueCount = 0;
		const rpcServer: IRpcServer = {
			dequeue: () => {
				// Return steer request on first dequeue (after turn 1 tool results)
				if (dequeueCount === 0) {
					dequeueCount++;
					return { method: "steer", params: { content: "change approach" } };
				}
				return undefined;
			},
			isAbortRequested: () => false,
		};

		const responses: LlmResponse[] = [
			mockToolUseResponse("echo", { message: "hello" }, "tc1"),
			mockTextResponse("done with steering"),
		];
		const client = createMockClient(responses);
		const registry = createRegistry([createEchoTool()]);
		const opts = defaultOptions(testDir, { rpcServer });

		const result = await runLoop(client, registry, ctx, opts);

		expect(result.exitReason).toBe("task_complete");
		expect(result.totalTurns).toBe(2);

		// The second LLM call should have received the steer content in its messages
		const callsAccessor = client as unknown as { calls: { messages: Message[] }[] };
		const secondCallMessages = callsAccessor.calls[1]?.messages;
		expect(secondCallMessages).toBeDefined();

		// Find the user message that contains steer content
		const hasSteer = secondCallMessages?.some((m) => {
			if (m.role !== "user" || typeof m.content === "string") return false;
			return m.content.some(
				(b) => b.type === "text" && (b as { type: "text"; text: string }).text.includes("[STEER]"),
			);
		});
		expect(hasSteer).toBe(true);
	});

	it("drains all queued RPC requests in a single turn", async () => {
		const queue = [
			{ method: "steer", params: { content: "focus on tests" } },
			{ method: "steer", params: { content: "keep it simple" } },
		];
		const rpcServer: IRpcServer = {
			dequeue: () => queue.shift(),
			isAbortRequested: () => false,
		};

		const responses: LlmResponse[] = [
			mockToolUseResponse("echo", { message: "hello" }, "tc1"),
			mockTextResponse("done with all steers"),
		];
		const client = createMockClient(responses);
		const registry = createRegistry([createEchoTool()]);
		const opts = defaultOptions(testDir, { rpcServer });

		const result = await runLoop(client, registry, ctx, opts);

		expect(result.exitReason).toBe("task_complete");
		expect(result.totalTurns).toBe(2);

		// The second LLM call should contain both steer messages
		const callsAccessor = client as unknown as { calls: { messages: Message[] }[] };
		const secondCallMessages = callsAccessor.calls[1]?.messages;
		expect(secondCallMessages).toBeDefined();

		const steerTexts = secondCallMessages
			?.flatMap((m) => {
				if (m.role !== "user" || typeof m.content === "string") return [];
				return m.content
					.filter((b) => b.type === "text")
					.map((b) => (b as { type: "text"; text: string }).text);
			})
			.filter((t) => t.includes("[STEER]"));

		expect(steerTexts).toHaveLength(2);
		expect(steerTexts?.[0]).toContain("focus on tests");
		expect(steerTexts?.[1]).toContain("keep it simple");
	});

	it("loop works normally without rpcServer", async () => {
		const responses: LlmResponse[] = [
			mockToolUseResponse("echo", { message: "ok" }, "tc1"),
			mockTextResponse("done"),
		];
		const client = createMockClient(responses);
		const registry = createRegistry([createEchoTool()]);
		// No rpcServer in opts
		const result = await runLoop(client, registry, ctx, defaultOptions(testDir));

		expect(result.exitReason).toBe("task_complete");
	});
});
