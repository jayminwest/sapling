/**
 * Integration tests for Sapling.
 *
 * These tests wire together the real tool system, real context manager,
 * and real Anthropic SDK backend to verify end-to-end agent behavior.
 * They run a real LLM (claude-haiku) against real temp directories.
 *
 * WHY GATED: Real API calls have real costs and require ANTHROPIC_API_KEY.
 * Set SAPLING_INTEGRATION_TESTS=1 to run.
 *
 * These tests would have caught every v0.1.x regression: CC/Pi tool-calling
 * failures, responseText bugs, and stdout output issues.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { runCommand } from "./cli.ts";
import { CcClient } from "./client/cc.ts";
import { validateConfig } from "./config.ts";
import { cleanupTempDir, createTempDir } from "./test-helpers.ts";
import type { RunOptions, SaplingConfig } from "./types.ts";

const SKIP = !process.env.SAPLING_INTEGRATION_TESTS;

describe.skipIf(SKIP)("integration tests (SDK backend, real API)", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTempDir();
	});

	afterEach(async () => {
		await cleanupTempDir(testDir);
	});

	/** Build a SaplingConfig targeting the SDK backend with haiku for minimal cost. */
	function makeConfig(cwd: string): SaplingConfig {
		return validateConfig({
			backend: "sdk",
			model: "claude-haiku-4-5-20251001",
			maxTurns: 5,
			cwd,
			quiet: true,
		});
	}

	// -- Test 1: Agent reads a file and reports contents --

	it("reads a file and reports its contents", async () => {
		const filePath = join(testDir, "hello.txt");
		await Bun.write(filePath, "The secret code is ALPHA-7742");

		const config = makeConfig(testDir);
		const opts: RunOptions = { backend: "sdk", quiet: true };

		const result = await runCommand(
			`Read the file at ${filePath} and tell me what the secret code is. ` +
				"Include the exact code in your response.",
			opts,
			config,
		);

		expect(result.exitReason).toBe("task_complete");
		expect(result.responseText).toBeDefined();
		expect(result.responseText).toContain("ALPHA-7742");
	}, 60_000);

	// -- Test 2: Agent creates a file --

	it("creates a file with specified content", async () => {
		const filePath = join(testDir, "output.txt");
		const config = makeConfig(testDir);
		const opts: RunOptions = { backend: "sdk", quiet: true };

		const result = await runCommand(
			`Create a file at ${filePath} with exactly this content: Hello from Sapling`,
			opts,
			config,
		);

		expect(result.exitReason).toBe("task_complete");
		const file = Bun.file(filePath);
		expect(await file.exists()).toBe(true);
		const content = await file.text();
		expect(content).toContain("Hello from Sapling");
	}, 60_000);

	// -- Test 3: Agent runs bash and uses the output --

	it("runs a bash command and includes output in response", async () => {
		const config = makeConfig(testDir);
		const opts: RunOptions = { backend: "sdk", quiet: true };

		const result = await runCommand(
			'Run the command "echo SAPLING_MARKER_12345" and tell me exactly what it output.',
			opts,
			config,
		);

		expect(result.exitReason).toBe("task_complete");
		expect(result.responseText).toBeDefined();
		expect(result.responseText).toContain("SAPLING_MARKER_12345");
	}, 60_000);

	// -- Test 4: responseText appears in stdout via CLI --

	it("prints responseText to stdout when run via CLI", async () => {
		const filePath = join(testDir, "marker.txt");
		await Bun.write(filePath, "UNIQUE_MARKER_XYZ123");

		// Spawn sapling as a subprocess, same as a user would run it
		const proc = Bun.spawn(
			[
				"bun",
				join(import.meta.dir, "index.ts"),
				"run",
				`Read the file at ${filePath} and tell me its exact contents. Include the full text.`,
				"--backend",
				"sdk",
				"--model",
				"claude-haiku-4-5-20251001",
				"--max-turns",
				"5",
				"--quiet",
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
		// The agent final response should appear in stdout
		expect(stdout).toContain("UNIQUE_MARKER_XYZ123");
	}, 60_000);
});

// ─── CC backend smoke tests ───────────────────────────────────────────────────
//
// These tests expose the cc-plain-text-fallback bug: when the CC subprocess is
// called with --tools "" and --json-schema, the claude CLI ignores the schema
// and returns plain text instead of structured tool_calls. This means the CC
// backend is completely non-functional for tool-using tasks.
//
// WHY GATED: Requires a working `claude` CLI installation.
// Set SAPLING_INTEGRATION_TESTS=1 to run.

describe.skipIf(SKIP)("CC backend smoke tests (real claude subprocess)", () => {
	let testDir: string;
	let claudeAvailable = false;

	beforeAll(async () => {
		// Check if claude CLI is installed and responsive
		try {
			const proc = Bun.spawn(["claude", "--version"], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const code = await proc.exited;
			claudeAvailable = code === 0;
		} catch {
			claudeAvailable = false;
		}
	});

	beforeEach(async () => {
		testDir = await createTempDir();
	});

	afterEach(async () => {
		await cleanupTempDir(testDir);
	});

	function makeCcConfig(cwd: string): SaplingConfig {
		return validateConfig({
			backend: "cc",
			model: "claude-haiku-4-5-20251001",
			maxTurns: 3,
			cwd,
			quiet: true,
		});
	}

	// -- Smoke Test 1: CC subprocess returns valid JSON for text prompt --
	// Verifies the CC subprocess can be invoked and returns parseable JSON.
	// No tools — this exercises the basic CC pipeline without --json-schema.

	it("CC subprocess returns structured JSON for text-only prompt", async () => {
		if (!claudeAvailable) {
			console.log("[SKIP] claude CLI not available, skipping CC smoke test");
			return;
		}

		const client = new CcClient({ model: "claude-haiku-4-5-20251001", timeoutMs: 30_000 });
		const result = await client.call({
			systemPrompt: "You are a concise assistant.",
			messages: [{ role: "user", content: "Reply with exactly: PONG" }],
			tools: [],
		});

		expect(result.stopReason).toBe("end_turn");
		expect(result.content.length).toBeGreaterThan(0);
		const text = result.content
			.filter(
				(b): b is Extract<(typeof result.content)[number], { type: "text" }> => b.type === "text",
			)
			.map((b) => b.text)
			.join("");
		expect(text.toUpperCase()).toContain("PONG");
	}, 30_000);

	// -- Smoke Test 2: CC subprocess with --json-schema documents tool_calls behavior --
	// This test exposes whether the CC backend actually returns tool_calls when requested.
	// Known issue: cc-plain-text-fallback — when --tools "" is combined with --json-schema,
	// the claude CLI may ignore the schema and return plain text (stopReason: "end_turn").
	// The test asserts stopReason IS "tool_use" — EXPECTED TO FAIL until the CC backend is fixed.

	it("CC subprocess with --json-schema returns tool_calls (validates tool dispatch)", async () => {
		if (!claudeAvailable) {
			console.log("[SKIP] claude CLI not available, skipping CC smoke test");
			return;
		}

		const client = new CcClient({ model: "claude-haiku-4-5-20251001", timeoutMs: 30_000 });
		const result = await client.call({
			systemPrompt:
				"You are a tool-using assistant. ALWAYS use tools when requested — never respond with text alone.",
			messages: [
				{
					role: "user",
					content: "Use the bash tool with command: echo SMOKE_MARKER_456",
				},
			],
			tools: [
				{
					name: "bash",
					description: "Run a bash command and return its output",
					input_schema: {
						type: "object",
						properties: { command: { type: "string" } },
						required: ["command"],
					},
				},
			],
		});

		// DIAGNOSTIC: log what the CC subprocess actually returned so failures are clear
		const toolBlocks = result.content.filter((b) => b.type === "tool_use");
		const textBlocks = result.content.filter((b) => b.type === "text");
		console.log(
			`[CC smoke] stopReason=${result.stopReason} tool_blocks=${toolBlocks.length} text_blocks=${textBlocks.length}`,
		);

		// This assertion documents the required behavior: CC backend MUST return tool_use.
		// If it fails, the cc-plain-text-fallback bug is active and CC is non-functional.
		expect(result.stopReason).toBe("tool_use");
		expect(toolBlocks.length).toBeGreaterThan(0);
		const toolBlock = toolBlocks[0];
		if (toolBlock?.type === "tool_use") {
			expect(toolBlock.name).toBe("bash");
		}
	}, 30_000);

	// -- Smoke Test 3: Full sp run with CC backend dispatches tools end-to-end --
	// Verifies that runCommand() with CC backend can actually read a file via tool dispatch.
	// This catches the bug where the agent loop never calls tools because CC returns plain text.

	it("sp run with CC backend dispatches read tool to access file contents", async () => {
		if (!claudeAvailable) {
			console.log("[SKIP] claude CLI not available, skipping CC smoke test");
			return;
		}

		const filePath = join(testDir, "secret.txt");
		await Bun.write(filePath, "CC_SECRET_TOKEN_789");

		const config = makeCcConfig(testDir);
		const opts: RunOptions = { backend: "cc", quiet: true };

		const result = await runCommand(
			`Read the file at ${filePath} and tell me the exact token value it contains.`,
			opts,
			config,
		);

		// If CC tool dispatch works, responseText must contain the token
		expect(result.exitReason).toBe("task_complete");
		expect(result.responseText).toBeDefined();
		expect(result.responseText).toContain("CC_SECRET_TOKEN_789");
	}, 60_000);
});
