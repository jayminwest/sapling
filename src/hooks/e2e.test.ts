/**
 * End-to-end tests for guards.json enforcement.
 *
 * These tests verify the full enforcement chain:
 *   guards.json → loadGuardConfig() → HookManager → runLoop() → tool blocked
 *
 * Each test writes a real guards.json to disk, loads it via loadGuardConfig(),
 * constructs a HookManager, and runs the agent loop with a mock LLM client.
 * The mock LLM requests tool calls that should be blocked by the guards.
 *
 * Scenarios covered:
 *   1. blockedTools: bash is blocked; LLM tries bash → rejected
 *   2. pathBoundary: write outside boundary → rejected
 *   3. blockedBashPatterns: dangerous bash command → rejected
 *   4. readOnly: write tool blocked → rejected
 *   5. Happy path: all guards pass, loop completes normally
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadGuardConfig } from "../config.ts";
import { runLoop } from "../loop.ts";
import {
	cleanupTempDir,
	createMockClient,
	createTempDir,
	mockTextResponse,
	mockToolUseResponse,
} from "../test-helpers.ts";
import type { GuardConfig, LoopOptions } from "../types.ts";
import { HookManager } from "./manager.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Write a guards.json file and return its path. */
async function writeGuardsJson(dir: string, config: GuardConfig): Promise<string> {
	const path = join(dir, "guards.json");
	await writeFile(path, JSON.stringify(config), "utf-8");
	return path;
}

/** Minimal ToolRegistry with bash and write stubs that record calls. */
function createStubRegistry() {
	const calls: { name: string; input: Record<string, unknown> }[] = [];

	const makeTool = (name: string) => ({
		name,
		description: `Stub ${name}`,
		inputSchema: { type: "object", properties: {} },
		async execute(input: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
			calls.push({ name, input });
			return { content: `${name} executed`, isError: false };
		},
		toDefinition() {
			return {
				name,
				description: `Stub ${name}`,
				input_schema: { type: "object", properties: {} },
			};
		},
	});

	const toolMap = new Map([
		["bash", makeTool("bash")],
		["write", makeTool("write")],
		["read", makeTool("read")],
	]);

	return {
		calls,
		register() {},
		get(n: string) {
			return toolMap.get(n);
		},
		has(n: string) {
			return toolMap.has(n);
		},
		list() {
			return [...toolMap.values()];
		},
		toDefinitions() {
			return [...toolMap.values()].map((t) => t.toDefinition());
		},
	};
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

describe("guards.json end-to-end enforcement", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTempDir();
	});

	afterEach(async () => {
		await cleanupTempDir(testDir);
	});

	// ── 1. blockedTools ───────────────────────────────────────────────────────

	it("blocks a tool listed in blockedTools", async () => {
		const guardsPath = await writeGuardsJson(testDir, {
			rules: [],
			blockedTools: ["bash"],
		});

		const guardConfig = await loadGuardConfig(guardsPath);
		expect(guardConfig).not.toBeNull();
		const hookManager = new HookManager(guardConfig as GuardConfig);

		// LLM tries bash (blocked), then responds done
		const client = createMockClient([
			mockToolUseResponse("bash", { command: "ls -la" }, "tc1"),
			mockTextResponse("done"),
		]);
		const registry = createStubRegistry();

		const result = await runLoop(client, registry, defaultLoopOptions(testDir, { hookManager }));

		expect(result.exitReason).toBe("task_complete");
		// bash was intercepted by the guard — never reached the stub's execute()
		expect(registry.calls.find((c) => c.name === "bash")).toBeUndefined();
	});

	// ── 2. pathBoundary ───────────────────────────────────────────────────────

	it("blocks a write to a path outside pathBoundary", async () => {
		const guardsPath = await writeGuardsJson(testDir, {
			rules: [],
			pathBoundary: testDir,
		});

		const guardConfig = await loadGuardConfig(guardsPath);
		expect(guardConfig).not.toBeNull();
		const hookManager = new HookManager(guardConfig as GuardConfig);

		// LLM tries to write to a path outside the boundary
		const outsidePath = "/tmp/sapling-guard-test-outside.txt";
		const client = createMockClient([
			mockToolUseResponse("write", { file_path: outsidePath, content: "evil" }, "tc1"),
			mockTextResponse("done"),
		]);
		const registry = createStubRegistry();

		const result = await runLoop(client, registry, defaultLoopOptions(testDir, { hookManager }));

		expect(result.exitReason).toBe("task_complete");
		// write tool should have been blocked before execution
		expect(registry.calls.find((c) => c.name === "write")).toBeUndefined();
	});

	// ── 3. pathBoundary allows writes inside the boundary ────────────────────

	it("allows a write inside pathBoundary", async () => {
		const guardsPath = await writeGuardsJson(testDir, {
			rules: [],
			pathBoundary: testDir,
		});

		const guardConfig = await loadGuardConfig(guardsPath);
		expect(guardConfig).not.toBeNull();
		const hookManager = new HookManager(guardConfig as GuardConfig);

		// LLM writes inside the boundary — should pass
		const insidePath = join(testDir, "output.txt");
		const client = createMockClient([
			mockToolUseResponse("write", { file_path: insidePath, content: "ok" }, "tc1"),
			mockTextResponse("done"),
		]);
		const registry = createStubRegistry();

		const result = await runLoop(client, registry, defaultLoopOptions(testDir, { hookManager }));

		expect(result.exitReason).toBe("task_complete");
		// write reached the stub (was not blocked)
		expect(registry.calls.find((c) => c.name === "write")).toBeDefined();
	});

	// ── 4. blockedBashPatterns ────────────────────────────────────────────────

	it("blocks a bash command matching blockedBashPatterns", async () => {
		const guardsPath = await writeGuardsJson(testDir, {
			rules: [],
			blockedBashPatterns: ["rm\\s+-rf"],
		});

		const guardConfig = await loadGuardConfig(guardsPath);
		expect(guardConfig).not.toBeNull();
		const hookManager = new HookManager(guardConfig as GuardConfig);

		const client = createMockClient([
			mockToolUseResponse("bash", { command: "rm -rf /" }, "tc1"),
			mockTextResponse("done"),
		]);
		const registry = createStubRegistry();

		const result = await runLoop(client, registry, defaultLoopOptions(testDir, { hookManager }));

		expect(result.exitReason).toBe("task_complete");
		expect(registry.calls.find((c) => c.name === "bash")).toBeUndefined();
	});

	// ── 5. readOnly ───────────────────────────────────────────────────────────

	it("blocks write tool in readOnly mode", async () => {
		const guardsPath = await writeGuardsJson(testDir, {
			rules: [],
			readOnly: true,
		});

		const guardConfig = await loadGuardConfig(guardsPath);
		expect(guardConfig).not.toBeNull();
		const hookManager = new HookManager(guardConfig as GuardConfig);

		const filePath = join(testDir, "out.txt");
		const client = createMockClient([
			mockToolUseResponse("write", { file_path: filePath, content: "hello" }, "tc1"),
			mockTextResponse("done"),
		]);
		const registry = createStubRegistry();

		const result = await runLoop(client, registry, defaultLoopOptions(testDir, { hookManager }));

		expect(result.exitReason).toBe("task_complete");
		expect(registry.calls.find((c) => c.name === "write")).toBeUndefined();
	});

	// ── 6. readOnly allows reads ──────────────────────────────────────────────

	it("allows read tool in readOnly mode", async () => {
		const guardsPath = await writeGuardsJson(testDir, {
			rules: [],
			readOnly: true,
		});

		const guardConfig = await loadGuardConfig(guardsPath);
		expect(guardConfig).not.toBeNull();
		const hookManager = new HookManager(guardConfig as GuardConfig);

		const filePath = join(testDir, "file.txt");
		const client = createMockClient([
			mockToolUseResponse("read", { file_path: filePath }, "tc1"),
			mockTextResponse("done"),
		]);
		const registry = createStubRegistry();

		const result = await runLoop(client, registry, defaultLoopOptions(testDir, { hookManager }));

		expect(result.exitReason).toBe("task_complete");
		// read should NOT be blocked in readOnly mode
		expect(registry.calls.find((c) => c.name === "read")).toBeDefined();
	});

	// ── 7. loadGuardConfig returns null for missing file ─────────────────────

	it("loadGuardConfig returns null when file does not exist", async () => {
		const missingPath = join(testDir, "nonexistent-guards.json");
		const config = await loadGuardConfig(missingPath);
		expect(config).toBeNull();
	});

	// ── 8. loadGuardConfig parses rules array ─────────────────────────────────

	it("loadGuardConfig parses guards.json with rules array", async () => {
		const guardsPath = await writeGuardsJson(testDir, {
			rules: [{ event: "pre_tool_call", tool: "bash", action: "block", reason: "no bash" }],
			blockedTools: ["write"],
		});

		const config = await loadGuardConfig(guardsPath);
		expect(config).not.toBeNull();
		expect((config as GuardConfig).rules).toHaveLength(1);
		expect((config as GuardConfig).blockedTools).toEqual(["write"]);
	});

	// ── 9. HookManager preToolCall blocks via rules array in guards.json ──────

	it("blocks tool via rules array loaded from guards.json", async () => {
		const guardsPath = await writeGuardsJson(testDir, {
			rules: [{ event: "pre_tool_call", tool: "bash", action: "block", reason: "no bash allowed" }],
		});

		const guardConfig = await loadGuardConfig(guardsPath);
		expect(guardConfig).not.toBeNull();
		const hookManager = new HookManager(guardConfig as GuardConfig);

		const client = createMockClient([
			mockToolUseResponse("bash", { command: "echo hi" }, "tc1"),
			mockTextResponse("done"),
		]);
		const registry = createStubRegistry();

		const result = await runLoop(client, registry, defaultLoopOptions(testDir, { hookManager }));

		expect(result.exitReason).toBe("task_complete");
		expect(registry.calls.find((c) => c.name === "bash")).toBeUndefined();
	});
});
