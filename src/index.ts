#!/usr/bin/env bun
import { Command } from "commander";
import { runCommand } from "./cli.ts";
import { registerAuthCommand } from "./commands/auth.ts";
import { registerCompletionsCommand } from "./commands/completions.ts";
import { registerConfigCommand } from "./commands/config.ts";
import { registerDoctorCommand } from "./commands/doctor.ts";
import { registerInitCommand } from "./commands/init.ts";
import { registerTypoHandler } from "./commands/typo.ts";
import { registerUpgradeCommand } from "./commands/upgrade.ts";
import { loadConfig } from "./config.ts";
import { SaplingError } from "./errors.ts";
import { jsonOutput, printJson, printJsonError } from "./json.ts";
import { colors, setColorEnabled } from "./logging/color.ts";
import { configure, logger } from "./logging/logger.ts";
import { appendSessionRecord, summarizePrompt } from "./session.ts";
import type { LlmBackend, RunOptions } from "./types.ts";

export const VERSION = "0.3.0";

const startTime = Date.now();

// Handle --version --json before Commander takes over (sapling-0bbd)
if (
	(process.argv.includes("--version") || process.argv.includes("-V")) &&
	process.argv.includes("--json")
) {
	console.log(
		jsonOutput("version", {
			name: "@os-eco/sapling-cli",
			version: VERSION,
			runtime: "bun",
			platform: `${process.platform}-${process.arch}`,
		}),
	);
	process.exit(0);
}

const program = new Command();

program
	.name("sapling")
	.description("Headless coding agent with proactive context management")
	.version(VERSION)
	.addHelpText("beforeAll", () => {
		// Branded header: tool name bold+cyan, version dim, tagline default (sapling-46a7)
		return `${colors.bold(colors.cyan("sapling"))} ${colors.dim(`v${VERSION}`)}\nHeadless coding agent with proactive context management\n`;
	});

program
	.command("run [prompt]")
	.description("Execute a task")
	.option("--model <name>", "Model to use (default: claude-sonnet-4-6)")
	.option("--cwd <path>", "Working directory", ".")
	.option(
		"--backend <cc|pi|sdk>",
		"LLM backend (auto-detects sdk inside CC sessions) (default: cc)",
	)
	.option("--system-prompt-file <path>", "Custom system prompt file")
	.option("--max-turns <n>", "Max turns (default: 200)")
	.option("--verbose", "Log context manager decisions")
	.option("--json", "NDJSON event output on stdout")
	.option("--timing", "Output elapsed execution time to stderr") // sapling-bcb3
	.option("-q, --quiet", "Suppress non-essential output")
	.option("--guards-file <path>", "Path to guards config JSON file")
	.option("--mode <mode>", "Execution mode: one-shot (default) or rpc")
	.action(
		async (prompt: string | undefined, options: Record<string, string | boolean | undefined>) => {
			try {
				const isRpcMode = (options.mode as string | undefined) === "rpc";

				// In RPC mode, stdin is the control channel — prompt must be a CLI arg
				if (!isRpcMode && !prompt && !process.stdin.isTTY) {
					// Read from stdin if no prompt and input is piped (sapling-fe2c)
					prompt = (await Bun.stdin.text()).trim();
				}

				// Validate prompt is non-empty (sapling-5ad6)
				if (!prompt || !prompt.trim()) {
					const hint = isRpcMode
						? " In --mode rpc, stdin is the control channel; provide prompt as argument."
						: " Provide as argument or pipe via stdin.";
					process.stderr.write(`Error: prompt must not be empty.${hint}\n`);
					process.exitCode = 1;
					return;
				}

				const opts: RunOptions = {
					systemPromptFile: options.systemPromptFile as string | undefined,
					model: options.model as string | undefined,
					backend: options.backend as LlmBackend | undefined,
					maxTurns: options.maxTurns ? parseInt(options.maxTurns as string, 10) : undefined,
					verbose: options.verbose as boolean | undefined,
					quiet: options.quiet as boolean | undefined,
					// RPC mode implicitly enables --json
					json: isRpcMode ? true : (options.json as boolean | undefined),
					guardsFile: options.guardsFile as string | undefined,
					rpcMode: isRpcMode,
				};

				const config = await loadConfig({
					...(opts.model ? { model: opts.model } : {}),
					...(opts.backend ? { backend: opts.backend } : {}),
					...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
					...(opts.verbose !== undefined ? { verbose: opts.verbose } : {}),
					...(opts.quiet !== undefined ? { quiet: opts.quiet } : {}),
					...(opts.json !== undefined ? { json: opts.json } : {}),
					...(opts.guardsFile !== undefined ? { guardsFile: opts.guardsFile } : {}),
					cwd: (options.cwd as string | undefined) ?? process.cwd(),
				});

				configure({ verbose: config.verbose, quiet: config.quiet, json: config.json });
				setColorEnabled(!config.quiet && !config.json);

				const result = await runCommand(prompt, opts, config);

				appendSessionRecord(config.cwd, {
					timestamp: new Date().toISOString(),
					promptSummary: summarizePrompt(prompt),
					filesModified: [],
					tokenUsage: {
						input: result.totalInputTokens,
						output: result.totalOutputTokens,
						cacheRead: result.totalCacheReadTokens,
						cacheCreation: result.totalCacheCreationTokens,
					},
					durationMs: Date.now() - startTime,
					model: config.model,
					exitReason: result.exitReason,
					totalTurns: result.totalTurns,
				});

				if (config.json) {
					if (result.responseText) {
						printJson("response", { response: result.responseText });
					}
					if (result.exitReason === "error") {
						printJsonError("run", result.error ?? "Task failed", {
							exitReason: result.exitReason,
							totalTurns: result.totalTurns,
							totalInputTokens: result.totalInputTokens,
							totalOutputTokens: result.totalOutputTokens,
						});
					} else {
						printJson("run", {
							exitReason: result.exitReason,
							totalTurns: result.totalTurns,
							totalInputTokens: result.totalInputTokens,
							totalOutputTokens: result.totalOutputTokens,
						});
					}
				} else {
					if (result.responseText) {
						process.stdout.write(`${result.responseText}\n`);
					}
					logger.info(
						`Done: ${result.exitReason} after ${result.totalTurns} turn(s) ` +
							`(${result.totalInputTokens} in / ${result.totalOutputTokens} out tokens)`,
					);
				}

				// --timing: print elapsed time to stderr in muted text (sapling-bcb3)
				// TTY-safe: only apply colors.dim when stderr is a TTY (sapling-1975)
				if (options.timing) {
					const elapsed = `Done in ${Date.now() - startTime}ms\n`;
					process.stderr.write(process.stderr.isTTY ? colors.dim(elapsed) : elapsed);
				}

				// Use process.exitCode instead of process.exit(1) to allow cleanup/finally (sapling-43da)
				if (result.exitReason === "error") {
					process.exitCode = 1;
				}
			} catch (err) {
				if (err instanceof SaplingError) {
					process.stderr.write(`Error: ${err.message}\n`);
					process.exitCode = 1;
					return;
				}
				throw err;
			}
		},
	);

program
	.command("version")
	.description("Print version")
	.option("--json", "Output as JSON envelope")
	.action((opts: { json?: boolean }) => {
		if (opts.json) {
			printJson("version", {
				name: "@os-eco/sapling-cli",
				version: VERSION,
				runtime: "bun",
				platform: `${process.platform}-${process.arch}`,
			});
		} else {
			console.log(VERSION);
		}
	});

program.showSuggestionAfterError(false);
registerAuthCommand(program);
registerCompletionsCommand(program);
registerConfigCommand(program);
registerInitCommand(program);
registerUpgradeCommand(program);
registerDoctorCommand(program);
registerTypoHandler(program);

program.parse(process.argv);
