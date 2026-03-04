/**
 * Configuration loader, defaults, and validation for Sapling.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readAuthStore } from "./commands/auth.ts";
import { ConfigError } from "./errors.ts";
import type { ContextBudget, GuardConfig, LlmBackend, SaplingConfig } from "./types.ts";

const DEFAULT_CONTEXT_WINDOW = 200_000;

const DEFAULT_BUDGET: ContextBudget = {
	windowSize: DEFAULT_CONTEXT_WINDOW,
	allocations: {
		systemPrompt: 0.15,
		archiveSummary: 0.1,
		recentHistory: 0.4,
		currentTurn: 0.15,
		headroom: 0.2,
	},
};

export const DEFAULT_CONFIG: SaplingConfig = {
	model: "claude-sonnet-4-6",
	backend: "sdk",
	maxTurns: 200,
	cwd: process.cwd(),
	verbose: false,
	quiet: false,
	json: false,
	contextWindow: DEFAULT_CONTEXT_WINDOW,
	contextBudget: DEFAULT_BUDGET,
};

const VALID_BACKENDS: LlmBackend[] = ["cc", "pi", "sdk"];

/** Known provider base URLs for Anthropic-compatible APIs. */
const PROVIDER_BASE_URLS: Record<string, string> = {
	minimax: "https://api.minimax.io/anthropic",
};

/**
 * Resolve which auth provider to use based on the model name.
 * Models starting with "MiniMax" map to the "minimax" provider;
 * everything else maps to "anthropic".
 */
export function resolveProvider(model: string): string {
	if (model.toLowerCase().startsWith("minimax")) return "minimax";
	return "anthropic";
}

/**
 * Resolve a short model alias (e.g. "sonnet", "haiku", "opus") via the
 * ANTHROPIC_DEFAULT_{ALIAS}_MODEL env var. Full model names are returned unchanged.
 */
export function resolveModelAlias(model: string): string {
	const upper = model.toUpperCase();
	const envKey = `ANTHROPIC_DEFAULT_${upper}_MODEL`;
	return process.env[envKey] ?? model;
}

export function validateConfig(config: Partial<SaplingConfig>): SaplingConfig {
	const merged: SaplingConfig = { ...DEFAULT_CONFIG, ...config };
	merged.model = resolveModelAlias(merged.model);

	if (Number.isNaN(merged.maxTurns) || !Number.isFinite(merged.maxTurns) || merged.maxTurns < 1) {
		throw new ConfigError(
			`maxTurns must be >= 1, got ${merged.maxTurns}`,
			"CONFIG_INVALID_MAX_TURNS",
		);
	}

	if (!VALID_BACKENDS.includes(merged.backend)) {
		throw new ConfigError(
			`backend must be one of [${VALID_BACKENDS.join(", ")}], got "${merged.backend}"`,
			"CONFIG_INVALID_BACKEND",
		);
	}

	if (
		Number.isNaN(merged.contextWindow) ||
		!Number.isFinite(merged.contextWindow) ||
		merged.contextWindow < 1000
	) {
		throw new ConfigError(
			`contextWindow must be >= 1000, got ${merged.contextWindow}`,
			"CONFIG_INVALID_CONTEXT_WINDOW",
		);
	}

	const allocSum = Object.values(merged.contextBudget.allocations).reduce((a, b) => a + b, 0);
	if (allocSum > 1.0 + Number.EPSILON) {
		throw new ConfigError(
			`contextBudget allocations must sum to <= 1.0, got ${allocSum.toFixed(4)}`,
			"CONFIG_INVALID_BUDGET_ALLOCATIONS",
		);
	}

	return merged;
}

/**
 * Load guard config from a JSON file.
 * Returns null if file does not exist (standalone mode — no error).
 * Throws ConfigError if file exists but is invalid JSON or missing required fields.
 */
export async function loadGuardConfig(filePath: string): Promise<GuardConfig | null> {
	const resolved = resolve(filePath);
	if (!existsSync(resolved)) {
		return null;
	}
	let raw: string;
	try {
		raw = await readFile(resolved, "utf-8");
	} catch (_err) {
		throw new ConfigError(`Failed to read guards file: ${resolved}`, "CONFIG_FILE_NOT_FOUND");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new ConfigError(`Guards file is not valid JSON: ${resolved}`, "CONFIG_INVALID_GUARDS");
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("rules" in parsed) ||
		!Array.isArray((parsed as Record<string, unknown>).rules)
	) {
		throw new ConfigError(
			`Guards file must have a "rules" array: ${resolved}`,
			"CONFIG_INVALID_GUARDS",
		);
	}
	return parsed as GuardConfig;
}

/**
 * Load config from environment variables and auth store, merging with provided overrides.
 * Auth store (~/.sapling/auth.json) is used as a fallback when env vars are not set.
 */
export async function loadConfig(overrides: Partial<SaplingConfig> = {}): Promise<SaplingConfig> {
	const fromEnv: Partial<SaplingConfig> = {};

	const envModel = process.env.SAPLING_MODEL;
	if (envModel) fromEnv.model = envModel;

	const envBackend = process.env.SAPLING_BACKEND;
	if (envBackend && VALID_BACKENDS.includes(envBackend as LlmBackend)) {
		fromEnv.backend = envBackend as LlmBackend;
	}

	const envMaxTurns = process.env.SAPLING_MAX_TURNS;
	if (envMaxTurns) {
		const n = parseInt(envMaxTurns, 10);
		if (!Number.isNaN(n)) fromEnv.maxTurns = n;
	}

	const envContextWindow = process.env.SAPLING_CONTEXT_WINDOW;
	if (envContextWindow) {
		const n = parseInt(envContextWindow, 10);
		if (!Number.isNaN(n)) fromEnv.contextWindow = n;
	}

	const envBaseUrl = process.env.ANTHROPIC_BASE_URL;
	if (envBaseUrl) fromEnv.apiBaseUrl = envBaseUrl;

	// ANTHROPIC_API_KEY is the canonical env var; ANTHROPIC_AUTH_TOKEN is a fallback alias.
	const envApiKey = process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN;
	if (envApiKey) fromEnv.apiKey = envApiKey;

	// Fall back to auth store when env vars don't provide credentials.
	if (!fromEnv.apiKey) {
		const model = overrides.model ?? fromEnv.model ?? DEFAULT_CONFIG.model;
		const provider = resolveProvider(model);
		const store = await readAuthStore();
		const creds = store.providers[provider];
		if (creds) {
			fromEnv.apiKey = creds.apiKey;
			if (!fromEnv.apiBaseUrl) {
				fromEnv.apiBaseUrl = creds.baseUrl ?? PROVIDER_BASE_URLS[provider];
			}
		}
	}

	return validateConfig({ ...fromEnv, ...overrides });
}
