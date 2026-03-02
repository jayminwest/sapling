export type ContentBlock =
	| { type: "text"; text: string }
	| { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

export type Message =
	| { role: "user"; content: string | ContentBlock[] }
	| { role: "assistant"; content: ContentBlock[] };

export interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheCreationTokens?: number;
}

export interface LlmRequest {
	systemPrompt: string;
	messages: Message[];
	tools: ToolDefinition[];
	model?: string;
	maxTokens?: number;
}

export interface LlmResponse {
	content: ContentBlock[];
	usage: TokenUsage;
	model: string;
	stopReason: "end_turn" | "tool_use" | "max_tokens";
}

export interface LlmClient {
	readonly id: string;
	call(request: LlmRequest): Promise<LlmResponse>;
	estimateTokens(text: string): number;
}

export interface ToolDefinition {
	name: string;
	description: string;
	input_schema: JsonSchema;
}

export interface JsonSchema {
	type: string;
	properties?: Record<string, JsonSchemaProperty>;
	required?: string[];
}

export interface JsonSchemaProperty {
	type: string;
	description?: string;
	enum?: string[];
	items?: JsonSchemaProperty;
}

export interface LoopOptions {
	task: string;
	systemPrompt: string;
	model: string;
	maxTurns?: number;
	cwd: string;
}

export interface LoopResult {
	exitReason: "task_complete" | "max_turns" | "error" | "aborted";
	totalTurns: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	error?: string;
}
