#!/usr/bin/env bun
import { Command } from "commander";
import { runCommand } from "./cli.ts";
import { loadConfig } from "./config.ts";
import { printJson, printJsonError } from "./json.ts";
import { setColorEnabled } from "./logging/color.ts";
import { configure, logger } from "./logging/logger.ts";
import type { LlmBackend, RunOptions } from "./types.ts";

export const VERSION = "0.1.1";

const program = new Command();

program
	.name("sapling")
	.description("Headless coding agent with proactive context management")
	.version(VERSION);

program
	.command("run <prompt>")
	.description("Execute a task")
	.option("--model <name>", "Model to use", "claude-sonnet-4-6")
	.option("--cwd <path>", "Working directory", ".")
	.option("--backend <cc|sdk>", "LLM backend (auto-detects sdk inside CC sessions)", "cc")
	.option("--system-prompt-file <path>", "Custom system prompt file")
	.option("--max-turns <n>", "Max turns", "200")
	.option("--verbose", "Log context manager decisions")
	.option("--json", "NDJSON event output on stdout")
	.option("-q, --quiet", "Suppress non-essential output")
	.action(async (prompt: string, options: Record<string, string | boolean | undefined>) => {
		const opts: RunOptions = {
			systemPromptFile: options.systemPromptFile as string | undefined,
			model: options.model as string | undefined,
			backend: options.backend as LlmBackend | undefined,
			maxTurns: options.maxTurns ? parseInt(options.maxTurns as string, 10) : undefined,
			verbose: options.verbose as boolean | undefined,
			quiet: options.quiet as boolean | undefined,
			json: options.json as boolean | undefined,
		};

		const config = loadConfig({
			...(opts.model ? { model: opts.model } : {}),
			...(opts.backend ? { backend: opts.backend } : {}),
			...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
			...(opts.verbose !== undefined ? { verbose: opts.verbose } : {}),
			...(opts.quiet !== undefined ? { quiet: opts.quiet } : {}),
			...(opts.json !== undefined ? { json: opts.json } : {}),
			cwd: (options.cwd as string | undefined) ?? process.cwd(),
		});

		configure({ verbose: config.verbose, quiet: config.quiet, json: config.json });
		setColorEnabled(!config.quiet && !config.json);

		const result = await runCommand(prompt, opts, config);

		if (config.json) {
			if (result.exitReason === "error") {
				printJsonError("TASK_ERROR", result.error ?? "Task failed", {
					exitReason: result.exitReason,
					totalTurns: result.totalTurns,
					totalInputTokens: result.totalInputTokens,
					totalOutputTokens: result.totalOutputTokens,
				});
			} else {
				printJson({
					exitReason: result.exitReason,
					totalTurns: result.totalTurns,
					totalInputTokens: result.totalInputTokens,
					totalOutputTokens: result.totalOutputTokens,
				});
			}
		} else {
			logger.info(
				`Done: ${result.exitReason} after ${result.totalTurns} turn(s) ` +
					`(${result.totalInputTokens} in / ${result.totalOutputTokens} out tokens)`,
			);
		}

		if (result.exitReason === "error") {
			process.exit(1);
		}
	});

program
	.command("version")
	.description("Print version")
	.action(() => {
		console.log(VERSION);
	});

program.parse(process.argv);
