/**
 * Tests for context/score.ts — relevance scoring.
 */

import { describe, expect, it } from "bun:test";
import type { Message } from "../types.ts";
import { categorizeMessage, extractFilePaths, scoreMessage, scoreMessages } from "./score.ts";

describe("extractFilePaths", () => {
	it("extracts absolute paths from text content", () => {
		const msg: Message = {
			role: "user",
			content: "I edited /src/foo/bar.ts and /src/baz.ts",
		};
		const paths = extractFilePaths(msg);
		expect(paths.some((p) => p.includes("bar.ts"))).toBe(true);
		expect(paths.some((p) => p.includes("baz.ts"))).toBe(true);
	});

	it("extracts paths from assistant content blocks", () => {
		const msg: Message = {
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id: "t1",
					name: "read",
					input: { file_path: "/src/auth.ts" },
				},
			],
		};
		const paths = extractFilePaths(msg);
		expect(paths.some((p) => p.includes("auth.ts"))).toBe(true);
	});

	it("returns empty array for message with no paths", () => {
		const msg: Message = { role: "user", content: "Hello world!" };
		const paths = extractFilePaths(msg);
		expect(paths).toEqual([]);
	});
});

describe("scoreMessage", () => {
	it("scores recent messages higher than old ones", () => {
		const msg: Message = { role: "user", content: "test content" };
		const recentScore = scoreMessage(msg, 0, [], false, "history");
		const oldScore = scoreMessage(msg, 20, [], false, "history");
		expect(recentScore.score).toBeGreaterThan(oldScore.score);
	});

	it("boosts score for messages referencing active files", () => {
		const msg: Message = {
			role: "user",
			content: "Edited /src/auth.ts with login fix",
		};
		const withFile = scoreMessage(msg, 5, ["/src/auth.ts"], false, "history");
		const noFile = scoreMessage(msg, 5, ["/src/other.ts"], false, "history");
		expect(withFile.score).toBeGreaterThan(noFile.score);
	});

	it("boosts score for error context", () => {
		const msg: Message = { role: "user", content: "test content" };
		const withError = scoreMessage(msg, 5, [], true, "history");
		const noError = scoreMessage(msg, 5, [], false, "history");
		expect(withError.score).toBeGreaterThan(noError.score);
	});

	it("boosts messages containing error keywords", () => {
		const errorMsg: Message = { role: "user", content: "Error: module not found" };
		const normalMsg: Message = { role: "user", content: "Task completed" };
		const errorScore = scoreMessage(errorMsg, 5, [], false, "history");
		const normalScore = scoreMessage(normalMsg, 5, [], false, "history");
		expect(errorScore.score).toBeGreaterThan(normalScore.score);
	});

	it("penalizes very large messages", () => {
		const smallMsg: Message = { role: "user", content: "small" };
		const largeMsg: Message = { role: "user", content: "x".repeat(25_000) }; // ~6250 tokens
		const smallScore = scoreMessage(smallMsg, 5, [], false, "history");
		const largeScore = scoreMessage(largeMsg, 5, [], false, "history");
		expect(smallScore.score).toBeGreaterThan(largeScore.score);
	});

	it("score is between 0 and 1", () => {
		const msg: Message = { role: "user", content: "test" };
		const scored = scoreMessage(msg, 0, [], false, "history");
		expect(scored.score).toBeGreaterThanOrEqual(0);
		expect(scored.score).toBeLessThanOrEqual(1);
	});

	it("populates metadata correctly", () => {
		const msg: Message = {
			role: "assistant",
			content: [{ type: "text", text: "Should I use bcrypt?" }],
		};
		const scored = scoreMessage(msg, 0, [], false, "history");
		expect(scored.metadata.hasUnresolvedQuestion).toBe(true);
	});

	it("boosts score for assistant messages with unresolved questions", () => {
		const questionMsg: Message = {
			role: "assistant",
			content: [{ type: "text", text: "Should we use bcrypt?" }],
		};
		const statementMsg: Message = {
			role: "assistant",
			content: [{ type: "text", text: "I will use bcrypt" }],
		};
		const questionScore = scoreMessage(questionMsg, 5, [], false, "history");
		const statementScore = scoreMessage(statementMsg, 5, [], false, "history");
		expect(questionScore.score).toBeGreaterThan(statementScore.score);
	});
});

describe("categorizeMessage", () => {
	const msg: Message = { role: "user", content: "test" };

	it("marks index 0 as task when currentTurnStart < totalMessages (full array)", () => {
		expect(categorizeMessage(msg, 0, 5, 3)).toBe("task");
	});

	it("marks messages before currentTurnStart as history", () => {
		expect(categorizeMessage(msg, 1, 5, 3)).toBe("history");
		expect(categorizeMessage(msg, 2, 5, 3)).toBe("history");
	});

	it("marks messages at or after currentTurnStart as current", () => {
		expect(categorizeMessage(msg, 3, 5, 3)).toBe("current");
		expect(categorizeMessage(msg, 4, 5, 3)).toBe("current");
	});

	it("marks index 0 as history when currentTurnStart === totalMessages (history slice)", () => {
		// This is the key fix: when scoreMessages is called with a pre-sliced history
		// array, passing currentTurnStart = totalMessages ensures index 0 is "history"
		// not "task" (because currentTurnStart < totalMessages is false).
		expect(categorizeMessage(msg, 0, 3, 3)).toBe("history");
		expect(categorizeMessage(msg, 1, 3, 3)).toBe("history");
		expect(categorizeMessage(msg, 2, 3, 3)).toBe("history");
	});
});

describe("scoreMessages", () => {
	it("scores a list of messages in order", () => {
		const messages: Message[] = [
			{ role: "user", content: "Task: fix the bug" },
			{ role: "assistant", content: [{ type: "text", text: "I will fix it" }] },
			{ role: "user", content: "Error: file not found" },
		];
		const scored = scoreMessages(messages, [], 2);
		expect(scored).toHaveLength(3);
		// All scores should be valid
		for (const s of scored) {
			expect(s.score).toBeGreaterThanOrEqual(0);
			expect(s.score).toBeLessThanOrEqual(1);
		}
	});

	it("boosts last 3 messages when last result was an error", () => {
		const messages: Message[] = [
			{ role: "user", content: "Task: fix it" },
			{ role: "assistant", content: [{ type: "text", text: "Trying this" }] },
			{ role: "user", content: "Error: process failed with exit code 1" },
		];
		const scored = scoreMessages(messages, [], 2);
		// The error message should have a higher score due to error boost
		const errorMsg = scored[2];
		const normalMsg = scored[1];
		expect(errorMsg).toBeDefined();
		expect(normalMsg).toBeDefined();
		if (errorMsg && normalMsg) {
			expect(errorMsg.score).toBeGreaterThan(normalMsg.score);
		}
	});

	it("assigns age correctly (0 = most recent)", () => {
		const messages: Message[] = [
			{ role: "user", content: "first" },
			{ role: "user", content: "second" },
			{ role: "user", content: "third" },
		];
		const scored = scoreMessages(messages, [], 2);
		expect(scored[0]?.age).toBe(2);
		expect(scored[1]?.age).toBe(1);
		expect(scored[2]?.age).toBe(0);
	});

	it("categorizes all messages as history when currentTurnIdx equals array length", () => {
		// Simulates manager.ts calling scoreMessages on a pre-sliced historyMessages array.
		// Passing historyMessages.length as currentTurnIdx must yield category "history"
		// for all messages — including index 0 — so score-based pruning can fire on them.
		const messages: Message[] = [
			{ role: "user", content: "first history message" },
			{ role: "assistant", content: [{ type: "text", text: "second history message" }] },
			{ role: "user", content: "third history message" },
		];
		const scored = scoreMessages(messages, [], messages.length);
		for (const s of scored) {
			expect(s.category).toBe("history");
		}
	});
});
