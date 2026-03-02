/**
 * CLI run command handler for Sapling.
 *
 * Exports runCommand() which wires together the LLM client, tool registry,
 * and context manager, then calls runLoop().
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AnthropicClient, CcClient } from "./client/index.ts";
import { createContextManager } from "./context/manager.ts";
import { runLoop } from "./loop.ts";
import { createDefaultRegistry } from "./tools/index.ts";
import type { LlmClient, LoopOptions, RunOptions, SaplingConfig } from "./types.ts";

// ─── Default System Prompt ────────────────────────────────────────────────────

const DEFAULT_SYSTEM_PROMPT = `\
You are Sapling, a coding agent. You have access to tools for reading and writing files,
running shell commands, and searching code. Work methodically: understand the task,
explore relevant code, make changes, verify results. When done, say what you accomplished.
`;

// ─── Internal Factories ───────────────────────────────────────────────────────

function createClient(config: SaplingConfig): LlmClient {
	if (config.backend === "sdk") {
		return new AnthropicClient({ model: config.model });
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
	// Load custom system prompt if provided
	let systemPrompt = DEFAULT_SYSTEM_PROMPT;
	if (opts.systemPromptFile) {
		const filePath = resolve(opts.systemPromptFile);
		systemPrompt = await readFile(filePath, "utf-8");
	}

	const client = createClient(config);
	const tools = createDefaultRegistry();
	const contextManager = createContextManager({
		budget: config.contextBudget,
		verbose: config.verbose,
	});

	const loopOptions: LoopOptions = {
		task: prompt,
		systemPrompt,
		model: config.model,
		maxTurns: config.maxTurns,
		cwd: config.cwd,
	};

	return runLoop(client, tools, contextManager, loopOptions);
}
