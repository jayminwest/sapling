/**
 * Config command for sapling CLI.
 * Read and write config at project (.sapling/config.yaml) and global (~/.sapling/config.yaml) levels.
 * Mirrors git config semantics — project-level vs global (home-level).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Command } from "commander";
import { DEFAULT_CONFIG, findProjectConfigDir, parseYamlConfig } from "../config.ts";
import { colors } from "../logging/color.ts";
import type { SaplingConfig } from "../types.ts";

const HOME_SAPLING_DIR = join(homedir(), ".sapling");
const HOME_CONFIG_PATH = join(HOME_SAPLING_DIR, "config.yaml");

/** Accepted user-facing key names (both camelCase and snake_case) → canonical config key */
const ALIAS_TO_KEY: Record<string, string> = {
	model: "model",
	backend: "backend",
	maxTurns: "maxTurns",
	max_turns: "maxTurns",
	contextWindow: "contextWindow",
	context_window: "contextWindow",
	baseUrl: "baseUrl",
	base_url: "baseUrl",
	api_base_url: "baseUrl",
};

/** Canonical config keys in display order */
const ALL_KEYS = ["model", "backend", "maxTurns", "contextWindow", "baseUrl"] as const;
type ConfigKey = (typeof ALL_KEYS)[number];

/** Canonical config key → YAML file key */
const KEY_TO_YAML: Record<ConfigKey, string> = {
	model: "model",
	backend: "backend",
	maxTurns: "max_turns",
	contextWindow: "context_window",
	baseUrl: "api_base_url",
};

/** Canonical config key → SaplingConfig field */
const KEY_TO_CONFIG_FIELD: Record<ConfigKey, keyof SaplingConfig> = {
	model: "model",
	backend: "backend",
	maxTurns: "maxTurns",
	contextWindow: "contextWindow",
	baseUrl: "apiBaseUrl",
};

/** Canonical config key → env var name */
const KEY_TO_ENV: Record<ConfigKey, string> = {
	model: "SAPLING_MODEL",
	backend: "SAPLING_BACKEND",
	maxTurns: "SAPLING_MAX_TURNS",
	contextWindow: "SAPLING_CONTEXT_WINDOW",
	baseUrl: "ANTHROPIC_BASE_URL",
};

type ConfigSource = "project" | "env" | "home" | "default";

interface ConfigEntry {
	key: ConfigKey;
	yamlKey: string;
	value: string;
	source: ConfigSource;
}

function resolveKey(input: string): string | null {
	return ALIAS_TO_KEY[input] ?? null;
}

function getDefaultValue(key: ConfigKey): string {
	switch (key) {
		case "model":
			return DEFAULT_CONFIG.model;
		case "backend":
			return DEFAULT_CONFIG.backend;
		case "maxTurns":
			return String(DEFAULT_CONFIG.maxTurns);
		case "contextWindow":
			return String(DEFAULT_CONFIG.contextWindow);
		case "baseUrl":
			return DEFAULT_CONFIG.apiBaseUrl ?? "";
	}
}

/** Read YAML config file and return parsed partial SaplingConfig. Returns {} if not found. */
function readYamlConfig(filePath: string): Partial<SaplingConfig> {
	if (!existsSync(filePath)) return {};
	const raw = readFileSync(filePath, "utf-8");
	return parseYamlConfig(raw);
}

/** Write or update a single YAML key=value in a config file. Creates file if needed. */
function writeYamlKey(filePath: string, yamlKey: string, value: string): void {
	const dir = filePath.substring(0, filePath.lastIndexOf("/"));
	if (dir && !existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	if (!existsSync(filePath)) {
		writeFileSync(filePath, `# Sapling configuration\n${yamlKey}: ${value}\n`);
		return;
	}

	const raw = readFileSync(filePath, "utf-8");
	const lines = raw.split("\n");
	let found = false;

	const updated = lines.map((line) => {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) return line;
		const colonIdx = trimmed.indexOf(":");
		if (colonIdx < 0) return line;
		const k = trimmed.slice(0, colonIdx).trim();
		if (k === yamlKey) {
			found = true;
			return `${yamlKey}: ${value}`;
		}
		return line;
	});

	if (!found) {
		// Append before trailing newline if present
		const last = updated[updated.length - 1];
		if (last === "") {
			updated.splice(updated.length - 1, 0, `${yamlKey}: ${value}`);
		} else {
			updated.push(`${yamlKey}: ${value}`);
		}
	}

	writeFileSync(filePath, updated.join("\n"));
}

/** Resolve effective value and source for a single config key */
function resolveEntry(
	key: ConfigKey,
	projectConfig: Partial<SaplingConfig>,
	homeConfig: Partial<SaplingConfig>,
): ConfigEntry {
	const configField = KEY_TO_CONFIG_FIELD[key];
	const yamlKey = KEY_TO_YAML[key];

	// Project config has highest file-based precedence
	if (configField in projectConfig && projectConfig[configField] !== undefined) {
		return { key, yamlKey, value: String(projectConfig[configField]), source: "project" };
	}

	// Env vars override home config
	const envValue = process.env[KEY_TO_ENV[key]];
	if (envValue !== undefined && envValue !== "") {
		return { key, yamlKey, value: envValue, source: "env" };
	}

	// Home config
	if (configField in homeConfig && homeConfig[configField] !== undefined) {
		return { key, yamlKey, value: String(homeConfig[configField]), source: "home" };
	}

	// Default
	return { key, yamlKey, value: getDefaultValue(key), source: "default" };
}

function sourceLabel(source: ConfigSource): string {
	switch (source) {
		case "project":
			return colors.green("project");
		case "env":
			return colors.cyan("env");
		case "home":
			return colors.yellow("home");
		case "default":
			return colors.dim("default");
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Subcommand handlers
// ──────────────────────────────────────────────────────────────────────────────

export function runConfigGet(keyInput: string, cwd: string): void {
	const key = resolveKey(keyInput);
	if (!key) {
		process.stderr.write(
			`Error: unknown config key "${keyInput}". Supported: ${Object.keys(ALIAS_TO_KEY)
				.filter((k) => k === ALIAS_TO_KEY[k])
				.join(", ")}\n`,
		);
		process.exitCode = 1;
		return;
	}

	const projectConfigDir = findProjectConfigDir(cwd);
	const projectConfig = projectConfigDir
		? readYamlConfig(join(projectConfigDir, "config.yaml"))
		: {};
	const homeConfig = readYamlConfig(HOME_CONFIG_PATH);

	const entry = resolveEntry(key as ConfigKey, projectConfig, homeConfig);
	process.stdout.write(`${entry.value}\t[${sourceLabel(entry.source)}]\n`);
}

export function runConfigSet(
	keyInput: string,
	value: string,
	opts: { global?: boolean; cwd: string },
): void {
	const key = resolveKey(keyInput);
	if (!key) {
		process.stderr.write(
			`Error: unknown config key "${keyInput}". Supported: ${Object.keys(ALIAS_TO_KEY)
				.filter((k) => k === ALIAS_TO_KEY[k])
				.join(", ")}\n`,
		);
		process.exitCode = 1;
		return;
	}

	const yamlKey = KEY_TO_YAML[key as ConfigKey];

	if (opts.global) {
		writeYamlKey(HOME_CONFIG_PATH, yamlKey, value);
		process.stdout.write(`${colors.green("✓")} Set ${yamlKey}: ${value} in ${HOME_CONFIG_PATH}\n`);
		return;
	}

	// Project-level: find or create .sapling/config.yaml
	const projectConfigDir = findProjectConfigDir(opts.cwd);
	if (projectConfigDir) {
		const configPath = join(projectConfigDir, "config.yaml");
		writeYamlKey(configPath, yamlKey, value);
		process.stdout.write(`${colors.green("✓")} Set ${yamlKey}: ${value} in ${configPath}\n`);
	} else {
		// Create .sapling/config.yaml in cwd
		const saplingDir = join(opts.cwd, ".sapling");
		const configPath = join(saplingDir, "config.yaml");
		writeYamlKey(configPath, yamlKey, value);
		process.stdout.write(`${colors.green("✓")} Set ${yamlKey}: ${value} in ${configPath}\n`);
	}
}

export function runConfigList(cwd: string): void {
	const projectConfigDir = findProjectConfigDir(cwd);
	const projectConfig = projectConfigDir
		? readYamlConfig(join(projectConfigDir, "config.yaml"))
		: {};
	const homeConfig = readYamlConfig(HOME_CONFIG_PATH);

	const entries = ALL_KEYS.map((key) => resolveEntry(key, projectConfig, homeConfig));
	const maxKeyLen = Math.max(...entries.map((e) => e.key.length));

	for (const entry of entries) {
		const padded = entry.key.padEnd(maxKeyLen);
		process.stdout.write(
			`${colors.bold(padded)}  ${entry.value}\t[${sourceLabel(entry.source)}]\n`,
		);
	}
}

export function runConfigInit(cwd: string): void {
	const saplingDir = join(cwd, ".sapling");
	const configPath = join(saplingDir, "config.yaml");

	if (existsSync(configPath)) {
		process.stdout.write(`${colors.dim(`Already initialized: ${configPath}`)}\n`);
		return;
	}

	mkdirSync(saplingDir, { recursive: true });
	const projectName = basename(cwd);
	writeFileSync(
		configPath,
		[
			`# Sapling project configuration`,
			`project: "${projectName}"`,
			`model: ${DEFAULT_CONFIG.model}`,
			`backend: ${DEFAULT_CONFIG.backend}`,
			`max_turns: ${DEFAULT_CONFIG.maxTurns}`,
			``,
		].join("\n"),
	);

	process.stdout.write(`${colors.green("✓")} Created ${configPath}\n`);
}

// ──────────────────────────────────────────────────────────────────────────────
// Registration
// ──────────────────────────────────────────────────────────────────────────────

export function registerConfigCommand(program: Command): void {
	const config = program.command("config").description("Read and write sapling configuration");

	config
		.command("get <key>")
		.description("Show effective value for a config key (with source)")
		.option("--cwd <path>", "Working directory", ".")
		.action((key: string, opts: { cwd: string }) => {
			runConfigGet(key, opts.cwd ?? process.cwd());
		});

	config
		.command("set <key> <value>")
		.description("Write a config value (project-level by default)")
		.option("--global", "Write to ~/.sapling/config.yaml instead of project config")
		.option("--cwd <path>", "Working directory", ".")
		.action((key: string, value: string, opts: { global?: boolean; cwd: string }) => {
			runConfigSet(key, value, { global: opts.global, cwd: opts.cwd ?? process.cwd() });
		});

	config
		.command("list")
		.description("Show all config keys with effective values and sources")
		.option("--cwd <path>", "Working directory", ".")
		.action((opts: { cwd: string }) => {
			runConfigList(opts.cwd ?? process.cwd());
		});

	config
		.command("init")
		.description("Create .sapling/config.yaml with defaults in current directory")
		.option("--cwd <path>", "Directory to initialize (default: current directory)")
		.action((opts: { cwd?: string }) => {
			runConfigInit(opts.cwd ?? process.cwd());
		});
}
