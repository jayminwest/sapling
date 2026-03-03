import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { runCommand } from "./cli.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { ConfigError } from "./errors.ts";

describe("runCommand cwd validation", () => {
	it("throws ConfigError with code CONFIG_INVALID_CWD for nonexistent cwd", async () => {
		const config = { ...DEFAULT_CONFIG, cwd: "/nonexistent/path/that/does/not/exist" };

		await expect(runCommand("test", {}, config)).rejects.toThrow(ConfigError);

		try {
			await runCommand("test", {}, config);
		} catch (err) {
			expect(err).toBeInstanceOf(ConfigError);
			expect((err as ConfigError).code).toBe("CONFIG_INVALID_CWD");
			expect((err as ConfigError).message).toContain("/nonexistent/path/that/does/not/exist");
		}
	});
});

describe("runCommand system-prompt-file error handling", () => {
	it("throws ConfigError with code CONFIG_FILE_NOT_FOUND for missing system prompt file", async () => {
		const missingPath = join(import.meta.dir, "__nonexistent_file__.md");
		const opts = { systemPromptFile: missingPath };
		const config = { ...DEFAULT_CONFIG };

		await expect(runCommand("test task", opts, config)).rejects.toThrow(ConfigError);

		try {
			await runCommand("test task", opts, config);
		} catch (err) {
			expect(err).toBeInstanceOf(ConfigError);
			expect((err as ConfigError).code).toBe("CONFIG_FILE_NOT_FOUND");
			expect((err as ConfigError).message).toContain(missingPath);
		}
	});
});
