import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, createTempDir } from "../test-helpers.ts";
import { runInit } from "./init.ts";

const CLI = new URL("../index.ts", import.meta.url).pathname;

async function runCli(
	args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", "run", CLI, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

describe("runInit()", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await createTempDir();
	});

	afterEach(async () => {
		await cleanupTempDir(tmpDir);
	});

	test("creates .sapling/ directory with expected files", async () => {
		await runInit(tmpDir, false);

		expect(existsSync(join(tmpDir, ".sapling"))).toBe(true);
		expect(existsSync(join(tmpDir, ".sapling", "config.yaml"))).toBe(true);
		expect(existsSync(join(tmpDir, ".sapling", "guards.json"))).toBe(true);
		expect(existsSync(join(tmpDir, ".sapling", "session.jsonl"))).toBe(true);
		expect(existsSync(join(tmpDir, ".sapling", ".gitignore"))).toBe(true);
	});

	test("config.yaml contains project name and defaults", async () => {
		await runInit(tmpDir, false);
		const config = readFileSync(join(tmpDir, ".sapling", "config.yaml"), "utf8");
		expect(config).toContain("model: MiniMax-M2.5");
		expect(config).toContain("max_turns: 200");
		expect(config).toContain("context_pipeline: v1");
	});

	test("guards.json is valid JSON with version and empty rules", async () => {
		await runInit(tmpDir, false);
		const raw = readFileSync(join(tmpDir, ".sapling", "guards.json"), "utf8");
		const parsed = JSON.parse(raw) as { version: number; rules: unknown[] };
		expect(parsed.version).toBe(1);
		expect(Array.isArray(parsed.rules)).toBe(true);
		expect(parsed.rules).toHaveLength(0);
	});

	test("session.jsonl is empty", async () => {
		await runInit(tmpDir, false);
		const content = readFileSync(join(tmpDir, ".sapling", "session.jsonl"), "utf8");
		expect(content).toBe("");
	});

	test(".gitignore ignores lock files", async () => {
		await runInit(tmpDir, false);
		const content = readFileSync(join(tmpDir, ".sapling", ".gitignore"), "utf8");
		expect(content).toContain("*.lock");
	});

	test("creates .gitattributes with merge=union entry", async () => {
		await runInit(tmpDir, false);
		const attrs = readFileSync(join(tmpDir, ".gitattributes"), "utf8");
		expect(attrs).toContain(".sapling/session.jsonl merge=union");
	});

	test("appends to existing .gitattributes without duplicating", async () => {
		const attrsPath = join(tmpDir, ".gitattributes");
		const existing = "*.lock binary\n";
		Bun.write(attrsPath, existing);

		await runInit(tmpDir, false);
		const attrs = readFileSync(attrsPath, "utf8");
		expect(attrs).toContain("*.lock binary");
		expect(attrs).toContain(".sapling/session.jsonl merge=union");

		// Run again — should not duplicate the entry
		await runInit(tmpDir, false);
		const attrs2 = readFileSync(attrsPath, "utf8");
		const count = (attrs2.match(/\.sapling\/session\.jsonl/g) ?? []).length;
		expect(count).toBe(1);
	});

	test("already initialized: skips re-initialization", async () => {
		await runInit(tmpDir, false);
		// Modify config to verify it's not overwritten
		Bun.write(join(tmpDir, ".sapling", "config.yaml"), "custom: true\n");
		await runInit(tmpDir, false);
		const config = readFileSync(join(tmpDir, ".sapling", "config.yaml"), "utf8");
		expect(config).toBe("custom: true\n");
	});

	test("--json mode returns structured output on success", async () => {
		const { stdout } = await runCli(["init", "--cwd", tmpDir, "--json"]);
		const parsed = JSON.parse(stdout.trim()) as {
			success: boolean;
			command: string;
			initialized: boolean;
		};
		expect(parsed.success).toBe(true);
		expect(parsed.command).toBe("init");
		expect(parsed.initialized).toBe(true);
	});

	test("--json mode reports already-initialized", async () => {
		await runInit(tmpDir, false);
		const { stdout } = await runCli(["init", "--cwd", tmpDir, "--json"]);
		const parsed = JSON.parse(stdout.trim()) as { initialized: boolean };
		expect(parsed.initialized).toBe(false);
	});
});

describe("init CLI command", () => {
	test("init --help shows description", async () => {
		const { stdout } = await runCli(["init", "--help"]);
		expect(stdout).toContain("init");
		expect(stdout).toContain(".sapling/");
	});
});
