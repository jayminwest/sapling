import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupTempDir, createTempDir } from "../test-helpers.ts";
import { BashTool } from "./bash.ts";

describe("BashTool", () => {
	let testDir: string;
	let tool: BashTool;

	beforeEach(async () => {
		testDir = await createTempDir();
		tool = new BashTool();
	});

	afterEach(async () => {
		await cleanupTempDir(testDir);
	});

	it("executes a simple command and returns stdout", async () => {
		const result = await tool.execute({ command: "echo hello" }, testDir);
		expect(result.content).toContain("hello");
		expect(result.isError).toBeFalsy();
	});

	it("captures exit code 0 on success", async () => {
		const result = await tool.execute({ command: "true" }, testDir);
		expect(result.content).toContain("Exit code: 0");
		expect(result.isError).toBeFalsy();
	});

	it("marks isError true on non-zero exit", async () => {
		const result = await tool.execute({ command: "false" }, testDir);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("Exit code: 1");
	});

	it("captures stderr", async () => {
		const result = await tool.execute({ command: "echo errout >&2" }, testDir);
		expect(result.content).toContain("errout");
	});

	it("uses cwd as working directory", async () => {
		const result = await tool.execute({ command: "pwd" }, testDir);
		// realpath to handle symlinks on macOS
		const realpathProc = Bun.spawn(["realpath", testDir], { stdout: "pipe" });
		await realpathProc.exited;
		const realTestDir = (await new Response(realpathProc.stdout).text()).trim();
		const realContent = result.content.trim().split("\n").pop()?.trim() ?? "";
		expect(realContent).toBe(realTestDir);
	});

	it("returns metadata with tokensEstimate", async () => {
		const result = await tool.execute({ command: "echo x" }, testDir);
		expect(result.metadata?.tokensEstimate).toBeGreaterThan(0);
	});

	it("truncates output beyond limit", async () => {
		// Generate ~60KB of output
		const result = await tool.execute({ command: "python3 -c \"print('x' * 60000)\"" }, testDir);
		expect(result.content).toContain("[truncated]");
		expect(result.metadata?.truncated).toBe(true);
	});

	it("does not deadlock on output exceeding pipe buffer (~64KB)", async () => {
		// Generate ~200KB of output to exceed typical pipe buffer size
		// Before the fix, this would deadlock because proc.exited was awaited
		// before draining stdout, causing the process to block on a full pipe.
		const result = await tool.execute({ command: "python3 -c \"print('x' * 200000)\"" }, testDir);
		expect(result.isError).toBeFalsy();
		expect(result.metadata?.truncated).toBe(true);
	});

	it("throws on empty command", async () => {
		expect(tool.execute({ command: "" }, testDir)).rejects.toThrow();
	});

	it("toDefinition returns correct structure", () => {
		const def = tool.toDefinition();
		expect(def.name).toBe("bash");
		expect(def.input_schema.required).toContain("command");
	});

	it("dry-run returns description without executing", async () => {
		tool.dryRun = true;
		const result = await tool.execute({ command: "rm -rf /" }, testDir);
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain("[dry-run]");
		expect(result.content).toContain("rm -rf /");
	});

	it("dry-run default is false", () => {
		expect(new BashTool().dryRun).toBe(false);
	});
});
