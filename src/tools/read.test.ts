import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, createTempDir } from "../test-helpers.ts";
import { ReadTool } from "./read.ts";

describe("ReadTool", () => {
	let testDir: string;
	let tool: ReadTool;

	beforeEach(async () => {
		testDir = await createTempDir();
		tool = new ReadTool();
	});

	afterEach(async () => {
		await cleanupTempDir(testDir);
	});

	it("reads a file with line numbers", async () => {
		await Bun.write(join(testDir, "test.ts"), "const x = 1;\nconst y = 2;\n");
		const result = await tool.execute({ file_path: join(testDir, "test.ts") }, testDir);
		expect(result.content).toContain("const x = 1;");
		expect(result.content).toContain("const y = 2;");
		expect(result.isError).toBeFalsy();
	});

	it("prefixes each line with its line number", async () => {
		await Bun.write(join(testDir, "f.txt"), "alpha\nbeta\ngamma\n");
		const result = await tool.execute({ file_path: join(testDir, "f.txt") }, testDir);
		expect(result.content).toMatch(/1\s+alpha/);
		expect(result.content).toMatch(/2\s+beta/);
		expect(result.content).toMatch(/3\s+gamma/);
	});

	it("supports offset and limit", async () => {
		const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n");
		await Bun.write(join(testDir, "long.txt"), lines);
		const result = await tool.execute(
			{ file_path: join(testDir, "long.txt"), offset: 3, limit: 2 },
			testDir,
		);
		expect(result.content).toContain("line3");
		expect(result.content).toContain("line4");
		expect(result.content).not.toContain("line1");
		expect(result.content).not.toContain("line5");
	});

	it("returns isError for missing file", async () => {
		const result = await tool.execute({ file_path: join(testDir, "nope.txt") }, testDir);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("not found");
	});

	it("sets truncated flag when partial read", async () => {
		const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n");
		await Bun.write(join(testDir, "ten.txt"), lines);
		const result = await tool.execute({ file_path: join(testDir, "ten.txt"), limit: 3 }, testDir);
		expect(result.metadata?.truncated).toBe(true);
	});

	it("returns metadata filePath", async () => {
		const p = join(testDir, "meta.txt");
		await Bun.write(p, "hello");
		const result = await tool.execute({ file_path: p }, testDir);
		expect(result.metadata?.filePath).toBe(p);
	});

	it("resolves relative file_path against cwd", async () => {
		await Bun.write(join(testDir, "rel.txt"), "relative content");
		const result = await tool.execute({ file_path: "rel.txt" }, testDir);
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain("relative content");
	});

	it("toDefinition returns correct structure", () => {
		const def = tool.toDefinition();
		expect(def.name).toBe("read");
		expect(def.input_schema.required).toContain("file_path");
	});

	it("dry-run returns description without reading", async () => {
		tool.dryRun = true;
		const result = await tool.execute({ file_path: "/etc/passwd" }, testDir);
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain("[dry-run]");
		expect(result.content).toContain("/etc/passwd");
	});

	it("dry-run default is false", () => {
		expect(new ReadTool().dryRun).toBe(false);
	});
});
