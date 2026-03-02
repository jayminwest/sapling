import type { JsonSchema, ToolDefinition } from "../types.ts";

export type { ToolDefinition };

export interface ToolResult {
	content: string;
	isError?: boolean;
	metadata?: {
		tokensEstimate?: number;
		filePath?: string;
		truncated?: boolean;
	};
}

export interface Tool {
	name: string;
	description: string;
	inputSchema: JsonSchema;
	execute(input: Record<string, unknown>, cwd: string): Promise<ToolResult>;
	toDefinition(): ToolDefinition;
}
