export type {
	ContentBlock,
	LlmClient,
	LlmRequest,
	LlmResponse,
	Message,
	TokenUsage,
	ToolDefinition,
} from "../types.ts";

export interface CcStructuredResponse {
	thinking: string;
	tool_calls?: Array<{ name: string; input: Record<string, unknown> }>;
	text_response?: string;
}
