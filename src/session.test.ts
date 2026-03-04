import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendSessionRecord, summarizePrompt } from "./session.ts";
import { cleanupTempDir, createTempDir } from "./test-helpers.ts";
import type { SessionRecord } from "./types.ts";

// ─── summarizePrompt ──────────────────────────────────────────────────────────

describe("summarizePrompt", () => {
	it("returns input unchanged when <= 200 chars", () => {
		const prompt = "Fix the authentication bug in login flow";
		expect(summarizePrompt(prompt)).toBe(prompt);
	});

	it("truncates long prompts to 200 chars with '...' suffix", () => {
		const prompt = "x".repeat(250);
		const result = summarizePrompt(prompt);
		expect(result).toBe(`${"x".repeat(200)}...`);
		expect(result.length).toBe(203);
	});

	it("collapses newlines to spaces", () => {
		const prompt = "Fix the bug\nin login\nflow";
		expect(summarizePrompt(prompt)).toBe("Fix the bug in login flow");
	});

	it("collapses multiple consecutive newlines to a single space", () => {
		const prompt = "Fix\n\n\nthe bug";
		expect(summarizePrompt(prompt)).toBe("Fix the bug");
	});

	it("trims leading and trailing whitespace", () => {
		const prompt = "  fix the bug  ";
		expect(summarizePrompt(prompt)).toBe("fix the bug");
	});

	it("truncates after collapsing newlines", () => {
		// Build a 201-char string after collapsing newlines
		const prompt = "a".repeat(100) + "\n" + "b".repeat(100);
		const result = summarizePrompt(prompt);
		expect(result).toBe(`${"a".repeat(100)} ${"b".repeat(99)}...`);
	});
});

// ─── appendSessionRecord ─────────────────────────────────────────────────────

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
	return {
		timestamp: "2026-03-04T20:00:00.000Z",
		promptSummary: "Fix the bug",
		filesModified: [],
		tokenUsage: { input: 100, output: 50, cacheRead: 0, cacheCreation: 0 },
		durationMs: 1234,
		model: "claude-sonnet-4-6",
		exitReason: "task_complete",
		totalTurns: 3,
		...overrides,
	};
}

describe("appendSessionRecord", () => {
	it("writes a valid JSONL line to session file", async () => {
		const dir = await createTempDir();
		try {
			const saplingDir = join(dir, ".sapling");
			mkdirSync(saplingDir);
			const sessionFile = join(saplingDir, "session.jsonl");

			const record = makeRecord();
			appendSessionRecord(dir, record);

			const content = readFileSync(sessionFile, "utf8");
			const lines = content.trim().split("\n");
			expect(lines).toHaveLength(1);
			const parsed = JSON.parse(lines[0] as string);
			expect(parsed.timestamp).toBe(record.timestamp);
			expect(parsed.promptSummary).toBe(record.promptSummary);
			expect(parsed.exitReason).toBe(record.exitReason);
			expect(parsed.totalTurns).toBe(record.totalTurns);
			expect(parsed.model).toBe(record.model);
			expect(parsed.tokenUsage.input).toBe(100);
		} finally {
			await cleanupTempDir(dir);
		}
	});

	it("appends (not overwrites) on multiple calls", async () => {
		const dir = await createTempDir();
		try {
			const saplingDir = join(dir, ".sapling");
			mkdirSync(saplingDir);

			appendSessionRecord(dir, makeRecord({ totalTurns: 1 }));
			appendSessionRecord(dir, makeRecord({ totalTurns: 2 }));
			appendSessionRecord(dir, makeRecord({ totalTurns: 3 }));

			const content = readFileSync(join(saplingDir, "session.jsonl"), "utf8");
			const lines = content.trim().split("\n");
			expect(lines).toHaveLength(3);
			expect(JSON.parse(lines[0] as string).totalTurns).toBe(1);
			expect(JSON.parse(lines[1] as string).totalTurns).toBe(2);
			expect(JSON.parse(lines[2] as string).totalTurns).toBe(3);
		} finally {
			await cleanupTempDir(dir);
		}
	});

	it("silently no-ops when .sapling/ dir does not exist", async () => {
		const dir = await createTempDir();
		try {
			// Do NOT create .sapling/ dir
			appendSessionRecord(dir, makeRecord());
			// No session file created
			expect(existsSync(join(dir, ".sapling", "session.jsonl"))).toBe(false);
		} finally {
			await cleanupTempDir(dir);
		}
	});

	it("creates session.jsonl if .sapling/ dir exists but file doesn't", async () => {
		const dir = await createTempDir();
		try {
			const saplingDir = join(dir, ".sapling");
			mkdirSync(saplingDir);
			// Don't create session.jsonl — appendFileSync creates it

			appendSessionRecord(dir, makeRecord());

			expect(existsSync(join(saplingDir, "session.jsonl"))).toBe(true);
			const content = readFileSync(join(saplingDir, "session.jsonl"), "utf8");
			expect(content.trim()).not.toBe("");
		} finally {
			await cleanupTempDir(dir);
		}
	});
});
