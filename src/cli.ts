/**
 * CLI run command handler for Sapling.
 *
 * Exports runCommand() which wires together the LLM client, tool registry,
 * and context manager, then calls runLoop().
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AnthropicClient, CcClient, PiClient } from "./client/index.ts";
import { loadGuardConfig } from "./config.ts";
import { createContextManager } from "./context/manager.ts";
import { ConfigError } from "./errors.ts";
import { EventEmitter } from "./hooks/events.ts";
import { HookManager } from "./hooks/manager.ts";
import { logger } from "./logging/logger.ts";
import { runLoop } from "./loop.ts";
import { RpcServer } from "./rpc/server.ts";
import { createDefaultRegistry } from "./tools/index.ts";
import type { EventConfig, LlmClient, LoopOptions, RunOptions, SaplingConfig } from "./types.ts";

// ─── Default System Prompt ────────────────────────────────────────────────────

const DEFAULT_SYSTEM_PROMPT = `\
You are Sapling, a coding agent. You have access to tools for reading and writing files,
running shell commands, and searching code. Work methodically: understand the task,
explore relevant code, make changes, verify results. When done, say what you accomplished.
`;

// ─── Internal Factories ───────────────────────────────────────────────────────

function createClient(config: SaplingConfig): LlmClient {
	if (config.backend === "sdk") {
		return new AnthropicClient({
			model: config.model,
			baseURL: config.apiBaseUrl,
			apiKey: config.apiKey,
		});
	}
	if (config.backend === "pi") {
		return new PiClient({ model: config.model, cwd: config.cwd });
	}
	return new CcClient({ model: config.model, cwd: config.cwd });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Execute a task using the Sapling agent loop.
 *
 * This is the handler for the `sapling run <prompt>` CLI command.
 * It sets up the LLM client, tool registry, and context manager,
 * then delegates to runLoop().
 *
 * @param prompt - The task description from the CLI
 * @param opts   - Parsed CLI options
 * @param config - Loaded and validated Sapling configuration
 * @returns The loop result (exit reason, turn count, token counts)
 */
export async function runCommand(
	prompt: string,
	opts: RunOptions,
	config: SaplingConfig,
): Promise<ReturnType<typeof runLoop>> {
	// Validate cwd exists (sapling-3810)
	if (!existsSync(config.cwd)) {
		throw new ConfigError(`Working directory not found: ${config.cwd}`, "CONFIG_INVALID_CWD");
	}

	// Load custom system prompt if provided
	let systemPrompt = DEFAULT_SYSTEM_PROMPT;
	if (opts.systemPromptFile) {
		const filePath = resolve(opts.systemPromptFile);
		try {
			systemPrompt = await readFile(filePath, "utf-8");
		} catch (err) {
			if (
				err instanceof Error &&
				"code" in err &&
				(err as NodeJS.ErrnoException).code === "ENOENT"
			) {
				throw new ConfigError(`System prompt file not found: ${filePath}`, "CONFIG_FILE_NOT_FOUND");
			}
			throw err;
		}
	}

	// Load guard config if guards file provided (standalone mode if file not found)
	let hookManager: HookManager | null = null;
	let eventConfig: EventConfig | undefined;
	if (config.guardsFile) {
		const guardConfig = await loadGuardConfig(config.guardsFile);
		if (guardConfig) {
			hookManager = new HookManager(guardConfig);
			eventConfig = guardConfig.eventConfig;
		}
	}

	// Emit deprecation warning for CC and Pi subprocess backends
	if (config.backend === "cc") {
		logger.warn(
			"CC subprocess backend is deprecated and does not support tool calling. Use --backend sdk (default) instead. CC backend will be removed in v0.3.0.",
		);
	} else if (config.backend === "pi") {
		logger.warn(
			"Pi subprocess backend is deprecated and does not support tool calling. Use --backend sdk (default) instead. Pi backend will be removed in v0.3.0.",
		);
	}

	const client = createClient(config);
	const tools = createDefaultRegistry();
	const contextManager = createContextManager({
		budget: config.contextBudget,
		verbose: config.verbose,
	});

	const eventEmitter = new EventEmitter(config.json);

	// RPC mode: open stdin as a control channel for mid-task steering
	const rpcServer = opts.rpcMode
		? new RpcServer(Bun.stdin.stream() as ReadableStream<Uint8Array>, eventEmitter)
		: undefined;

	const loopOptions: LoopOptions = {
		task: prompt,
		systemPrompt,
		model: config.model,
		maxTurns: config.maxTurns,
		cwd: config.cwd,
		hookManager: hookManager ?? undefined,
		eventEmitter,
		rpcServer,
		eventConfig,
	};

	return runLoop(client, tools, contextManager, loopOptions);
}
