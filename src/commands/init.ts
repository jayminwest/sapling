/**
 * Init command for sapling CLI.
 * Scaffolds a .sapling/ project directory with config, guards, and session history.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Command } from "commander";
import { printJson } from "../json.ts";
import { colors } from "../logging/color.ts";

const SAPLING_DIR_NAME = ".sapling";
const CONFIG_FILE = "config.yaml";
const GUARDS_FILE = "guards.json";
const SESSION_FILE = "session.jsonl";
const GITIGNORE_FILE = ".gitignore";
const GITATTRIBUTES_ENTRY = ".sapling/session.jsonl merge=union\n";

export async function runInit(cwd: string, jsonMode: boolean): Promise<void> {
	const saplingDir = join(cwd, SAPLING_DIR_NAME);

	if (existsSync(join(saplingDir, CONFIG_FILE))) {
		if (jsonMode) {
			printJson("init", { initialized: false, dir: saplingDir, reason: "already initialized" });
		} else {
			process.stdout.write(`${colors.dim(`Already initialized: ${saplingDir}`)}\n`);
		}
		return;
	}

	mkdirSync(saplingDir, { recursive: true });

	// config.yaml — project defaults
	const projectName = basename(cwd);
	writeFileSync(
		join(saplingDir, CONFIG_FILE),
		[
			`# Sapling project configuration`,
			`project: "${projectName}"`,
			`model: MiniMax-M2.5`,
			`max_turns: 200`,
			`context_pipeline: v1`,
			``,
		].join("\n"),
	);

	// guards.json — project policy (empty rules by default)
	writeFileSync(
		join(saplingDir, GUARDS_FILE),
		`${JSON.stringify({ version: 1, rules: [] }, null, 2)}\n`,
	);

	// session.jsonl — task history (empty, populated at runtime)
	writeFileSync(join(saplingDir, SESSION_FILE), "");

	// .gitignore — ignore runtime state
	writeFileSync(join(saplingDir, GITIGNORE_FILE), "*.lock\n");

	// Append .gitattributes entry to project root
	const gitattrsPath = join(cwd, ".gitattributes");
	if (existsSync(gitattrsPath)) {
		const existing = readFileSync(gitattrsPath, "utf8");
		if (!existing.includes(".sapling/session.jsonl")) {
			writeFileSync(gitattrsPath, `${existing}\n${GITATTRIBUTES_ENTRY}`);
		}
	} else {
		writeFileSync(gitattrsPath, GITATTRIBUTES_ENTRY);
	}

	if (jsonMode) {
		printJson("init", { initialized: true, dir: saplingDir });
	} else {
		process.stdout.write(`${colors.green("✓")} Initialized .sapling/ in ${cwd}\n`);
	}
}

export function registerInitCommand(program: Command): void {
	program
		.command("init")
		.description("Initialize .sapling/ project directory in current directory")
		.option("--cwd <path>", "Directory to initialize (default: current directory)")
		.option("--json", "Output as JSON")
		.action(async (opts: { cwd?: string; json?: boolean }) => {
			await runInit(opts.cwd ?? process.cwd(), opts.json ?? false);
		});
}
