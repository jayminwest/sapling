import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, createTempDir } from "../test-helpers.ts";
import { GrepTool } from "./grep.ts";

describe("GrepTool", () => {
	let testDir: string;
	let tool: GrepTool;

	beforeEach(async () => {
		testDir = await createTempDir();
		tool = new GrepTool();
		// Create test files
		await Bun.write(join(testDir, "a.ts"), "const foo = 1;\nconst bar = 2;\n");
		await Bun.write(join(testDir, "b.ts"), "function foo() {}\n");
		await Bun.write(join(testDir, "c.txt"), "irrelevant content\n");
	});

	afterEach(async () => {
		await cleanupTempDir(testDir);
	});

	it("finds matches in files_with_matches mode (default)", async () => {
		const result = await tool.execute({ pattern: "foo" }, testDir);
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain("a.ts");
		expect(result.content).toContain("b.ts");
		expect(result.content).not.toContain("c.txt");
	});

	it("returns content in content mode", async () => {
		const result = await tool.execute({ pattern: "foo", output_mode: "content" }, testDir);
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain("const foo = 1;");
	});

	it("returns counts in count mode", async () => {
		const result = await tool.execute({ pattern: "foo", output_mode: "count" }, testDir);
		expect(result.isError).toBeFalsy();
		// rg --count output is like "file:count"
		expect(result.content).toMatch(/\d+/);
	});

	it("returns 'No matches found' when no matches", async () => {
		const result = await tool.execute({ pattern: "ZZZNOMATCH" }, testDir);
		expect(result.content).toBe("No matches found");
	});

	it("filters by glob pattern", async () => {
		const result = await tool.execute({ pattern: "foo", glob: "*.ts" }, testDir);
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain(".ts");
	});

	it("searches in a specific path", async () => {
		const result = await tool.execute({ pattern: "foo", path: join(testDir, "a.ts") }, testDir);
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain("a.ts");
	});

	it("toDefinition returns correct structure", () => {
		const def = tool.toDefinition();
		expect(def.name).toBe("grep");
		expect(def.input_schema.required).toContain("pattern");
	});

	it("handles large output without pipe deadlock", async () => {
		// Write files with many matching lines to exceed DEFAULT_MATCH_LIMIT (100)
		// Each file has 10 lines containing "matchme"; 20 files = 200 lines > 100 limit
		const lines = `${Array.from({ length: 10 }, (_, i) => `matchme line ${i}`).join("\n")}\n`;
		for (let i = 0; i < 20; i++) {
			await Bun.write(join(testDir, `large_${i}.txt`), lines);
		}
		// Should not deadlock; result is truncated at DEFAULT_MATCH_LIMIT lines
		const result = await tool.execute({ pattern: "matchme", output_mode: "content" }, testDir);
		expect(result.isError).toBeFalsy();
		expect(result.metadata?.truncated).toBe(true);
	});

	it("dry-run returns description without searching", async () => {
		tool.dryRun = true;
		const result = await tool.execute({ pattern: "findme" }, testDir);
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain("[dry-run]");
		expect(result.content).toContain("findme");
	});

	it("dry-run default is false", () => {
		expect(new GrepTool().dryRun).toBe(false);
	});
});
