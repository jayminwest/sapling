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

/** Minimal interface for hook manager — avoids circular import with hooks/manager.ts. */
export interface IHookManager {
	/** Return false to block the tool call; true to allow it. */
	preToolCall(toolName: string, input: Record<string, unknown>): boolean;
	/** Called after a tool call completes (result is final content string). */
	postToolCall(toolName: string, result: string): void;
}

/** Minimal interface for RPC server — avoids circular import with rpc/server.ts. */
export interface IRpcServer {
	/** Dequeue the next steer/followUp request. Returns undefined if queue is empty. */
	dequeue(): { method: string; params: { content: string } } | undefined;
	/** Returns true if an abort request has been received. */
	isAbortRequested(): boolean;
}

export interface LoopOptions {
	task: string;
	systemPrompt: string;
	model: string;
	maxTurns?: number;
	cwd: string;
	/** Optional hook manager for pre/post tool call guards. */
	hookManager?: IHookManager;
	/** Optional event emitter for NDJSON per-turn events (--json mode). */
	eventEmitter?: { emit(event: Record<string, unknown>): void };
	/** Optional RPC server for JSON-RPC stdin control channel (--mode rpc). */
	rpcServer?: IRpcServer;
	/** Optional lifecycle event config from guards.json for orchestrator hooks. */
	eventConfig?: EventConfig;
	/** Optional callback invoked at turn boundaries to report loop state for RPC getState. */
	setState?: (state: { turn: number; phase: "calling_llm" | "executing_tools" | "idle" }) => void;
	/** Context window size in tokens for the v1 pipeline. */
	contextWindowSize?: number;
}

export interface LoopResult {
	exitReason: "task_complete" | "max_turns" | "error" | "aborted";
	totalTurns: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheCreationTokens: number;
	error?: string;
	responseText?: string;
}

export interface SessionRecord {
	timestamp: string;
	promptSummary: string;
	filesModified: string[];
	tokenUsage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheCreation: number;
	};
	durationMs: number;
	model: string;
	exitReason: string;
	totalTurns: number;
}

// ─── Config Types ─────────────────────────────────────────────────────────────

export type LlmBackend = "sdk";

export interface SaplingConfig {
	model: string;
	backend: LlmBackend;
	maxTurns: number;
	cwd: string;
	verbose: boolean;
	quiet: boolean;
	json: boolean;
	contextWindow: number;
	apiBaseUrl?: string;
	apiKey?: string;
	guardsFile?: string;
}

export interface RunOptions {
	systemPromptFile?: string;
	model?: string;
	backend?: LlmBackend;
	maxTurns?: number;
	verbose?: boolean;
	quiet?: boolean;
	json?: boolean;
	guardsFile?: string;
	rpcMode?: boolean;
	rpcSocket?: string;
	dryRun?: boolean;
}

// ─── Context Types ────────────────────────────────────────────────────────────

export interface BudgetEntry {
	used: number;
	budget: number;
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

/**
 * Optional pipeline metadata a Tool can declare to influence context management.
 * When present, these values take precedence over the built-in TOOL_PHASES fallback.
 */
export interface ToolPipelineMetadata {
	/** Pipeline phase for boundary detection and operation type inference. */
	phase?: "read" | "write" | "verify" | "search";
	/** Keys in tool input that contain file paths. Supplements default extraction keys. */
	filePathKeys?: string[];
}

export interface Tool {
	name: string;
	description: string;
	inputSchema: JsonSchema;
	dryRun?: boolean;
	/** Optional pipeline metadata for context management. */
	pipeline?: ToolPipelineMetadata;
	execute(input: Record<string, unknown>, cwd: string): Promise<ToolResult>;
	toDefinition(): ToolDefinition;
}

export interface ToolRegistry {
	register(tool: Tool): void;
	get(name: string): Tool | undefined;
	list(): Tool[];
	toDefinitions(): ToolDefinition[];
}

// ─── Guards Types ─────────────────────────────────────────────────────────────

/**
 * Lifecycle hook configuration for orchestrators (e.g. overstory).
 * Each field is an argv array to spawn as a subprocess at the corresponding event.
 */
export interface EventConfig {
	onToolStart?: string[];
	onToolEnd?: string[];
	onSessionEnd?: string[];
}

export type GuardEvent = "pre_tool_call" | "post_tool_call";
export type GuardAction = "block" | "allow" | "warn";

export interface GuardRule {
	event: GuardEvent;
	tool?: string;
	action: GuardAction;
	reason?: string;
}

export interface GuardConfig {
	version?: string;
	rules: GuardRule[];
	// Flat guard config (evaluated before rules)
	pathBoundary?: string; // base directory — block file ops outside this path
	fileScope?: string[]; // allowed files — block file ops not in this list
	readOnly?: boolean; // block all write/edit tools
	blockedBashPatterns?: string[]; // regex patterns — block bash commands matching any
	blockedTools?: string[]; // tool names to block entirely
	eventConfig?: EventConfig; // lifecycle hooks for orchestrators
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
