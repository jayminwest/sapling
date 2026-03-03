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

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { runCommand } from "./cli.ts";
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
