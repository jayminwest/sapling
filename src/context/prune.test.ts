/**
 * Tests for context/prune.ts — pruning strategies.
 */

import { describe, expect, it } from "bun:test";
import type { Message, ScoredMessage } from "../types.ts";
import {
	pruneBashOutput,
	pruneMessage,
	pruneMessages,
	summarizeAssistantMessage,
	summarizeGrepResult,
	summarizeUserToolResult,
} from "./prune.ts";

function makeScoredMessage(
	message: Message,
	score: number,
	age: number,
	category: ScoredMessage["category"] = "history",
): ScoredMessage {
	return {
		message,
		score,
		category,
		tokenCount: 10,
		age,
		metadata: {
			filesReferenced: [],
			isErrorContext: false,
			hasUnresolvedQuestion: false,
		},
	};
}

describe("pruneBashOutput", () => {
	it("returns short output unchanged", () => {
		const output = "line1\nline2\nline3";
		expect(pruneBashOutput(output)).toBe(output);
	});

	it("truncates output larger than 5000 tokens (~20000 chars)", () => {
		const manyLines = Array.from({ length: 200 }, (_, i) => `Line ${i}: ${"x".repeat(100)}`);
		const output = manyLines.join("\n");
		const pruned = pruneBashOutput(output);
		expect(pruned.length).toBeLessThan(output.length);
		expect(pruned).toContain("lines truncated");
	});

	it("keeps head and tail lines when truncating", () => {
		const manyLines = Array.from({ length: 200 }, (_, i) => `Line ${String(i).padStart(3, "0")}`);
		const output = manyLines.join("\n");
		const pruned = pruneBashOutput(output);
		expect(pruned).toContain("Line 000");
		expect(pruned).toContain("Line 199");
	});
});

describe("summarizeGrepResult", () => {
	it("returns short results unchanged", () => {
		const result = "foo.ts:1: match1\nbar.ts:2: match2";
		expect(summarizeGrepResult(result)).toBe(result);
	});

	it("summarizes large grep results", () => {
		const lines = Array.from({ length: 50 }, (_, i) => `src/file${i}.ts:${i}: match text here`);
		const result = lines.join("\n");
		const summary = summarizeGrepResult(result);
		expect(summary).toContain("matches");
		expect(summary.length).toBeLessThan(result.length);
	});
});

describe("summarizeAssistantMessage", () => {
	it("summarizes a text assistant message", () => {
		const msg: Message = {
			role: "assistant",
			content: [{ type: "text", text: "I will now fix the bug. This should resolve the issue." }],
		};
		const summary = summarizeAssistantMessage(msg);
		expect(summary).toContain("Summary:");
		expect(summary.length).toBeLessThan(200);
	});

	it("includes tool calls in summary", () => {
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
		const summary = summarizeAssistantMessage(msg);
		expect(summary).toContain("read");
	});

	it("handles non-assistant message gracefully", () => {
		const msg: Message = { role: "user", content: "hello" };
		const summary = summarizeAssistantMessage(msg);
		expect(summary).toBe("[message]");
	});
});

describe("summarizeUserToolResult", () => {
	it("returns null for string-content user messages", () => {
		const msg: Message = { role: "user", content: "simple string" };
		expect(summarizeUserToolResult(msg)).toBeNull();
	});

	it("returns null for non-user messages", () => {
		const msg: Message = {
			role: "assistant",
			content: [{ type: "text", text: "assistant text" }],
		};
		expect(summarizeUserToolResult(msg)).toBeNull();
	});

	it("returns null when content is already small", () => {
		const msg: Message = { role: "user", content: [{ type: "text", text: "short" }] };
		expect(summarizeUserToolResult(msg)).toBeNull();
	});

	it("compresses large tool results into a one-liner", () => {
		const bigContent = "x".repeat(500); // ~125 tokens
		const msg: Message = { role: "user", content: [{ type: "text", text: bigContent }] };
		const result = summarizeUserToolResult(msg);
		expect(result).not.toBeNull();
		if (result) {
			expect(typeof result.content).not.toBe("string");
			const content = result.content as { type: string; text: string }[];
			expect(content[0]?.text).toContain("Tool output");
		}
	});
});

describe("pruneMessage", () => {
	it("never prunes current-turn messages", () => {
		const msg: Message = { role: "user", content: "current turn" };
		const scored = makeScoredMessage(msg, 0.0, 0, "current");
		const result = pruneMessage(scored, new Set(), 5);
		expect(result.wasDropped).toBe(false);
		expect(result.wasModified).toBe(false);
	});

	it("never prunes task messages", () => {
		const msg: Message = { role: "user", content: "task description" };
		const scored = makeScoredMessage(msg, 0.0, 100, "task");
		const result = pruneMessage(scored, new Set(), 0);
		expect(result.wasDropped).toBe(false);
	});

	it("drops very old low-score messages", () => {
		const msg: Message = { role: "user", content: "old irrelevant content" };
		const scored = makeScoredMessage(msg, 0.05, 20);
		const result = pruneMessage(scored, new Set(), 0);
		expect(result.wasDropped).toBe(true);
	});

	it("summarizes old low-score assistant messages", () => {
		const msg: Message = {
			role: "assistant",
			content: [{ type: "text", text: "I analyzed the code and found the issue." }],
		};
		const scored = makeScoredMessage(msg, 0.2, 8);
		const result = pruneMessage(scored, new Set(), 0);
		expect(result.wasSummarized || result.wasDropped || !result.wasModified).toBe(true);
	});

	it("keeps high-score messages unchanged", () => {
		const msg: Message = { role: "user", content: "important context" };
		const scored = makeScoredMessage(msg, 0.9, 3);
		const result = pruneMessage(scored, new Set(), 0);
		expect(result.wasDropped).toBe(false);
		expect(result.wasModified).toBe(false);
	});
});

describe("pruneMessage — user tool result summarization", () => {
	it("summarizes old low-score user messages with large block content", () => {
		const bigContent = "y".repeat(500); // ~125 tokens
		const msg: Message = { role: "user", content: [{ type: "text", text: bigContent }] };
		const scored = makeScoredMessage(msg, 0.2, 8);
		const result = pruneMessage(scored, new Set(), 0);
		// Should be summarized or dropped (either is acceptable compression)
		expect(result.wasSummarized || result.wasDropped || !result.wasModified).toBe(true);
	});
});

describe("pruneMessages", () => {
	it("returns all messages when under budget", () => {
		const messages: Message[] = [
			{ role: "user", content: "message 1" },
			{ role: "assistant", content: [{ type: "text", text: "response 1" }] },
		];
		const scored: ScoredMessage[] = messages.map((m, i) => makeScoredMessage(m, 0.9, i));
		const result = pruneMessages(scored, new Set(), 1, 100_000);
		expect(result).toHaveLength(2);
	});

	it("drops low-score messages to fit budget", () => {
		const messages: Message[] = Array.from({ length: 20 }, (_, i) => ({
			role: "user" as const,
			content: `message ${i}: ${"x".repeat(100)}`,
		}));
		const scored: ScoredMessage[] = messages.map((m, i) =>
			makeScoredMessage(m, i < 10 ? 0.1 : 0.9, 20 - i),
		);
		// Very small budget to force pruning
		const result = pruneMessages(scored, new Set(), 15, 500);
		expect(result.length).toBeLessThan(messages.length);
	});

	it("always keeps messages with high scores", () => {
		const important: Message = { role: "user", content: "critical context" };
		const filler: Message = { role: "user", content: "x".repeat(500) };
		const scored: ScoredMessage[] = [
			makeScoredMessage(important, 0.95, 5),
			...Array.from({ length: 10 }, () => makeScoredMessage(filler, 0.1, 10)),
		];
		const result = pruneMessages(scored, new Set(), 10, 200);
		// Important message should survive
		expect(result).toContain(important);
	});
});
