/**
 * Tests for context/reshape.ts — message array reconstruction.
 */

import { describe, expect, it } from "bun:test";
import type { ContextArchive, Message } from "../types.ts";
import { createArchive } from "./archive.ts";
import { findCurrentTurnStart, reshapeMessages, splitMessageSegments } from "./reshape.ts";

function makeUserMsg(content: string): Message {
	return { role: "user", content };
}

function makeAssistantMsg(text: string): Message {
	return { role: "assistant", content: [{ type: "text", text }] };
}

describe("findCurrentTurnStart", () => {
	it("returns 0 for empty messages", () => {
		expect(findCurrentTurnStart([])).toBe(0);
	});

	it("returns messages.length when no assistant messages", () => {
		const msgs: Message[] = [makeUserMsg("task"), makeUserMsg("tool result")];
		expect(findCurrentTurnStart(msgs)).toBe(2);
	});

	it("returns index of last assistant message", () => {
		const msgs: Message[] = [
			makeUserMsg("task"),
			makeAssistantMsg("first response"),
			makeUserMsg("tool result"),
			makeAssistantMsg("second response"),
			makeUserMsg("another tool result"),
		];
		// Last assistant message is at index 3
		expect(findCurrentTurnStart(msgs)).toBe(3);
	});

	it("returns index of sole assistant message", () => {
		const msgs: Message[] = [makeUserMsg("task"), makeAssistantMsg("response")];
		expect(findCurrentTurnStart(msgs)).toBe(1);
	});
});

describe("splitMessageSegments", () => {
	it("handles empty messages", () => {
		const result = splitMessageSegments([], 0);
		expect(result.taskMessage).toBeNull();
		expect(result.historyMessages).toHaveLength(0);
		expect(result.currentMessages).toHaveLength(0);
	});

	it("assigns first message as task", () => {
		const task = makeUserMsg("Do this task");
		const result = splitMessageSegments([task], 1);
		expect(result.taskMessage).toBe(task);
	});

	it("splits history and current correctly", () => {
		const task = makeUserMsg("task");
		const hist1 = makeAssistantMsg("old response");
		const hist2 = makeUserMsg("old tool result");
		const curr1 = makeAssistantMsg("current response");
		const curr2 = makeUserMsg("current tool result");

		const msgs = [task, hist1, hist2, curr1, curr2];
		// currentTurnIdx = 3 (where curr1 starts)
		const result = splitMessageSegments(msgs, 3);

		expect(result.taskMessage).toBe(task);
		expect(result.historyMessages).toContain(hist1);
		expect(result.historyMessages).toContain(hist2);
		expect(result.currentMessages).toContain(curr1);
		expect(result.currentMessages).toContain(curr2);
	});

	it("filters out archive injection messages", () => {
		const task = makeUserMsg("task");
		const archiveMsg = makeUserMsg("## Work So Far\nDid some things");
		const hist = makeAssistantMsg("response");
		const curr = makeUserMsg("current tool result");
		// [task, archiveMsg, hist, curr] with currentTurnIdx=3
		const msgs = [task, archiveMsg, hist, curr];
		const result = splitMessageSegments(msgs, 3);
		expect(result.historyMessages).not.toContain(archiveMsg);
		expect(result.historyMessages).toContain(hist);
		expect(result.currentMessages).toContain(curr);
	});
});

describe("reshapeMessages", () => {
	it("always starts with task message", () => {
		const task = makeUserMsg("task description");
		const archive = createArchive();
		const result = reshapeMessages(task, archive, [], [], 20_000);
		expect(result[0]).toBe(task);
	});

	it("does not inject archive when archive is empty", () => {
		const task = makeUserMsg("task description");
		const archive = createArchive();
		const result = reshapeMessages(task, archive, [], [], 20_000);
		expect(result).toHaveLength(1);
	});

	it("injects archive message when archive has content", () => {
		const task = makeUserMsg("task description");
		const archive: ContextArchive = {
			workSummary: "Turn 1: read(foo.ts) → 10 lines",
			decisions: [],
			modifiedFiles: new Map(),
			fileHashes: new Map(),
			resolvedErrors: [],
		};
		const result = reshapeMessages(task, archive, [], [], 20_000);
		// Should have task + archive injection
		expect(result.length).toBeGreaterThanOrEqual(2);
		const archiveMsg = result[1];
		expect(archiveMsg).toBeDefined();
		if (archiveMsg && typeof archiveMsg.content === "string") {
			expect(archiveMsg.content).toContain("Work So Far");
		}
	});

	it("appends history and current messages in order", () => {
		const task = makeUserMsg("task");
		const hist = makeAssistantMsg("history");
		const curr = makeUserMsg("current");
		const archive = createArchive();
		const result = reshapeMessages(task, archive, [hist], [curr], 20_000);
		expect(result).toContain(hist);
		expect(result).toContain(curr);
		// Current should be last
		expect(result[result.length - 1]).toBe(curr);
	});

	it("truncates archive if it exceeds budget", () => {
		const task = makeUserMsg("task");
		const archive: ContextArchive = {
			workSummary: "x".repeat(10_000), // ~2500 tokens
			decisions: [],
			modifiedFiles: new Map(),
			fileHashes: new Map(),
			resolvedErrors: [],
		};
		// Very small archive budget (10 tokens)
		const result = reshapeMessages(task, archive, [], [], 10);
		// Either no archive or a truncated one
		if (result.length > 2) {
			const archiveMsg = result[2];
			if (archiveMsg && typeof archiveMsg.content === "string") {
				expect(archiveMsg.content).toContain("truncated");
			}
		}
	});

	it("inserts assistant ack between task and archive", () => {
		const task = makeUserMsg("task description");
		const archive: ContextArchive = {
			workSummary: "Turn 1: read(foo.ts) → 10 lines",
			decisions: [],
			modifiedFiles: new Map(),
			fileHashes: new Map(),
			resolvedErrors: [],
		};
		const result = reshapeMessages(task, archive, [], [], 20_000);
		// result[0] = task, result[1] = ack (assistant), result[2] = archive (user)
		expect(result).toHaveLength(3);
		expect(result[0]).toBe(task);
		expect(result[1]?.role).toBe("assistant");
		const ackMsg = result[1];
		if (ackMsg && Array.isArray(ackMsg.content)) {
			expect(ackMsg.content[0]).toMatchObject({ type: "text", text: "[Acknowledged]" });
		}
		expect(result[2]?.role).toBe("user");
	});

	it("does not produce consecutive user messages when archive is present", () => {
		const task = makeUserMsg("task description");
		const archive: ContextArchive = {
			workSummary: "Turn 1: read(foo.ts) → 10 lines",
			decisions: [],
			modifiedFiles: new Map(),
			fileHashes: new Map(),
			resolvedErrors: [],
		};
		const hist = makeAssistantMsg("history response");
		const curr = makeUserMsg("current tool result");
		const result = reshapeMessages(task, archive, [hist], [curr], 20_000);

		// Verify no two adjacent messages share the same role
		for (let i = 0; i < result.length - 1; i++) {
			expect(result[i]?.role).not.toBe(result[i + 1]?.role);
		}
	});
});
