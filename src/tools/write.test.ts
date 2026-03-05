import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, createTempDir } from "../test-helpers.ts";
import { WriteTool } from "./write.ts";

describe("WriteTool", () => {
	let testDir: string;
	let tool: WriteTool;

	beforeEach(async () => {
		testDir = await createTempDir();
		tool = new WriteTool();
	});

	afterEach(async () => {
		await cleanupTempDir(testDir);
	});

	it("creates a new file with content", async () => {
		const p = join(testDir, "new.txt");
		const result = await tool.execute({ file_path: p, content: "hello world" }, testDir);
		expect(result.isError).toBeFalsy();
		expect(await Bun.file(p).text()).toBe("hello world");
	});

	it("overwrites an existing file", async () => {
		const p = join(testDir, "existing.txt");
		await Bun.write(p, "old content");
		await tool.execute({ file_path: p, content: "new content" }, testDir);
		expect(await Bun.file(p).text()).toBe("new content");
	});

	it("creates parent directories if needed", async () => {
		const p = join(testDir, "deep", "nested", "file.txt");
		const result = await tool.execute({ file_path: p, content: "nested" }, testDir);
		expect(result.isError).toBeFalsy();
		expect(await Bun.file(p).text()).toBe("nested");
	});

	it("returns byte count in confirmation", async () => {
		const p = join(testDir, "size.txt");
		const result = await tool.execute({ file_path: p, content: "12345" }, testDir);
		expect(result.content).toContain("5 bytes");
	});

	it("returns metadata filePath", async () => {
		const p = join(testDir, "meta.txt");
		const result = await tool.execute({ file_path: p, content: "x" }, testDir);
		expect(result.metadata?.filePath).toBe(p);
	});

	it("resolves relative file_path against cwd", async () => {
		const result = await tool.execute({ file_path: "relative.txt", content: "relative" }, testDir);
		expect(result.isError).toBeFalsy();
		expect(await Bun.file(join(testDir, "relative.txt")).text()).toBe("relative");
	});

	it("throws on missing file_path", async () => {
		expect(tool.execute({ file_path: "", content: "x" }, testDir)).rejects.toThrow();
	});

	it("toDefinition returns correct structure", () => {
		const def = tool.toDefinition();
		expect(def.name).toBe("write");
		expect(def.input_schema.required).toContain("file_path");
		expect(def.input_schema.required).toContain("content");
	});

	it("dry-run returns description without writing", async () => {
		const p = join(testDir, "nodisk.txt");
		tool.dryRun = true;
		const result = await tool.execute({ file_path: p, content: "secret" }, testDir);
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain("[dry-run]");
		expect(result.content).toContain("nodisk.txt");
		expect(await Bun.file(p).exists()).toBe(false);
	});

	it("dry-run default is false", () => {
		expect(new WriteTool().dryRun).toBe(false);
	});
});
