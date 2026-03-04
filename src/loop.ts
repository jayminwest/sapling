/**
 * Agent turn loop for Sapling.
 *
 * Implements the core cycle: LLM call → tool dispatch → context management → repeat.
 * Parallel tool execution via Promise.all.
 * Stop conditions: no tool calls, max turns, unrecoverable error.
 * LLM errors use exponential backoff (3 retries).
 */

import { extractTurnHint, SaplingPipelineV1 } from "./context/v1/pipeline.ts";
import { ClientError } from "./errors.ts";
import { logger } from "./logging/logger.ts";
import type {
	ContentBlock,
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
	"PI_NOT_FOUND",
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
// ─── Lifecycle Hook Helpers ───────────────────────────────────────────────────

/**
 * Await the onSessionEnd hook if configured.
 * Must be awaited (unlike tool events) — overstory uses this for critical
 * session bookkeeping: token metrics, state transition, and worker_done mail.
 */
async function fireSessionEnd(argv: string[] | undefined): Promise<void> {
	if (!argv) return;
	const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" });
	await proc.exited;
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
 * @param client  - LLM backend (CC subprocess or Anthropic SDK)
 * @param tools   - Registry of available tools
 * @param options - Loop configuration
 */
export async function runLoop(
	client: LlmClient,
	tools: ToolRegistry,
	options: LoopOptions,
): Promise<LoopResult> {
	const maxTurns = options.maxTurns ?? 200;
	let totalTurns = 0;
	let totalInputTokens = 0;
	let totalOutputTokens = 0;

	const toolDefs = tools.toDefinitions();

	// Seed the conversation with the task description
	const messages: LoopMessage[] = [{ role: "user", content: options.task }];

	// v1 pipeline — created once, stateful across turns
	// Base system prompt is kept immutable; pipeline returns a composed version each turn
	const pipeline = new SaplingPipelineV1({
		windowSize: options.contextWindowSize ?? 200_000,
		verbose: false,
	});
	// Track the pipeline-managed system prompt (updated each turn by the v1 pipeline)
	let currentSystemPrompt = options.systemPrompt;

	logger.info(`Starting agent loop`, {
		model: options.model,
		maxTurns,
		tools: toolDefs.map((t) => t.name),
	});

	options.eventEmitter?.emit({
		type: "ready",
		model: options.model,
		maxTurns,
		tools: toolDefs.map((t) => t.name),
	});

	while (totalTurns < maxTurns) {
		// ── RPC abort check — before starting a new turn ─────────────────────
		if (options.rpcServer?.isAbortRequested()) {
			logger.info("Agent loop aborted by RPC request");
			options.eventEmitter?.emit({
				type: "result",
				exitReason: "aborted",
				totalTurns,
				totalInputTokens,
				totalOutputTokens,
			});
			await fireSessionEnd(options.eventConfig?.onSessionEnd);
			return { exitReason: "aborted", totalTurns, totalInputTokens, totalOutputTokens };
		}

		totalTurns++;
		options.eventEmitter?.emit({ type: "turn_start", turn: totalTurns });

		// ── Step 1: Build LLM request ─────────────────────────────────────────
		const request: LlmRequest = {
			// Use the pipeline-managed system prompt (updated by v1 pipeline each turn)
			systemPrompt: currentSystemPrompt,
			messages: messages as Message[],
			tools: toolDefs,
			model: options.model,
		};

		options.setState?.({ turn: totalTurns, phase: "calling_llm" });

		// ── Step 2: Call LLM with retry ───────────────────────────────────────
		let response: LlmResponse;
		try {
			response = await callWithRetry(client, request);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const code = err instanceof ClientError ? err.code : "UNKNOWN";
			logger.error(`Agent loop aborted: ${message}`);
			options.eventEmitter?.emit({ type: "error", message, classification: code });
			options.eventEmitter?.emit({
				type: "result",
				exitReason: "error",
				totalTurns,
				totalInputTokens,
				totalOutputTokens,
			});
			await fireSessionEnd(options.eventConfig?.onSessionEnd);
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

			logger.info(`Task complete after ${totalTurns} turn(s)`, {
				inputTokens: totalInputTokens,
				outputTokens: totalOutputTokens,
			});
			// Use last pipeline state for utilization
			const contextUtilization = pipeline.getState()?.utilization ?? 0;
			options.eventEmitter?.emit({
				type: "turn_end",
				turn: totalTurns,
				inputTokens: totalInputTokens,
				outputTokens: totalOutputTokens,
				cacheReadTokens: response.usage.cacheReadTokens ?? 0,
				cacheWriteTokens: response.usage.cacheCreationTokens ?? 0,
				model: response.model,
				contextUtilization,
			});
			options.eventEmitter?.emit({
				type: "result",
				exitReason: "task_complete",
				totalTurns,
				totalInputTokens,
				totalOutputTokens,
			});
			await fireSessionEnd(options.eventConfig?.onSessionEnd);
			return {
				exitReason: "task_complete",
				totalTurns,
				totalInputTokens,
				totalOutputTokens,
				responseText: finalText || undefined,
			};
		}

		logger.debug(`Turn ${totalTurns}: dispatching ${toolCalls.length} tool call(s)`, {
			tools: toolCalls.map((c) => c.name),
		});

		// ── Step 6: Execute tools in parallel ─────────────────────────────────
		// Fire onToolStart heartbeat — fire-and-forget (updates overstory lastActivity)
		if (options.eventConfig?.onToolStart) {
			Bun.spawn(options.eventConfig.onToolStart, { stdout: "ignore", stderr: "ignore" });
		}

		options.setState?.({ turn: totalTurns, phase: "executing_tools" });

		const toolResultBlocks: ToolResultBlock[] = await Promise.all(
			toolCalls.map(async (call): Promise<ToolResultBlock> => {
				// Emit tool_start event before dispatching
				const argsSummary = JSON.stringify(call.input).slice(0, 200);
				options.eventEmitter?.emit({
					type: "tool_start",
					turn: totalTurns,
					toolName: call.name,
					toolCallId: call.id,
					argsSummary,
				});
				const toolStartTime = Date.now();

				let toolResult: ToolResultBlock;
				const tool = tools.get(call.name);
				if (!tool) {
					logger.warn(`Unknown tool requested: ${call.name}`);
					toolResult = {
						type: "tool_result",
						tool_use_id: call.id,
						content: `Tool not found: "${call.name}". Available tools: ${tools
							.list()
							.map((t) => t.name)
							.join(", ")}`,
						is_error: true,
					};
				} else if (options.hookManager && !options.hookManager.preToolCall(call.name, call.input)) {
					// Pre-tool-call hook — block if guard returns false
					toolResult = {
						type: "tool_result",
						tool_use_id: call.id,
						content: `Tool call blocked by guard: "${call.name}"`,
						is_error: true,
					};
				} else {
					try {
						const result = await tool.execute(call.input, options.cwd);

						// Post-tool-call hook
						options.hookManager?.postToolCall(call.name, result.content);

						logger.debug(`Tool ${call.name} completed`, {
							isError: result.isError,
							tokens: result.metadata?.tokensEstimate,
						});
						toolResult = {
							type: "tool_result",
							tool_use_id: call.id,
							content: result.content,
							...(result.isError ? { is_error: true } : {}),
						};
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						logger.warn(`Tool ${call.name} threw: ${msg}`);
						toolResult = {
							type: "tool_result",
							tool_use_id: call.id,
							content: `Tool execution error: ${msg}`,
							is_error: true,
						};
					}
				}

				// Emit tool_end event after completion
				options.eventEmitter?.emit({
					type: "tool_end",
					turn: totalTurns,
					toolName: call.name,
					toolCallId: call.id,
					success: !(toolResult.is_error ?? false),
					durationMs: Date.now() - toolStartTime,
				});

				return toolResult;
			}),
		);

		// Fire onToolEnd heartbeat — fire-and-forget (updates overstory lastActivity)
		if (options.eventConfig?.onToolEnd) {
			Bun.spawn(options.eventConfig.onToolEnd, { stdout: "ignore", stderr: "ignore" });
		}

		// ── Step 7: Append tool results as user message ───────────────────────
		messages.push({ role: "user", content: toolResultBlocks });

		// ── Step 7b: Inject queued RPC steer/followUp requests ───────────────
		// Per decision mx-195088: steer appended to current turn's tool results.
		// followUp injected as a standalone user message.
		if (options.rpcServer) {
			let rpcReq = options.rpcServer.dequeue();
			while (rpcReq) {
				if (rpcReq.method === "steer") {
					const lastMsg = messages[messages.length - 1];
					if (lastMsg?.role === "user" && Array.isArray(lastMsg.content)) {
						(lastMsg.content as Array<ContentBlock | ToolResultBlock>).push({
							type: "text",
							text: `[STEER] ${rpcReq.params.content}`,
						});
					}
				} else if (rpcReq.method === "followUp") {
					messages.push({ role: "user", content: rpcReq.params.content });
				}
				logger.debug(`RPC ${rpcReq.method} injected into turn ${totalTurns}`);
				rpcReq = options.rpcServer.dequeue();
			}
		}

		// ── Step 8: Run v1 pipeline ─────────────────────────────────────────────
		const turnHint = extractTurnHint(messages as Message[], totalTurns);
		const pipelineResult = pipeline.process({
			messages: messages as Message[],
			systemPrompt: options.systemPrompt, // always pass the base prompt
			turnHint,
			usage: response.usage,
		});
		messages.splice(0, messages.length, ...(pipelineResult.messages as LoopMessage[]));
		currentSystemPrompt = pipelineResult.systemPrompt;
		const contextUtilization = pipelineResult.state.utilization;

		// Update RPC server with pipeline state for getState responses
		const rpcState = pipeline.getRpcState() ?? undefined;
		if (options.rpcServer && "setPipelineState" in options.rpcServer) {
			(options.rpcServer as { setPipelineState: (s: typeof rpcState) => void }).setPipelineState(
				rpcState,
			);
		}

		options.setState?.({ turn: totalTurns, phase: "idle" });

		// Emit turn_end with cumulative token counts and context utilization ratio
		options.eventEmitter?.emit({
			type: "turn_end",
			turn: totalTurns,
			inputTokens: totalInputTokens,
			outputTokens: totalOutputTokens,
			cacheReadTokens: response.usage.cacheReadTokens ?? 0,
			cacheWriteTokens: response.usage.cacheCreationTokens ?? 0,
			model: response.model,
			contextUtilization,
		});
	}

	// Max turns exhausted
	logger.warn(`Agent loop stopped: max turns (${maxTurns}) reached`, {
		inputTokens: totalInputTokens,
		outputTokens: totalOutputTokens,
	});
	options.eventEmitter?.emit({
		type: "result",
		exitReason: "max_turns",
		totalTurns,
		totalInputTokens,
		totalOutputTokens,
	});
	await fireSessionEnd(options.eventConfig?.onSessionEnd);
	return {
		exitReason: "max_turns",
		totalTurns,
		totalInputTokens,
		totalOutputTokens,
	};
}
