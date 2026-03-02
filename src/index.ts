#!/usr/bin/env bun
import { Command } from "commander";

export const VERSION = "0.1.0";

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
	.option("--backend <cc|sdk>", "LLM backend", "cc")
	.option("--system-prompt-file <path>", "Custom system prompt file")
	.option("--max-turns <n>", "Max turns", "200")
	.option("--verbose", "Log context manager decisions")
	.option("--json", "NDJSON event output on stdout")
	.option("-q, --quiet", "Suppress non-essential output")
	.action((_prompt, _options) => {
		console.error("sapling run: not yet implemented");
		process.exit(1);
	});

program
	.command("version")
	.description("Print version")
	.action(() => {
		console.log(VERSION);
	});

program.parse(process.argv);
