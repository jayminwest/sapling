#!/usr/bin/env bun
import { Command } from "commander";
import { runCommand } from "./cli.ts";
import { registerCompletionsCommand } from "./commands/completions.ts";
import { registerDoctorCommand } from "./commands/doctor.ts";
import { registerTypoHandler } from "./commands/typo.ts";
import { registerUpgradeCommand } from "./commands/upgrade.ts";
import { loadConfig } from "./config.ts";
import { SaplingError } from "./errors.ts";
import { jsonOutput, printJson, printJsonError } from "./json.ts";
import { colors, setColorEnabled } from "./logging/color.ts";
import { configure, logger } from "./logging/logger.ts";
import type { LlmBackend, RunOptions } from "./types.ts";

export const VERSION = "0.1.2";

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
	.action(
		async (prompt: string | undefined, options: Record<string, string | boolean | undefined>) => {
			try {
				// Read from stdin if no prompt and input is piped (sapling-fe2c)
				if (!prompt && !process.stdin.isTTY) {
					prompt = (await Bun.stdin.text()).trim();
				}

				// Validate prompt is non-empty (sapling-5ad6)
				if (!prompt || !prompt.trim()) {
					process.stderr.write(
						"Error: prompt must not be empty. Provide as argument or pipe via stdin.\n",
					);
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
					json: options.json as boolean | undefined,
				};

				const config = loadConfig({
					...(opts.model ? { model: opts.model } : {}),
					...(opts.backend ? { backend: opts.backend } : {}),
					...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
					...(opts.verbose !== undefined ? { verbose: opts.verbose } : {}),
					...(opts.quiet !== undefined ? { quiet: opts.quiet } : {}),
					...(opts.json !== undefined ? { json: opts.json } : {}),
					cwd: (options.cwd as string | undefined) ?? process.cwd(),
				});

				configure({ verbose: config.verbose, quiet: config.quiet, json: config.json });
				setColorEnabled(!config.quiet && !config.json);

				const result = await runCommand(prompt, opts, config);

				// Print the agent final text response to stdout (sapling-c8bb)
				if (result.responseText) {
					process.stdout.write(`${result.responseText}\n`);
				}

				if (config.json) {
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
					logger.info(
						`Done: ${result.exitReason} after ${result.totalTurns} turn(s) ` +
							`(${result.totalInputTokens} in / ${result.totalOutputTokens} out tokens)`,
					);
				}

				// --timing: print elapsed time to stderr in muted text (sapling-bcb3)
				if (options.timing) {
					process.stderr.write(colors.dim(`Done in ${Date.now() - startTime}ms\n`));
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
registerCompletionsCommand(program);
registerUpgradeCommand(program);
registerDoctorCommand(program);
registerTypoHandler(program);

program.parse(process.argv);
