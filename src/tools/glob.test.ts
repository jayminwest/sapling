import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, createTempDir } from "../test-helpers.ts";
import { GlobTool } from "./glob.ts";

describe("GlobTool", () => {
	let testDir: string;
	let tool: GlobTool;

	beforeEach(async () => {
		testDir = await createTempDir();
		tool = new GlobTool();
		// Create test files
		await Bun.write(join(testDir, "a.ts"), "a");
		await Bun.write(join(testDir, "b.ts"), "b");
		await Bun.write(join(testDir, "c.txt"), "c");
		await mkdir(join(testDir, "sub"));
		await Bun.write(join(testDir, "sub", "d.ts"), "d");
	});

	afterEach(async () => {
		await cleanupTempDir(testDir);
	});

	it("matches files by pattern", async () => {
		const result = await tool.execute({ pattern: "*.ts" }, testDir);
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain("a.ts");
		expect(result.content).toContain("b.ts");
		expect(result.content).not.toContain("c.txt");
	});

	it("matches recursively with **", async () => {
		const result = await tool.execute({ pattern: "**/*.ts" }, testDir);
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain("a.ts");
		expect(result.content).toContain("sub/d.ts");
	});

	it("returns 'No files matched' when no match", async () => {
		const result = await tool.execute({ pattern: "*.go" }, testDir);
		expect(result.content).toBe("No files matched");
	});

	it("uses provided path instead of cwd", async () => {
		const result = await tool.execute({ pattern: "*.ts", path: join(testDir, "sub") }, testDir);
		expect(result.content).toContain("d.ts");
		expect(result.content).not.toContain("a.ts");
	});

	it("returns metadata with tokensEstimate", async () => {
		const result = await tool.execute({ pattern: "**/*.ts" }, testDir);
		expect(result.metadata?.tokensEstimate).toBeGreaterThan(0);
	});

	it("toDefinition returns correct structure", () => {
		const def = tool.toDefinition();
		expect(def.name).toBe("glob");
		expect(def.input_schema.required).toContain("pattern");
	});

	it("dry-run returns description without scanning", async () => {
		tool.dryRun = true;
		const result = await tool.execute({ pattern: "**/*.ts" }, testDir);
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain("[dry-run]");
		expect(result.content).toContain("**/*.ts");
	});

	it("dry-run default is false", () => {
		expect(new GlobTool().dryRun).toBe(false);
	});
});
