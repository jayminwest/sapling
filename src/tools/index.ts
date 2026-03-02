import { ToolError } from "../errors.ts";
import type { ToolDefinition } from "../types.ts";
import { bashTool } from "./bash.ts";
import { editTool } from "./edit.ts";
import { globTool } from "./glob.ts";
import { grepTool } from "./grep.ts";
import { readTool } from "./read.ts";
import type { Tool, ToolResult } from "./types.ts";
import { writeTool } from "./write.ts";

export type { Tool, ToolResult };
export { bashTool, readTool, writeTool, editTool, grepTool, globTool };

export class ToolRegistry {
	private readonly tools: Map<string, Tool>;

	constructor(tools: Tool[]) {
		this.tools = new Map(tools.map((t) => [t.name, t]));
	}

	get(name: string): Tool | undefined {
		return this.tools.get(name);
	}

	has(name: string): boolean {
		return this.tools.has(name);
	}

	list(): Tool[] {
		return Array.from(this.tools.values());
	}

	definitions(): ToolDefinition[] {
		return this.list().map((t) => t.toDefinition());
	}

	async dispatch(name: string, input: Record<string, unknown>, cwd: string): Promise<ToolResult> {
		const tool = this.tools.get(name);
		if (!tool) {
			throw new ToolError(`Unknown tool: ${name}`, "UNKNOWN_TOOL");
		}
		return tool.execute(input, cwd);
	}
}

export function createDefaultRegistry(): ToolRegistry {
	return new ToolRegistry([bashTool, readTool, writeTool, editTool, grepTool, globTool]);
}
