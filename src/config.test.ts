import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_CONFIG,
	loadConfig,
	loadGuardConfig,
	resolveModelAlias,
	validateConfig,
} from "./config.ts";
import { ConfigError } from "./errors.ts";

describe("validateConfig", () => {
	it("returns merged config with defaults", () => {
		const config = validateConfig({});
		expect(config.model).toBe(DEFAULT_CONFIG.model);
		expect(config.backend).toBe("sdk");
		expect(config.maxTurns).toBe(200);
	});

	it("applies overrides", () => {
		const config = validateConfig({ model: "claude-opus-4-6", maxTurns: 50 });
		expect(config.model).toBe("claude-opus-4-6");
		expect(config.maxTurns).toBe(50);
	});

	it("throws ConfigError for maxTurns < 1", () => {
		expect(() => validateConfig({ maxTurns: 0 })).toThrow(ConfigError);
	});

	it("throws ConfigError for maxTurns NaN", () => {
		expect(() => validateConfig({ maxTurns: NaN })).toThrow(ConfigError);
	});

	it("throws ConfigError for maxTurns Infinity", () => {
		expect(() => validateConfig({ maxTurns: Infinity })).toThrow(ConfigError);
	});

	it("throws ConfigError for invalid backend", () => {
		expect(() => validateConfig({ backend: "invalid" as "cc" })).toThrow(ConfigError);
	});

	it("throws ConfigError for contextWindow < 1000", () => {
		expect(() => validateConfig({ contextWindow: 500 })).toThrow(ConfigError);
	});

	it("throws ConfigError for contextWindow NaN", () => {
		expect(() => validateConfig({ contextWindow: NaN })).toThrow(ConfigError);
	});

	it("throws ConfigError for contextWindow Infinity", () => {
		expect(() => validateConfig({ contextWindow: Infinity })).toThrow(ConfigError);
	});

	it("throws ConfigError when budget allocations exceed 1.0", () => {
		expect(() =>
			validateConfig({
				contextBudget: {
					windowSize: 200_000,
					allocations: {
						systemPrompt: 0.5,
						archiveSummary: 0.5,
						recentHistory: 0.5,
						currentTurn: 0.5,
						headroom: 0.5,
					},
				},
			}),
		).toThrow(ConfigError);
	});
});

describe("loadConfig", () => {
	const ENV_KEYS = [
		"SAPLING_MODEL",
		"SAPLING_BACKEND",
		"SAPLING_MAX_TURNS",
		"SAPLING_CONTEXT_WINDOW",
		"ANTHROPIC_BASE_URL",
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_AUTH_TOKEN",
	] as const;
	let savedEnv: Record<string, string | undefined>;

	beforeEach(() => {
		savedEnv = {};
		for (const key of ENV_KEYS) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = savedEnv[key];
			}
		}
	});

	it("returns default config with no overrides", () => {
		const config = loadConfig();
		expect(config.model).toBe(DEFAULT_CONFIG.model);
	});

	it("applies overrides", () => {
		const config = loadConfig({ maxTurns: 10 });
		expect(config.maxTurns).toBe(10);
	});

	it("reads ANTHROPIC_BASE_URL into apiBaseUrl", () => {
		process.env.ANTHROPIC_BASE_URL = "https://api.minimax.io/anthropic";
		const config = loadConfig();
		expect(config.apiBaseUrl).toBe("https://api.minimax.io/anthropic");
	});

	it("leaves apiBaseUrl undefined when ANTHROPIC_BASE_URL is not set", () => {
		const config = loadConfig();
		expect(config.apiBaseUrl).toBeUndefined();
	});

	it("reads ANTHROPIC_API_KEY into apiKey", () => {
		process.env.ANTHROPIC_API_KEY = "sk-test-primary";
		const config = loadConfig();
		expect(config.apiKey).toBe("sk-test-primary");
	});

	it("falls back to ANTHROPIC_AUTH_TOKEN when ANTHROPIC_API_KEY is not set", () => {
		process.env.ANTHROPIC_AUTH_TOKEN = "sk-test-fallback";
		const config = loadConfig();
		expect(config.apiKey).toBe("sk-test-fallback");
	});

	it("prefers ANTHROPIC_API_KEY over ANTHROPIC_AUTH_TOKEN when both are set", () => {
		process.env.ANTHROPIC_API_KEY = "sk-test-primary";
		process.env.ANTHROPIC_AUTH_TOKEN = "sk-test-fallback";
		const config = loadConfig();
		expect(config.apiKey).toBe("sk-test-primary");
	});

	it("leaves apiKey undefined when neither ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN is set", () => {
		const config = loadConfig();
		expect(config.apiKey).toBeUndefined();
	});
});

describe("loadGuardConfig", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = join(tmpdir(), `sapling-guards-test-${Date.now()}`);
		mkdirSync(tmpDir, { recursive: true });
	});

	it("returns null when file does not exist (standalone mode)", async () => {
		const result = await loadGuardConfig(join(tmpDir, "nonexistent.json"));
		expect(result).toBeNull();
	});

	it("parses valid guard config", async () => {
		const filePath = join(tmpDir, "guards.json");
		writeFileSync(
			filePath,
			JSON.stringify({ version: "1", rules: [{ event: "pre_tool_call", action: "allow" }] }),
		);
		const result = await loadGuardConfig(filePath);
		expect(result).not.toBeNull();
		expect(result?.rules).toHaveLength(1);
		const firstRule = result?.rules[0];
		expect(firstRule?.action).toBe("allow");
	});

	it("throws ConfigError for invalid JSON", async () => {
		const filePath = join(tmpDir, "bad.json");
		writeFileSync(filePath, "not json {{{");
		await expect(loadGuardConfig(filePath)).rejects.toThrow(ConfigError);
	});

	it("throws ConfigError when rules field is missing", async () => {
		const filePath = join(tmpDir, "no-rules.json");
		writeFileSync(filePath, JSON.stringify({ version: "1" }));
		await expect(loadGuardConfig(filePath)).rejects.toThrow(ConfigError);
	});

	it("throws ConfigError when rules is not an array", async () => {
		const filePath = join(tmpDir, "bad-rules.json");
		writeFileSync(filePath, JSON.stringify({ rules: "not-an-array" }));
		await expect(loadGuardConfig(filePath)).rejects.toThrow(ConfigError);
	});

	it("preserves eventConfig from guards file", async () => {
		const filePath = join(tmpDir, "guards-events.json");
		writeFileSync(
			filePath,
			JSON.stringify({
				rules: [],
				eventConfig: {
					onToolStart: ["node", "hook.js", "tool-start"],
					onToolEnd: ["node", "hook.js", "tool-end"],
					onSessionEnd: ["node", "hook.js", "session-end"],
				},
			}),
		);
		const result = await loadGuardConfig(filePath);
		expect(result).not.toBeNull();
		expect(result?.eventConfig?.onToolStart).toEqual(["node", "hook.js", "tool-start"]);
		expect(result?.eventConfig?.onToolEnd).toEqual(["node", "hook.js", "tool-end"]);
		expect(result?.eventConfig?.onSessionEnd).toEqual(["node", "hook.js", "session-end"]);
	});

	it("works without eventConfig (backwards compatible)", async () => {
		const filePath = join(tmpDir, "guards-no-events.json");
		writeFileSync(filePath, JSON.stringify({ rules: [] }));
		const result = await loadGuardConfig(filePath);
		expect(result).not.toBeNull();
		expect(result?.eventConfig).toBeUndefined();
	});
});

describe("loadConfig backend defaults", () => {
	let savedEnv: Record<string, string | undefined>;

	beforeEach(() => {
		savedEnv = {
			SAPLING_BACKEND: process.env.SAPLING_BACKEND,
		};
		delete process.env.SAPLING_BACKEND;
	});

	afterEach(() => {
		if (savedEnv.SAPLING_BACKEND === undefined) {
			delete process.env.SAPLING_BACKEND;
		} else {
			process.env.SAPLING_BACKEND = savedEnv.SAPLING_BACKEND;
		}
	});

	it("defaults to sdk backend", () => {
		const config = loadConfig();
		expect(config.backend).toBe("sdk");
	});

	it("respects explicit SAPLING_BACKEND=cc override", () => {
		process.env.SAPLING_BACKEND = "cc";
		const config = loadConfig();
		expect(config.backend).toBe("cc");
	});
});

describe("resolveModelAlias", () => {
	const ALIAS_KEYS = [
		"ANTHROPIC_DEFAULT_SONNET_MODEL",
		"ANTHROPIC_DEFAULT_HAIKU_MODEL",
		"ANTHROPIC_DEFAULT_OPUS_MODEL",
	] as const;
	let savedEnv: Record<string, string | undefined>;

	beforeEach(() => {
		savedEnv = {};
		for (const key of ALIAS_KEYS) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const key of ALIAS_KEYS) {
			if (savedEnv[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = savedEnv[key];
			}
		}
	});

	it("resolves 'sonnet' alias via ANTHROPIC_DEFAULT_SONNET_MODEL", () => {
		process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = "claude-sonnet-4-6-20251201";
		expect(resolveModelAlias("sonnet")).toBe("claude-sonnet-4-6-20251201");
	});

	it("resolves 'haiku' alias via ANTHROPIC_DEFAULT_HAIKU_MODEL", () => {
		process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = "claude-haiku-4-5-20251001";
		expect(resolveModelAlias("haiku")).toBe("claude-haiku-4-5-20251001");
	});

	it("leaves full model name unchanged when no matching env var", () => {
		expect(resolveModelAlias("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
	});

	it("returns original alias when no env var is set", () => {
		expect(resolveModelAlias("sonnet")).toBe("sonnet");
	});

	it("resolves alias in validateConfig via env var", () => {
		process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = "claude-sonnet-4-6-20251201";
		const config = validateConfig({ model: "sonnet" });
		expect(config.model).toBe("claude-sonnet-4-6-20251201");
	});
});
