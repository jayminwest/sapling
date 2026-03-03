export type ContentBlock =
	| { type: "text"; text: string }
	| { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

/**
 * A tool_result content block (Anthropic API format).
 * Appears in user-turn messages to return tool execution results.
 * Not part of ContentBlock (which covers LLM output only) because including it
 * would require type narrowing in all existing ContentBlock consumers.
 */
export type ToolResultBlock = {
	type: "tool_result";
	tool_use_id: string;
	content: string;
	is_error?: boolean;
};

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
	input_schema: Record<string, unknown>;
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
	responseText?: string;
}

// ─── Config Types ─────────────────────────────────────────────────────────────

export type LlmBackend = "cc" | "sdk";

export interface ContextBudget {
	windowSize: number;
	allocations: {
		systemPrompt: number;
		archiveSummary: number;
		recentHistory: number;
		currentTurn: number;
		headroom: number;
	};
}

export interface SaplingConfig {
	model: string;
	backend: LlmBackend;
	maxTurns: number;
	cwd: string;
	verbose: boolean;
	quiet: boolean;
	json: boolean;
	contextWindow: number;
	contextBudget: ContextBudget;
}

export interface RunOptions {
	systemPromptFile?: string;
	model?: string;
	backend?: LlmBackend;
	maxTurns?: number;
	verbose?: boolean;
	quiet?: boolean;
	json?: boolean;
}

// ─── Context Types ────────────────────────────────────────────────────────────

export interface BudgetEntry {
	used: number;
	budget: number;
}

export interface BudgetUtilization {
	systemPrompt: BudgetEntry;
	archiveSummary: BudgetEntry;
	recentHistory: BudgetEntry;
	currentTurn: BudgetEntry;
	headroom: BudgetEntry;
	total: BudgetEntry;
}

export interface ContextArchive {
	workSummary: string;
	decisions: string[];
	modifiedFiles: Map<string, string>;
	fileHashes: Map<string, string>;
	resolvedErrors: string[];
}

export interface ContextManager {
	process(messages: Message[], usage: TokenUsage, currentFiles: string[]): Message[];
	getUtilization(): BudgetUtilization;
	getArchive(): ContextArchive;
}

// ─── Tool Types ───────────────────────────────────────────────────────────────

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

export interface ToolRegistry {
	register(tool: Tool): void;
	get(name: string): Tool | undefined;
	list(): Tool[];
	toDefinitions(): ToolDefinition[];
}

// ─── Scoring Types ────────────────────────────────────────────────────────────

export type MessageCategory = "task" | "history" | "current";

export interface ScoredMessage {
	message: Message;
	score: number;
	category: MessageCategory;
	tokenCount: number;
	age: number;
	metadata: {
		filesReferenced: string[];
		isErrorContext: boolean;
		hasUnresolvedQuestion: boolean;
	};
}
