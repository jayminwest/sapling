import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, createTempDir } from "../test-helpers.ts";
import { runConfigGet, runConfigInit, runConfigList, runConfigSet } from "./config.ts";

const CLI = new URL("../index.ts", import.meta.url).pathname;

async function runCli(
	args: string[],
	env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", "run", CLI, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...env },
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

describe("runConfigSet() + runConfigGet()", () => {
	let tmpDir: string;
	let capturedStdout: string;
	let origWrite: typeof process.stdout.write;

	beforeEach(async () => {
		tmpDir = await createTempDir();
		capturedStdout = "";
		origWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = (chunk: unknown) => {
			capturedStdout += String(chunk);
			return true;
		};
	});

	afterEach(async () => {
		process.stdout.write = origWrite;
		await cleanupTempDir(tmpDir);
	});

	test("set creates .sapling/config.yaml if not present", () => {
		runConfigSet("model", "claude-haiku-4-5", { cwd: tmpDir });
		expect(existsSync(join(tmpDir, ".sapling", "config.yaml"))).toBe(true);
	});

	test("set writes yaml key to project config", () => {
		runConfigSet("model", "claude-opus-4-6", { cwd: tmpDir });
		const raw = readFileSync(join(tmpDir, ".sapling", "config.yaml"), "utf-8");
		expect(raw).toContain("model: claude-opus-4-6");
	});

	test("set accepts snake_case key alias", () => {
		runConfigSet("max_turns", "50", { cwd: tmpDir });
		const raw = readFileSync(join(tmpDir, ".sapling", "config.yaml"), "utf-8");
		expect(raw).toContain("max_turns: 50");
	});

	test("set accepts camelCase key alias", () => {
		runConfigSet("maxTurns", "75", { cwd: tmpDir });
		const raw = readFileSync(join(tmpDir, ".sapling", "config.yaml"), "utf-8");
		expect(raw).toContain("max_turns: 75");
	});

	test("set updates existing key in-place", () => {
		mkdirSync(join(tmpDir, ".sapling"), { recursive: true });
		writeFileSync(join(tmpDir, ".sapling", "config.yaml"), "model: old-model\nbackend: sdk\n");
		runConfigSet("model", "new-model", { cwd: tmpDir });
		const raw = readFileSync(join(tmpDir, ".sapling", "config.yaml"), "utf-8");
		expect(raw).toContain("model: new-model");
		expect(raw).toContain("backend: sdk");
		expect(raw).not.toContain("model: old-model");
	});

	test("set rejects unknown key", () => {
		const origExit = process.exitCode;
		runConfigSet("unknownKey", "val", { cwd: tmpDir });
		expect(process.exitCode).toBe(1);
		process.exitCode = origExit as number | undefined;
	});

	test("get returns project value with source=project", () => {
		mkdirSync(join(tmpDir, ".sapling"), { recursive: true });
		writeFileSync(join(tmpDir, ".sapling", "config.yaml"), "model: test-model\n");
		runConfigGet("model", tmpDir);
		expect(capturedStdout).toContain("test-model");
		expect(capturedStdout).toContain("project");
	});

	test("get returns default value with source=default when no config", () => {
		const origEnv = process.env.SAPLING_MODEL;
		delete process.env.SAPLING_MODEL;
		try {
			runConfigGet("model", tmpDir);
			expect(capturedStdout).toContain("claude-sonnet-4-6");
			expect(capturedStdout).toContain("default");
		} finally {
			if (origEnv !== undefined) process.env.SAPLING_MODEL = origEnv;
		}
	});

	test("get reports env source when env var is set", () => {
		const origEnv = process.env.SAPLING_MODEL;
		process.env.SAPLING_MODEL = "env-model";
		try {
			runConfigGet("model", tmpDir);
			expect(capturedStdout).toContain("env-model");
			expect(capturedStdout).toContain("env");
		} finally {
			if (origEnv === undefined) {
				delete process.env.SAPLING_MODEL;
			} else {
				process.env.SAPLING_MODEL = origEnv;
			}
		}
	});

	test("get returns project value over env (project has higher precedence)", () => {
		mkdirSync(join(tmpDir, ".sapling"), { recursive: true });
		writeFileSync(join(tmpDir, ".sapling", "config.yaml"), "model: project-model\n");
		const origEnv = process.env.SAPLING_MODEL;
		process.env.SAPLING_MODEL = "env-should-be-overridden";
		try {
			runConfigGet("model", tmpDir);
			expect(capturedStdout).toContain("project-model");
			expect(capturedStdout).toContain("project");
		} finally {
			if (origEnv === undefined) {
				delete process.env.SAPLING_MODEL;
			} else {
				process.env.SAPLING_MODEL = origEnv;
			}
		}
	});

	test("get rejects unknown key", () => {
		const origExit = process.exitCode;
		runConfigGet("unknownKey", tmpDir);
		expect(process.exitCode).toBe(1);
		process.exitCode = origExit;
	});

	test("get accepts snake_case alias", () => {
		mkdirSync(join(tmpDir, ".sapling"), { recursive: true });
		writeFileSync(join(tmpDir, ".sapling", "config.yaml"), "max_turns: 42\n");
		runConfigGet("max_turns", tmpDir);
		expect(capturedStdout).toContain("42");
	});

	test("get accepts camelCase alias", () => {
		mkdirSync(join(tmpDir, ".sapling"), { recursive: true });
		writeFileSync(join(tmpDir, ".sapling", "config.yaml"), "max_turns: 99\n");
		runConfigGet("maxTurns", tmpDir);
		expect(capturedStdout).toContain("99");
	});
});

describe("runConfigList()", () => {
	let tmpDir: string;
	let capturedStdout: string;
	let origWrite: typeof process.stdout.write;

	beforeEach(async () => {
		tmpDir = await createTempDir();
		capturedStdout = "";
		origWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = (chunk: unknown) => {
			capturedStdout += String(chunk);
			return true;
		};
	});

	afterEach(async () => {
		process.stdout.write = origWrite;
		await cleanupTempDir(tmpDir);
	});

	test("lists all supported keys", () => {
		runConfigList(tmpDir);
		expect(capturedStdout).toContain("model");
		expect(capturedStdout).toContain("backend");
		expect(capturedStdout).toContain("maxTurns");
		expect(capturedStdout).toContain("contextWindow");
		expect(capturedStdout).toContain("baseUrl");
	});

	test("shows source labels for each key", () => {
		runConfigList(tmpDir);
		// All defaults — should contain "default" for each key
		const lines = capturedStdout.split("\n").filter((l) => l.trim());
		expect(lines.length).toBeGreaterThanOrEqual(5);
	});

	test("shows project source for keys from project config", () => {
		mkdirSync(join(tmpDir, ".sapling"), { recursive: true });
		writeFileSync(join(tmpDir, ".sapling", "config.yaml"), "model: proj-model\n");
		runConfigList(tmpDir);
		expect(capturedStdout).toContain("proj-model");
		expect(capturedStdout).toContain("project");
	});
});

describe("runConfigInit()", () => {
	let tmpDir: string;
	let capturedStdout: string;
	let origWrite: typeof process.stdout.write;

	beforeEach(async () => {
		tmpDir = await createTempDir();
		capturedStdout = "";
		origWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = (chunk: unknown) => {
			capturedStdout += String(chunk);
			return true;
		};
	});

	afterEach(async () => {
		process.stdout.write = origWrite;
		await cleanupTempDir(tmpDir);
	});

	test("creates .sapling/config.yaml with defaults", () => {
		runConfigInit(tmpDir);
		const configPath = join(tmpDir, ".sapling", "config.yaml");
		expect(existsSync(configPath)).toBe(true);
		const raw = readFileSync(configPath, "utf-8");
		expect(raw).toContain("model:");
		expect(raw).toContain("backend:");
		expect(raw).toContain("max_turns:");
	});

	test("skips if config.yaml already exists", () => {
		mkdirSync(join(tmpDir, ".sapling"), { recursive: true });
		writeFileSync(join(tmpDir, ".sapling", "config.yaml"), "custom: true\n");
		runConfigInit(tmpDir);
		const raw = readFileSync(join(tmpDir, ".sapling", "config.yaml"), "utf-8");
		expect(raw).toBe("custom: true\n");
		expect(capturedStdout).toContain("Already initialized");
	});

	test("creates .sapling/ directory if missing", () => {
		expect(existsSync(join(tmpDir, ".sapling"))).toBe(false);
		runConfigInit(tmpDir);
		expect(existsSync(join(tmpDir, ".sapling"))).toBe(true);
	});
});

describe("config CLI command", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await createTempDir();
	});

	afterEach(async () => {
		await cleanupTempDir(tmpDir);
	});

	test("config --help shows subcommands", async () => {
		const { stdout } = await runCli(["config", "--help"]);
		expect(stdout).toContain("get");
		expect(stdout).toContain("set");
		expect(stdout).toContain("list");
		expect(stdout).toContain("init");
	});

	test("config get --help shows description", async () => {
		const { stdout } = await runCli(["config", "get", "--help"]);
		expect(stdout).toContain("key");
	});

	test("config set then get round-trips project value", async () => {
		await runCli(["config", "set", "model", "claude-haiku-4-5", "--cwd", tmpDir]);
		const { stdout } = await runCli(["config", "get", "model", "--cwd", tmpDir]);
		expect(stdout).toContain("claude-haiku-4-5");
		expect(stdout).toContain("project");
	});

	test("config list shows all keys", async () => {
		const { stdout } = await runCli(["config", "list", "--cwd", tmpDir]);
		expect(stdout).toContain("model");
		expect(stdout).toContain("backend");
		expect(stdout).toContain("maxTurns");
	});

	test("config get unknown key exits with code 1", async () => {
		const { exitCode, stderr } = await runCli(["config", "get", "badKey", "--cwd", tmpDir]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("unknown config key");
	});

	test("config set unknown key exits with code 1", async () => {
		const { exitCode, stderr } = await runCli(["config", "set", "badKey", "val", "--cwd", tmpDir]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("unknown config key");
	});

	test("config init creates config.yaml", async () => {
		const { stdout, exitCode } = await runCli(["config", "init", "--cwd", tmpDir]);
		expect(exitCode).toBe(0);
		expect(existsSync(join(tmpDir, ".sapling", "config.yaml"))).toBe(true);
		expect(stdout).toContain("Created");
	});

	test("config set maxTurns with camelCase key", async () => {
		await runCli(["config", "set", "maxTurns", "100", "--cwd", tmpDir]);
		const { stdout } = await runCli(["config", "get", "maxTurns", "--cwd", tmpDir]);
		expect(stdout).toContain("100");
	});

	test("config get returns env value with env source", async () => {
		const { stdout } = await runCli(["config", "get", "model", "--cwd", tmpDir], {
			SAPLING_MODEL: "env-test-model",
		});
		expect(stdout).toContain("env-test-model");
		expect(stdout).toContain("env");
	});
});
