import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, createTempDir } from "../test-helpers.ts";
import { EditTool } from "./edit.ts";

describe("EditTool", () => {
	let testDir: string;
	let tool: EditTool;

	beforeEach(async () => {
		testDir = await createTempDir();
		tool = new EditTool();
	});

	afterEach(async () => {
		await cleanupTempDir(testDir);
	});

	it("replaces an exact match", async () => {
		const p = join(testDir, "code.ts");
		await Bun.write(p, "const foo = 1;\nconst bar = 2;\n");
		const result = await tool.execute(
			{ file_path: p, old_string: "const foo = 1;", new_string: "const foo = 99;" },
			testDir,
		);
		expect(result.isError).toBeFalsy();
		const content = await Bun.file(p).text();
		expect(content).toContain("const foo = 99;");
		expect(content).toContain("const bar = 2;");
	});

	it("returns isError if old_string not found", async () => {
		const p = join(testDir, "code.ts");
		await Bun.write(p, "hello world");
		const result = await tool.execute(
			{ file_path: p, old_string: "not here", new_string: "replacement" },
			testDir,
		);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("not found");
	});

	it("returns isError if old_string appears more than once", async () => {
		const p = join(testDir, "dup.ts");
		await Bun.write(p, "foo foo");
		const result = await tool.execute(
			{ file_path: p, old_string: "foo", new_string: "bar" },
			testDir,
		);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("more than once");
	});

	it("returns isError for missing file", async () => {
		const result = await tool.execute(
			{ file_path: join(testDir, "ghost.ts"), old_string: "x", new_string: "y" },
			testDir,
		);
		expect(result.isError).toBe(true);
	});

	it("reports line range in confirmation", async () => {
		const p = join(testDir, "lines.ts");
		await Bun.write(p, "line1\nline2\nline3\n");
		const result = await tool.execute(
			{ file_path: p, old_string: "line2", new_string: "REPLACED" },
			testDir,
		);
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain("lines");
	});

	it("handles multiline old_string", async () => {
		const p = join(testDir, "multi.ts");
		await Bun.write(p, "alpha\nbeta\ngamma\n");
		const result = await tool.execute(
			{ file_path: p, old_string: "beta\ngamma", new_string: "REPLACED" },
			testDir,
		);
		expect(result.isError).toBeFalsy();
		const content = await Bun.file(p).text();
		expect(content).toContain("REPLACED");
		expect(content).not.toContain("beta");
	});

	it("toDefinition returns correct structure", () => {
		const def = tool.toDefinition();
		expect(def.name).toBe("edit");
		expect(def.input_schema.required).toContain("file_path");
		expect(def.input_schema.required).toContain("old_string");
		expect(def.input_schema.required).toContain("new_string");
	});
});
