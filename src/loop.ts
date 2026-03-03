/**
 * Agent turn loop for Sapling.
 *
 * Implements the core cycle: LLM call → tool dispatch → context management → repeat.
 * Parallel tool execution via Promise.all.
 * Stop conditions: no tool calls, max turns, unrecoverable error.
 * LLM errors use exponential backoff (3 retries).
 */

import { ClientError } from "./errors.ts";
import { logger } from "./logging/logger.ts";
import type {
	ContentBlock,
	ContextManager,
	LlmClient,
	LlmRequest,
	LlmResponse,
	LoopOptions,
	LoopResult,
	Message,
	ToolRegistry,
} from "./types.ts";

// ─── Internal Types ───────────────────────────────────────────────────────────

/**
 * A tool_result content block (Anthropic API format).
 * Not in the shared ContentBlock union (which only covers LLM output blocks);
 * tool results are user-turn inputs.
 */
interface ToolResultBlock {
	type: "tool_result";
	tool_use_id: string;
	content: string;
	is_error?: boolean;
}

/**
 * Internal message type that extends Message to allow tool_result content in user turns.
 * Cast to Message[] when passing to LlmClient.process().
 */
type LoopMessage =
	| { role: "user"; content: string | (ContentBlock | ToolResultBlock)[] }
	| { role: "assistant"; content: ContentBlock[] };

// ─── Retry Configuration ──────────────────────────────────────────────────────

const MAX_RETRY_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 1000;

/**
 * Error codes that indicate an unrecoverable failure.
 * These abort the loop immediately without retrying.
 */
const UNRECOVERABLE_CODES = new Set([
	"AUTH_FAILED",
	"CC_AUTH_FAILED",
	"MODEL_NOT_FOUND",
	"INVALID_API_KEY",
	"PERMISSION_DENIED",
	"SDK_AUTH_FAILED",
	"SDK_PERMISSION_DENIED",
	"SDK_MODEL_NOT_FOUND",
	"SDK_NOT_INSTALLED",
]);

// ─── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Call the LLM client with exponential backoff on transient failures.
 * Throws immediately on unrecoverable errors (auth, model not found).
 */
async function callWithRetry(client: LlmClient, request: LlmRequest): Promise<LlmResponse> {
	let lastError: Error | undefined;

	for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
		try {
			return await client.call(request);
		} catch (err) {
			if (err instanceof ClientError && UNRECOVERABLE_CODES.has(err.code)) {
				throw err;
			}
			lastError = err instanceof Error ? err : new Error(String(err));
			if (attempt < MAX_RETRY_ATTEMPTS - 1) {
				const delay = BASE_RETRY_DELAY_MS * 2 ** attempt;
				logger.warn(
					`LLM call failed (attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS}), retrying in ${delay}ms`,
					{ error: lastError.message },
				);
				await new Promise<void>((resolve) => setTimeout(resolve, delay));
			}
		}
	}

	throw lastError ?? new Error("LLM call failed after all retries");
}

/**
 * Extract tool_use blocks from an LLM response's content array.
 */
function extractToolCalls(content: ContentBlock[]): Extract<ContentBlock, { type: "tool_use" }>[] {
	return content.filter(
		(b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
	);
}

/**
 * Scan the last N messages for file paths referenced in tool inputs.
 * Used to inform the context manager's relevance scoring.
 */
function extractCurrentFiles(messages: LoopMessage[], lookback = 5): string[] {
	const files = new Set<string>();
	const recent = messages.slice(-lookback);

	for (const msg of recent) {
		if (typeof msg.content === "string") continue;
		for (const block of msg.content) {
			if (block.type === "tool_use") {
				const { input } = block;
				if (typeof input.file_path === "string") files.add(input.file_path);
				if (typeof input.path === "string") files.add(input.path);
			}
		}
	}

	return [...files];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run the agent turn loop.
 *
 * Drives the LLM call → tool dispatch → context management cycle until one of:
 * - The LLM returns a response with no tool calls (task complete)
 * - The max turn limit is reached
 * - An unrecoverable error occurs
 *
 * @param client         - LLM backend (CC subprocess or Anthropic SDK)
 * @param tools          - Registry of available tools
 * @param contextManager - Inter-turn context pipeline
 * @param options        - Loop configuration
 */
export async function runLoop(
	client: LlmClient,
	tools: ToolRegistry,
	contextManager: ContextManager,
	options: LoopOptions,
): Promise<LoopResult> {
	const maxTurns = options.maxTurns ?? 200;
	let totalTurns = 0;
	let totalInputTokens = 0;
	let totalOutputTokens = 0;

	const toolDefs = tools.toDefinitions();

	// Seed the conversation with the task description
	const messages: LoopMessage[] = [{ role: "user", content: options.task }];

	logger.info(`Starting agent loop`, {
		model: options.model,
		maxTurns,
		tools: toolDefs.map((t) => t.name),
	});

	while (totalTurns < maxTurns) {
		totalTurns++;

		// ── Step 1: Build LLM request ─────────────────────────────────────────
		const request: LlmRequest = {
			systemPrompt: options.systemPrompt,
			messages: messages as Message[],
			tools: toolDefs,
			model: options.model,
		};

		// ── Step 2: Call LLM with retry ───────────────────────────────────────
		let response: LlmResponse;
		try {
			response = await callWithRetry(client, request);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.error(`Agent loop aborted: ${message}`);
			return {
				exitReason: "error",
				totalTurns,
				totalInputTokens,
				totalOutputTokens,
				error: message,
			};
		}

		// ── Step 3: Record token usage ────────────────────────────────────────
		totalInputTokens += response.usage.inputTokens;
		totalOutputTokens += response.usage.outputTokens;

		// ── Step 4: Append assistant response ─────────────────────────────────
		messages.push({ role: "assistant", content: response.content });

		// ── Step 5: Check stop condition — no tool calls ──────────────────────
		const toolCalls = extractToolCalls(response.content);
		if (toolCalls.length === 0) {
			// Extract final text from the response
			const finalText = response.content
				.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
				.map((b) => b.text)
				.join("\n");

			if (finalText) {
				process.stdout.write(`${finalText}\n`);
			}

			logger.info(`Task complete after ${totalTurns} turn(s)`, {
				inputTokens: totalInputTokens,
				outputTokens: totalOutputTokens,
			});
			// Let context manager finalize state
			contextManager.process(messages as Message[], response.usage, []);
			return {
				exitReason: "task_complete",
				totalTurns,
				totalInputTokens,
				totalOutputTokens,
			};
		}

		logger.debug(`Turn ${totalTurns}: dispatching ${toolCalls.length} tool call(s)`, {
			tools: toolCalls.map((c) => c.name),
		});

		// ── Step 6: Execute tools in parallel ─────────────────────────────────
		const toolResultBlocks: ToolResultBlock[] = await Promise.all(
			toolCalls.map(async (call): Promise<ToolResultBlock> => {
				const tool = tools.get(call.name);
				if (!tool) {
					logger.warn(`Unknown tool requested: ${call.name}`);
					return {
						type: "tool_result",
						tool_use_id: call.id,
						content: `Tool not found: "${call.name}". Available tools: ${tools
							.list()
							.map((t) => t.name)
							.join(", ")}`,
						is_error: true,
					};
				}

				try {
					const result = await tool.execute(call.input, options.cwd);
					logger.debug(`Tool ${call.name} completed`, {
						isError: result.isError,
						tokens: result.metadata?.tokensEstimate,
					});
					return {
						type: "tool_result",
						tool_use_id: call.id,
						content: result.content,
						...(result.isError ? { is_error: true } : {}),
					};
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					logger.warn(`Tool ${call.name} threw: ${msg}`);
					return {
						type: "tool_result",
						tool_use_id: call.id,
						content: `Tool execution error: ${msg}`,
						is_error: true,
					};
				}
			}),
		);

		// ── Step 7: Append tool results as user message ───────────────────────
		messages.push({ role: "user", content: toolResultBlocks });

		// ── Step 8: Run context manager ───────────────────────────────────────
		const currentFiles = extractCurrentFiles(messages);
		const managed = contextManager.process(messages as Message[], response.usage, currentFiles);
		// Replace the message array in-place with the managed version
		messages.splice(0, messages.length, ...(managed as LoopMessage[]));
	}

	// Max turns exhausted
	logger.warn(`Agent loop stopped: max turns (${maxTurns}) reached`, {
		inputTokens: totalInputTokens,
		outputTokens: totalOutputTokens,
	});
	return {
		exitReason: "max_turns",
		totalTurns,
		totalInputTokens,
		totalOutputTokens,
	};
}
