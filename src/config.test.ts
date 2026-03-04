import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_CONFIG,
	findProjectConfigDir,
	loadConfig,
	loadGuardConfig,
	loadYamlConfigFile,
	parseYamlConfig,
	resolveModelAlias,
	resolveProvider,
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

	it("returns default config with no overrides", async () => {
		const config = await loadConfig();
		expect(config.model).toBe(DEFAULT_CONFIG.model);
	});

	it("applies overrides", async () => {
		const config = await loadConfig({ maxTurns: 10 });
		expect(config.maxTurns).toBe(10);
	});

	it("reads ANTHROPIC_BASE_URL into apiBaseUrl", async () => {
		process.env.ANTHROPIC_BASE_URL = "https://api.minimax.io/anthropic";
		const config = await loadConfig();
		expect(config.apiBaseUrl).toBe("https://api.minimax.io/anthropic");
	});

	it("uses default apiBaseUrl when ANTHROPIC_BASE_URL is not set", async () => {
		const config = await loadConfig();
		expect(config.apiBaseUrl).toBe("https://api.minimax.io/anthropic");
	});

	it("reads ANTHROPIC_API_KEY into apiKey", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-test-primary";
		const config = await loadConfig();
		expect(config.apiKey).toBe("sk-test-primary");
	});

	it("falls back to ANTHROPIC_AUTH_TOKEN when ANTHROPIC_API_KEY is not set", async () => {
		process.env.ANTHROPIC_AUTH_TOKEN = "sk-test-fallback";
		const config = await loadConfig();
		expect(config.apiKey).toBe("sk-test-fallback");
	});

	it("prefers ANTHROPIC_API_KEY over ANTHROPIC_AUTH_TOKEN when both are set", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-test-primary";
		process.env.ANTHROPIC_AUTH_TOKEN = "sk-test-fallback";
		const config = await loadConfig();
		expect(config.apiKey).toBe("sk-test-primary");
	});

	it("leaves apiKey undefined when neither ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN is set", async () => {
		const config = await loadConfig();
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

	it("defaults to sdk backend", async () => {
		const config = await loadConfig();
		expect(config.backend).toBe("sdk");
	});

	it("respects explicit SAPLING_BACKEND=cc override", async () => {
		process.env.SAPLING_BACKEND = "cc";
		const config = await loadConfig();
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

describe("resolveProvider", () => {
	it("maps MiniMax models to minimax provider", () => {
		expect(resolveProvider("MiniMax-M2.5")).toBe("minimax");
		expect(resolveProvider("minimax-text-01")).toBe("minimax");
	});

	it("maps Anthropic models to anthropic provider", () => {
		expect(resolveProvider("claude-sonnet-4-6")).toBe("anthropic");
		expect(resolveProvider("claude-opus-4-6")).toBe("anthropic");
	});

	it("defaults unknown models to anthropic provider", () => {
		expect(resolveProvider("some-other-model")).toBe("anthropic");
	});
});

describe("parseYamlConfig", () => {
	it("parses model field", () => {
		const result = parseYamlConfig("model: claude-opus-4-6\n");
		expect(result.model).toBe("claude-opus-4-6");
	});

	it("parses max_turns as integer", () => {
		const result = parseYamlConfig("max_turns: 50\n");
		expect(result.maxTurns).toBe(50);
	});

	it("parses backend field", () => {
		const result = parseYamlConfig("backend: sdk\n");
		expect(result.backend).toBe("sdk");
	});

	it("parses context_window as integer", () => {
		const result = parseYamlConfig("context_window: 100000\n");
		expect(result.contextWindow).toBe(100000);
	});

	it("parses api_base_url", () => {
		const result = parseYamlConfig("api_base_url: https://example.com\n");
		expect(result.apiBaseUrl).toBe("https://example.com");
	});

	it("parses api_key", () => {
		const result = parseYamlConfig("api_key: sk-test\n");
		expect(result.apiKey).toBe("sk-test");
	});

	it("strips double quotes from string values", () => {
		const result = parseYamlConfig('model: "claude-sonnet-4-6"\n');
		expect(result.model).toBe("claude-sonnet-4-6");
	});

	it("strips single quotes from string values", () => {
		const result = parseYamlConfig("model: 'claude-sonnet-4-6'\n");
		expect(result.model).toBe("claude-sonnet-4-6");
	});

	it("ignores unknown keys silently", () => {
		const result = parseYamlConfig("project: my-app\ncontext_pipeline: v1\n");
		expect(Object.keys(result)).toHaveLength(0);
	});

	it("ignores comment lines", () => {
		const result = parseYamlConfig("# This is a comment\nmodel: claude-opus-4-6\n");
		expect(result.model).toBe("claude-opus-4-6");
	});

	it("ignores empty lines", () => {
		const result = parseYamlConfig("\n\nmodel: claude-opus-4-6\n\n");
		expect(result.model).toBe("claude-opus-4-6");
	});

	it("ignores invalid backend values", () => {
		const result = parseYamlConfig("backend: invalid\n");
		expect(result.backend).toBeUndefined();
	});

	it("ignores non-numeric max_turns", () => {
		const result = parseYamlConfig("max_turns: abc\n");
		expect(result.maxTurns).toBeUndefined();
	});

	it("parses multiple fields together", () => {
		const yaml = [
			"# Sapling project configuration",
			'project: "my-app"',
			"model: claude-sonnet-4-6",
			"max_turns: 100",
			"context_pipeline: v1",
			"",
		].join("\n");
		const result = parseYamlConfig(yaml);
		expect(result.model).toBe("claude-sonnet-4-6");
		expect(result.maxTurns).toBe(100);
		expect((result as Record<string, unknown>).project).toBeUndefined();
	});
});

describe("findProjectConfigDir", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = join(
			tmpdir(),
			`sapling-find-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(tmpDir, { recursive: true });
	});

	it("finds .sapling/config.yaml in given directory", () => {
		const saplingDir = join(tmpDir, ".sapling");
		mkdirSync(saplingDir, { recursive: true });
		writeFileSync(join(saplingDir, "config.yaml"), "model: claude-sonnet-4-6\n");
		const result = findProjectConfigDir(tmpDir);
		expect(result).toBe(saplingDir);
	});

	it("finds .sapling/config.yaml in parent directory", () => {
		const saplingDir = join(tmpDir, ".sapling");
		mkdirSync(saplingDir, { recursive: true });
		writeFileSync(join(saplingDir, "config.yaml"), "model: claude-sonnet-4-6\n");
		const subDir = join(tmpDir, "sub", "deep");
		mkdirSync(subDir, { recursive: true });
		const result = findProjectConfigDir(subDir);
		expect(result).toBe(saplingDir);
	});

	it("returns null when no .sapling/config.yaml is found", () => {
		const result = findProjectConfigDir(tmpDir);
		expect(result).toBeNull();
	});
});

describe("loadYamlConfigFile", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = join(tmpdir(), `sapling-yaml-test-${Date.now()}`);
		mkdirSync(tmpDir, { recursive: true });
	});

	it("returns empty object for missing file", async () => {
		const result = await loadYamlConfigFile(join(tmpDir, "nonexistent.yaml"));
		expect(result).toEqual({});
	});

	it("loads and parses a valid YAML config file", async () => {
		const filePath = join(tmpDir, "config.yaml");
		writeFileSync(filePath, "model: claude-opus-4-6\nmax_turns: 42\n");
		const result = await loadYamlConfigFile(filePath);
		expect(result.model).toBe("claude-opus-4-6");
		expect(result.maxTurns).toBe(42);
	});
});

describe("loadConfig precedence", () => {
	let tmpDir: string;
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
		tmpDir = join(tmpdir(), `sapling-prec-test-${Date.now()}`);
		mkdirSync(tmpDir, { recursive: true });
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

	it("project config overrides env vars", async () => {
		process.env.SAPLING_MODEL = "claude-haiku-4-5-20251001";
		const saplingDir = join(tmpDir, ".sapling");
		mkdirSync(saplingDir, { recursive: true });
		writeFileSync(join(saplingDir, "config.yaml"), "model: claude-opus-4-6\n");
		const config = await loadConfig({ cwd: tmpDir });
		expect(config.model).toBe("claude-opus-4-6");
	});

	it("CLI overrides project config", async () => {
		const saplingDir = join(tmpDir, ".sapling");
		mkdirSync(saplingDir, { recursive: true });
		writeFileSync(join(saplingDir, "config.yaml"), "model: claude-opus-4-6\n");
		const config = await loadConfig({ cwd: tmpDir, model: "claude-haiku-4-5-20251001" });
		expect(config.model).toBe("claude-haiku-4-5-20251001");
	});

	it("env vars override defaults when no project config", async () => {
		process.env.SAPLING_MAX_TURNS = "77";
		const config = await loadConfig({ cwd: tmpDir });
		expect(config.maxTurns).toBe(77);
	});

	it("project config is found by walking up from cwd", async () => {
		const saplingDir = join(tmpDir, ".sapling");
		mkdirSync(saplingDir, { recursive: true });
		writeFileSync(join(saplingDir, "config.yaml"), "max_turns: 55\n");
		const subDir = join(tmpDir, "nested");
		mkdirSync(subDir, { recursive: true });
		const config = await loadConfig({ cwd: subDir });
		expect(config.maxTurns).toBe(55);
	});
});
