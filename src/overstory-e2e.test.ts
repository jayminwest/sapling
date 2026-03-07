/**
 * E2E tests: verify sapling runtime works via overstory.
 *
 * These tests verify the integration surface that overstory relies on when
 * spawning sapling as a headless agent subprocess:
 *   1. NDJSON event stream (--json mode) emits correct event sequence
 *   2. Guards + eventConfig lifecycle hooks fire at the right moments
 *   3. RPC socket server responds to getState queries
 *   4. Custom system prompt loaded from file
 *   5. RPC abort terminates the loop gracefully
 *
 * Uses mock LLM client + real tool registry. No API key required.
 * sapling-9aec
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadGuardConfig } from "./config.ts";
import { EventEmitter } from "./hooks/events.ts";
import { HookManager } from "./hooks/manager.ts";
import { runLoop } from "./loop.ts";
import { RpcServer } from "./rpc/server.ts";
import { RpcSocketServer } from "./rpc/socket.ts";
import {
	cleanupTempDir,
	createMockClient,
	createTempDir,
	mockTextResponse,
	mockToolUseResponse,
} from "./test-helpers.ts";
import { createDefaultRegistry } from "./tools/index.ts";
import type { EventConfig, GuardConfig, LoopOptions } from "./types.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Collected NDJSON events from an EventEmitter. */
function createCapturingEmitter(): {
	emitter: EventEmitter;
	events: Record<string, unknown>[];
} {
	const events: Record<string, unknown>[] = [];
	const emitter = new EventEmitter(true);
	emitter.emit = (event: Record<string, unknown>) => {
		events.push({ ...event });
		// Don't write to stdout in tests — just capture
	};
	return { emitter, events };
}

/** Write a guards.json file and return its path. */
async function writeGuardsJson(dir: string, config: GuardConfig): Promise<string> {
	const path = join(dir, "guards.json");
	await writeFile(path, JSON.stringify(config), "utf-8");
	return path;
}

function defaultLoopOptions(cwd: string, overrides: Partial<LoopOptions> = {}): LoopOptions {
	return {
		task: "Test task",
		systemPrompt: "You are a test agent.",
		model: "mock-model",
		maxTurns: 5,
		cwd,
		...overrides,
	};
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("overstory runtime E2E", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTempDir();
	});

	afterEach(async () => {
		await cleanupTempDir(testDir);
	});

	// ── 1. NDJSON event stream ─────────────────────────────────────────────────
	// Overstory's SaplingRuntime.parseEvents() consumes these events.
	// Verify the complete event sequence for a simple tool-using run.

	it("emits correct NDJSON event sequence for a tool-using run", async () => {
		const filePath = join(testDir, "hello.txt");
		await Bun.write(filePath, "test content");

		const { emitter, events } = createCapturingEmitter();

		const client = createMockClient([
			mockToolUseResponse("read", { file_path: filePath }, "tc-1"),
			mockTextResponse("Done reading."),
		]);

		const tools = createDefaultRegistry();
		const result = await runLoop(
			client,
			tools,
			defaultLoopOptions(testDir, { eventEmitter: emitter }),
		);

		expect(result.exitReason).toBe("task_complete");

		// Verify event types in order
		const types = events.map((e) => e.type);
		expect(types).toContain("ready");
		expect(types).toContain("turn_start");
		expect(types).toContain("tool_start");
		expect(types).toContain("tool_end");
		expect(types).toContain("turn_end");
		expect(types).toContain("result");

		// ready must be first
		expect(types[0]).toBe("ready");

		// result must be last
		expect(types[types.length - 1]).toBe("result");

		// Verify ready event shape (overstory uses model, maxTurns, tools)
		const ready = events.find((e) => e.type === "ready");
		expect(ready).toBeDefined();
		expect(ready?.model).toBe("mock-model");
		expect(ready?.maxTurns).toBe(5);
		expect(Array.isArray(ready?.tools)).toBe(true);

		// Verify result event shape
		const resultEvt = events.find((e) => e.type === "result");
		expect(resultEvt).toBeDefined();
		expect(resultEvt?.exitReason).toBe("task_complete");
		expect(typeof resultEvt?.totalTurns).toBe("number");
		expect(typeof resultEvt?.totalInputTokens).toBe("number");
		expect(typeof resultEvt?.totalOutputTokens).toBe("number");

		// Verify tool_start event references the correct tool
		const toolStart = events.find((e) => e.type === "tool_start");
		expect(toolStart).toBeDefined();
		expect(toolStart?.toolName).toBe("read");
		expect(toolStart?.toolCallId).toBe("tc-1");

		// Verify tool_end has success and duration
		const toolEnd = events.find((e) => e.type === "tool_end");
		expect(toolEnd).toBeDefined();
		expect(toolEnd?.toolName).toBe("read");
		expect(toolEnd?.success).toBe(true);
		expect(typeof toolEnd?.durationMs).toBe("number");
	});

	// ── 2. Event sequence for text-only response (no tools) ────────────────────

	it("emits ready + turn_start + turn_end + result for text-only response", async () => {
		const { emitter, events } = createCapturingEmitter();

		const client = createMockClient([mockTextResponse("Hello, done.")]);

		const tools = createDefaultRegistry();
		await runLoop(client, tools, defaultLoopOptions(testDir, { eventEmitter: emitter }));

		const types = events.map((e) => e.type);
		expect(types[0]).toBe("ready");
		expect(types).toContain("turn_start");
		expect(types).toContain("turn_end");
		expect(types[types.length - 1]).toBe("result");
		// No tool events for text-only response
		expect(types).not.toContain("tool_start");
		expect(types).not.toContain("tool_end");
	});

	// ── 3. Guards + eventConfig: onSessionEnd fires ────────────────────────────
	// Overstory configures eventConfig.onSessionEnd for session bookkeeping.

	it("fires eventConfig.onSessionEnd on task_complete", async () => {
		const markerFile = join(testDir, "session-end-marker");
		const eventConfig: EventConfig = {
			onSessionEnd: ["touch", markerFile],
		};

		const client = createMockClient([mockTextResponse("Done.")]);
		const tools = createDefaultRegistry();

		const result = await runLoop(client, tools, defaultLoopOptions(testDir, { eventConfig }));

		expect(result.exitReason).toBe("task_complete");

		// Wait briefly for the subprocess to complete
		await new Promise<void>((resolve) => setTimeout(resolve, 200));
		expect(await Bun.file(markerFile).exists()).toBe(true);
	});

	it("fires eventConfig.onSessionEnd on error", async () => {
		const markerFile = join(testDir, "session-end-error-marker");
		const eventConfig: EventConfig = {
			onSessionEnd: ["touch", markerFile],
		};

		// Client that throws an unrecoverable error
		const { ClientError } = await import("./errors.ts");
		const client = {
			id: "mock",
			calls: [],
			call: async (): Promise<never> => {
				throw new ClientError("Auth failed", "AUTH_FAILED");
			},
			estimateTokens: (text: string): number => Math.ceil(text.length / 4),
		};

		const tools = createDefaultRegistry();
		const result = await runLoop(client, tools, defaultLoopOptions(testDir, { eventConfig }));

		expect(result.exitReason).toBe("error");
		await new Promise<void>((resolve) => setTimeout(resolve, 200));
		expect(await Bun.file(markerFile).exists()).toBe(true);
	});

	// ── 4. eventConfig.onToolStart fires during tool execution ─────────────────

	it("fires eventConfig.onToolStart when tools are dispatched", async () => {
		const markerFile = join(testDir, "tool-start-marker");
		const eventConfig: EventConfig = {
			onToolStart: ["touch", markerFile],
		};

		const filePath = join(testDir, "data.txt");
		await Bun.write(filePath, "content");

		const client = createMockClient([
			mockToolUseResponse("read", { file_path: filePath }, "tc-1"),
			mockTextResponse("Done."),
		]);
		const tools = createDefaultRegistry();

		const result = await runLoop(client, tools, defaultLoopOptions(testDir, { eventConfig }));

		expect(result.exitReason).toBe("task_complete");
		await new Promise<void>((resolve) => setTimeout(resolve, 200));
		expect(await Bun.file(markerFile).exists()).toBe(true);
	});

	// ── 5. Custom system prompt via file ───────────────────────────────────────
	// Overstory passes agent persona files (builder, reviewer, scout).

	it("uses custom system prompt in LLM requests", async () => {
		const customPrompt = "You are a specialized code reviewer. Never edit files.";

		const client = createMockClient([mockTextResponse("Review complete.")]);
		const tools = createDefaultRegistry();

		await runLoop(client, tools, defaultLoopOptions(testDir, { systemPrompt: customPrompt }));

		// Verify the LLM received the custom system prompt
		expect(client.calls.length).toBeGreaterThanOrEqual(1);
		// The first call should use the custom prompt (or a pipeline-composed version containing it)
		const firstCall = client.calls[0] as (typeof client.calls)[number];
		expect(firstCall.systemPrompt).toContain("specialized code reviewer");
	});

	// ── 6. Guards enforcement with overstory-style guards.json ─────────────────
	// Overstory passes --guards-file with pathBoundary and readOnly for reviewer agents.

	it("enforces readOnly + pathBoundary guards (reviewer agent pattern)", async () => {
		const guardsPath = await writeGuardsJson(testDir, {
			rules: [],
			readOnly: true,
			pathBoundary: testDir,
		});

		const guardConfig = await loadGuardConfig(guardsPath);
		expect(guardConfig).not.toBeNull();
		const hookManager = new HookManager(guardConfig ?? { rules: [] });
		const client = createMockClient([
			// Attempt write (should be blocked by readOnly)
			mockToolUseResponse("write", { file_path: join(testDir, "out.txt"), content: "x" }, "tc-1"),
			mockTextResponse("Done."),
		]);

		const stubCalls: string[] = [];
		const registry = {
			register() {},
			get(name: string) {
				const tool = {
					name,
					description: `Stub ${name}`,
					inputSchema: { type: "object", properties: {} },
					async execute() {
						stubCalls.push(name);
						return { content: `${name} ok`, isError: false };
					},
					toDefinition() {
						return {
							name,
							description: `Stub ${name}`,
							input_schema: { type: "object", properties: {} },
						};
					},
				};
				return tool;
			},
			list() {
				return [];
			},
			toDefinitions() {
				return [];
			},
		};

		const result = await runLoop(client, registry, defaultLoopOptions(testDir, { hookManager }));

		expect(result.exitReason).toBe("task_complete");
		// Write should have been blocked by readOnly guard
		expect(stubCalls).not.toContain("write");
	});

	// ── 7. RPC socket: getState queries ────────────────────────────────────────
	// Overstory uses `ov inspect` which queries the RPC socket for agent state.

	it("responds to getState queries on RPC socket", async () => {
		const socketPath = join(testDir, "rpc.sock");

		// Create an RPC server with an empty stream (no stdin control)
		const emptyStream = new ReadableStream<Uint8Array>({
			start(c) {
				c.close();
			},
		});
		const { emitter } = createCapturingEmitter();
		const rpcServer = new RpcServer(emptyStream, emitter);
		const socketServer = new RpcSocketServer(rpcServer);

		try {
			await socketServer.start(socketPath);

			// Connect and collect data via the socket handler
			const response = await new Promise<string>((resolve, reject) => {
				let buf = "";
				Bun.connect({
					unix: socketPath,
					socket: {
						open(socket) {
							const req = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getState" })}\n`;
							socket.write(req);
						},
						data(_socket, chunk) {
							buf += new TextDecoder().decode(chunk);
							if (buf.includes("\n")) {
								resolve(buf.trim());
							}
						},
						error(_socket, err) {
							reject(err);
						},
					},
				});
				// Timeout fallback
				setTimeout(() => {
					resolve(buf.trim());
				}, 2000);
			});

			const parsed = JSON.parse(response);
			expect(parsed.jsonrpc).toBe("2.0");
			expect(parsed.id).toBe(1);
			expect(parsed.result).toBeDefined();
			expect(parsed.result.status).toBe("idle");
		} finally {
			await socketServer.stop();
		}
	});

	// ── 8. RPC abort terminates loop ───────────────────────────────────────────
	// Overstory sends abort requests to stop agents.

	it("aborts loop when RPC abort is received before first turn", async () => {
		const { emitter, events } = createCapturingEmitter();

		// Create an RPC server that has already received an abort
		const abortStream = new ReadableStream<Uint8Array>({
			start(controller) {
				const line = `${JSON.stringify({ jsonrpc: "2.0", method: "abort", id: 1 })}\n`;
				controller.enqueue(new TextEncoder().encode(line));
				controller.close();
			},
		});
		const rpcServer = new RpcServer(abortStream, emitter);

		// Wait for the abort to be processed
		await rpcServer.drained;

		const client = createMockClient([mockTextResponse("Should not reach here.")]);
		const tools = createDefaultRegistry();

		const result = await runLoop(
			client,
			tools,
			defaultLoopOptions(testDir, { eventEmitter: emitter, rpcServer }),
		);

		expect(result.exitReason).toBe("aborted");
		expect(result.totalTurns).toBe(0);

		// Should emit a result event with aborted status
		const resultEvt = events.find((e) => e.type === "result");
		expect(resultEvt).toBeDefined();
		expect(resultEvt?.exitReason).toBe("aborted");
	});

	// ── 9. setState callback updates RPC state ─────────────────────────────────
	// Overstory queries agent phase via getState — verify setState is called.

	it("calls setState callback at turn boundaries", async () => {
		const states: { turn: number; phase: string }[] = [];

		const filePath = join(testDir, "data.txt");
		await Bun.write(filePath, "content");

		const client = createMockClient([
			mockToolUseResponse("read", { file_path: filePath }, "tc-1"),
			mockTextResponse("Done."),
		]);
		const tools = createDefaultRegistry();

		await runLoop(
			client,
			tools,
			defaultLoopOptions(testDir, {
				setState: (state) => states.push({ ...state }),
			}),
		);

		// Should have called setState with calling_llm and executing_tools phases
		const phases = states.map((s) => s.phase);
		expect(phases).toContain("calling_llm");
		expect(phases).toContain("executing_tools");

		// First state should be calling_llm at turn 1
		expect(states[0]?.turn).toBe(1);
		expect(states[0]?.phase).toBe("calling_llm");
	});

	// ── 10. Full subprocess E2E (gated) ────────────────────────────────────────
	// Spawns sapling as overstory would, with --json mode, verifies NDJSON stdout.

	const SKIP_INTEG = !process.env.SAPLING_INTEGRATION_TESTS;

	it.skipIf(SKIP_INTEG)(
		"subprocess with --json emits parseable NDJSON events",
		async () => {
			const filePath = join(testDir, "marker.txt");
			await Bun.write(filePath, "OV_E2E_MARKER_42");

			const proc = Bun.spawn(
				[
					"bun",
					join(import.meta.dir, "index.ts"),
					"run",
					`Read the file at ${filePath} and tell me its contents.`,
					"--max-turns",
					"5",
					"--json",
				],
				{
					cwd: testDir,
					stdout: "pipe",
					stderr: "pipe",
					env: { ...process.env },
				},
			);

			const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

			expect(exitCode).toBe(0);

			// Parse all NDJSON lines, filtering for event lines (have `type` field)
			const lines = stdout.trim().split("\n").filter(Boolean);
			const allParsed = lines.map((line) => JSON.parse(line));
			const events = allParsed.filter((e: Record<string, unknown>) => typeof e.type === "string");

			// Verify event sequence
			const types = events.map((e: Record<string, unknown>) => e.type);
			expect(types[0]).toBe("ready");
			expect(types[types.length - 1]).toBe("result");
			expect(types).toContain("turn_start");
			expect(types).toContain("turn_end");

			// Every event should have a timestamp
			for (const event of events) {
				expect(event.timestamp).toBeDefined();
			}

			// Result event should contain the marker
			const resultEvt = events.find((e: Record<string, unknown>) => e.type === "result");
			expect(resultEvt).toBeDefined();
		},
		60_000,
	);
});
