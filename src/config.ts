/**
 * Configuration loader, defaults, and validation for Sapling.
 */

import { ConfigError } from "./errors.ts";
import type { ContextBudget, LlmBackend, SaplingConfig } from "./types.ts";

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
	backend: "cc",
	maxTurns: 200,
	cwd: process.cwd(),
	verbose: false,
	quiet: false,
	contextWindow: DEFAULT_CONTEXT_WINDOW,
	contextBudget: DEFAULT_BUDGET,
};

const VALID_BACKENDS: LlmBackend[] = ["cc", "sdk"];

export function validateConfig(config: Partial<SaplingConfig>): SaplingConfig {
	const merged: SaplingConfig = { ...DEFAULT_CONFIG, ...config };

	if (merged.maxTurns < 1) {
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

	if (merged.contextWindow < 1000) {
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
 * Load config from environment variables, merging with provided overrides.
 */
export function loadConfig(overrides: Partial<SaplingConfig> = {}): SaplingConfig {
	const fromEnv: Partial<SaplingConfig> = {};

	const envModel = process.env.SAPLING_MODEL;
	if (envModel) fromEnv.model = envModel;

	const envBackend = process.env.SAPLING_BACKEND;
	if (envBackend && VALID_BACKENDS.includes(envBackend as LlmBackend)) {
		fromEnv.backend = envBackend as LlmBackend;
	}

	if (!fromEnv.backend && process.env.CLAUDECODE) {
		fromEnv.backend = "sdk";
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

	return validateConfig({ ...fromEnv, ...overrides });
}
