import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { ToolError } from "../errors.ts";
import { cleanupTempDir, createTempDir } from "../test-helpers.ts";
import { createDefaultRegistry, ToolRegistry } from "./index.ts";
import { readTool } from "./read.ts";
import { writeTool } from "./write.ts";

describe("ToolRegistry", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTempDir();
	});

	afterEach(async () => {
		await cleanupTempDir(testDir);
	});

	it("has() returns true for registered tools", () => {
		const registry = new ToolRegistry([readTool, writeTool]);
		expect(registry.has("read")).toBe(true);
		expect(registry.has("write")).toBe(true);
		expect(registry.has("bash")).toBe(false);
	});

	it("get() returns the tool by name", () => {
		const registry = new ToolRegistry([readTool]);
		expect(registry.get("read")).toBe(readTool);
		expect(registry.get("nope")).toBeUndefined();
	});

	it("list() returns all registered tools", () => {
		const registry = new ToolRegistry([readTool, writeTool]);
		expect(registry.list()).toHaveLength(2);
	});

	it("toDefinitions() returns ToolDefinition for each tool", () => {
		const registry = new ToolRegistry([readTool, writeTool]);
		const defs = registry.toDefinitions();
		expect(defs).toHaveLength(2);
		expect(defs.map((d) => d.name)).toContain("read");
		expect(defs.map((d) => d.name)).toContain("write");
	});

	it("dispatch() calls the correct tool", async () => {
		const p = join(testDir, "t.txt");
		await Bun.write(p, "content");
		const registry = new ToolRegistry([readTool]);
		const result = await registry.dispatch("read", { file_path: p }, testDir);
		expect(result.content).toContain("content");
	});

	it("dispatch() throws ToolError for unknown tool", async () => {
		const registry = new ToolRegistry([]);
		expect(registry.dispatch("unknown", {}, testDir)).rejects.toThrow(ToolError);
	});

	it("createDefaultRegistry() includes all 6 tools", () => {
		const registry = createDefaultRegistry();
		const names = registry.list().map((t) => t.name);
		expect(names).toContain("bash");
		expect(names).toContain("read");
		expect(names).toContain("write");
		expect(names).toContain("edit");
		expect(names).toContain("grep");
		expect(names).toContain("glob");
	});
});
