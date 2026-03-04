/**
 * Tests for EventEmitter (src/hooks/events.ts).
 *
 * Validates NDJSON event emission: disabled no-ops, enabled writes,
 * correct event shapes, ISO timestamps, and newline termination.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { EventEmitter } from "./events.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

type WriteSpy = ReturnType<typeof spyOn<typeof process.stdout, "write">>;

function parseFirstEvent(spy: WriteSpy): Record<string, unknown> {
	const args = spy.mock.calls[0] as [string];
	return JSON.parse(args[0].trim()) as Record<string, unknown>;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("EventEmitter", () => {
	let writeSpy: WriteSpy;

	beforeEach(() => {
		writeSpy = spyOn(process.stdout, "write").mockReturnValue(true);
	});

	afterEach(() => {
		writeSpy.mockRestore();
	});

	// ── Disabled mode ──────────────────────────────────────────────────────────

	describe("when disabled", () => {
		it("emit() is a no-op", () => {
			const emitter = new EventEmitter(false);
			emitter.emit({ type: "ready", model: "claude" });
			expect(writeSpy).not.toHaveBeenCalled();
		});

		it("all convenience methods are no-ops", () => {
			const emitter = new EventEmitter(false);
			emitter.ready("model", 200, ["bash"]);
			emitter.turnStart(1);
			emitter.toolStart(1, "bash", "t1", "{}");
			emitter.toolEnd(1, "bash", "t1", true, 42);
			emitter.turnEnd(1, 100, 50, 0, 0, "claude", 0.5);
			emitter.progress(50, "Running tests", 3);
			emitter.result("success", "done", 1, 100, 50);
			emitter.error("boom", "TRANSIENT");
			expect(writeSpy).not.toHaveBeenCalled();
		});

		it("enabled is false", () => {
			expect(new EventEmitter(false).enabled).toBe(false);
		});
	});

	// ── Enabled mode ───────────────────────────────────────────────────────────

	describe("when enabled", () => {
		it("enabled is true", () => {
			expect(new EventEmitter(true).enabled).toBe(true);
		});

		it("emit() writes a newline-terminated JSON line to stdout", () => {
			const emitter = new EventEmitter(true);
			emitter.emit({ type: "turn_start", turn: 1 });
			expect(writeSpy).toHaveBeenCalledTimes(1);
			const written = (writeSpy.mock.calls[0] as [string])[0];
			expect(written).toMatch(/\n$/);
			expect(() => JSON.parse(written.trim())).not.toThrow();
		});

		it("emit() adds a valid ISO timestamp field automatically", () => {
			const emitter = new EventEmitter(true);
			emitter.emit({ type: "turn_start", turn: 1 });
			const parsed = parseFirstEvent(writeSpy);
			expect(typeof parsed.timestamp).toBe("string");
			// Round-trips through Date without loss of precision
			expect(new Date(parsed.timestamp as string).toISOString()).toBe(parsed.timestamp as string);
		});

		it("emit() always stamps with a fresh ISO timestamp", () => {
			// The emit() implementation adds timestamp after spreading the event,
			// so any caller-provided timestamp is overwritten by the current time.
			const emitter = new EventEmitter(true);
			emitter.emit({ type: "x", timestamp: "caller-stamp" });
			const parsed = parseFirstEvent(writeSpy);
			// Timestamp is a valid ISO string, not the caller-supplied value
			expect(typeof parsed.timestamp).toBe("string");
			expect(parsed.timestamp as string).not.toBe("caller-stamp");
		});

		// ── Convenience methods ────────────────────────────────────────────────

		it("ready() emits correct shape", () => {
			const emitter = new EventEmitter(true);
			emitter.ready("claude-sonnet", 200, ["bash", "read"]);
			const parsed = parseFirstEvent(writeSpy);
			expect(parsed.type).toBe("ready");
			expect(parsed.model).toBe("claude-sonnet");
			expect(parsed.maxTurns).toBe(200);
			expect(parsed.tools).toEqual(["bash", "read"]);
		});

		it("turnStart() emits correct shape", () => {
			const emitter = new EventEmitter(true);
			emitter.turnStart(3);
			const parsed = parseFirstEvent(writeSpy);
			expect(parsed.type).toBe("turn_start");
			expect(parsed.turn).toBe(3);
		});

		it("toolStart() emits correct shape", () => {
			const emitter = new EventEmitter(true);
			emitter.toolStart(2, "bash", "call-abc-123", '{"cmd":"ls"}');
			const parsed = parseFirstEvent(writeSpy);
			expect(parsed.type).toBe("tool_start");
			expect(parsed.turn).toBe(2);
			expect(parsed.toolName).toBe("bash");
			expect(parsed.toolCallId).toBe("call-abc-123");
			expect(parsed.argsSummary).toBe('{"cmd":"ls"}');
		});

		it("toolEnd() emits correct shape with success=true", () => {
			const emitter = new EventEmitter(true);
			emitter.toolEnd(2, "bash", "call-abc-123", true, 123);
			const parsed = parseFirstEvent(writeSpy);
			expect(parsed.type).toBe("tool_end");
			expect(parsed.toolName).toBe("bash");
			expect(parsed.toolCallId).toBe("call-abc-123");
			expect(parsed.success).toBe(true);
			expect(parsed.durationMs).toBe(123);
		});

		it("toolEnd() emits success=false on error", () => {
			const emitter = new EventEmitter(true);
			emitter.toolEnd(1, "write", "call-xyz", false, 5);
			const parsed = parseFirstEvent(writeSpy);
			expect(parsed.success).toBe(false);
			expect(parsed.durationMs).toBe(5);
		});

		it("toolEnd() includes filesModified when provided", () => {
			const emitter = new EventEmitter(true);
			emitter.toolEnd(1, "write", "call-abc", true, 10, ["/path/to/file.ts"]);
			const parsed = parseFirstEvent(writeSpy);
			expect(parsed.filesModified).toEqual(["/path/to/file.ts"]);
		});

		it("toolEnd() includes empty filesModified array when provided", () => {
			const emitter = new EventEmitter(true);
			emitter.toolEnd(1, "bash", "call-abc", true, 10, []);
			const parsed = parseFirstEvent(writeSpy);
			expect(parsed.filesModified).toEqual([]);
		});

		it("toolEnd() omits filesModified when not provided", () => {
			const emitter = new EventEmitter(true);
			emitter.toolEnd(1, "read", "call-abc", true, 10);
			const parsed = parseFirstEvent(writeSpy);
			expect("filesModified" in parsed).toBe(false);
		});

		it("toolEnd() includes errorMessage when provided", () => {
			const emitter = new EventEmitter(true);
			emitter.toolEnd(1, "bash", "call-err", false, 5, [], "Command not found", undefined);
			const parsed = parseFirstEvent(writeSpy);
			expect(parsed.errorMessage).toBe("Command not found");
			expect("outputSummary" in parsed).toBe(false);
		});

		it("toolEnd() includes outputSummary when provided", () => {
			const emitter = new EventEmitter(true);
			emitter.toolEnd(1, "bash", "call-ok", true, 20, [], undefined, "file1.ts\nfile2.ts");
			const parsed = parseFirstEvent(writeSpy);
			expect(parsed.outputSummary).toBe("file1.ts\nfile2.ts");
			expect("errorMessage" in parsed).toBe(false);
		});

		it("toolEnd() omits errorMessage when not provided", () => {
			const emitter = new EventEmitter(true);
			emitter.toolEnd(1, "bash", "call-ok", true, 20);
			const parsed = parseFirstEvent(writeSpy);
			expect("errorMessage" in parsed).toBe(false);
		});

		it("toolEnd() omits outputSummary when not provided", () => {
			const emitter = new EventEmitter(true);
			emitter.toolEnd(1, "bash", "call-ok", true, 20);
			const parsed = parseFirstEvent(writeSpy);
			expect("outputSummary" in parsed).toBe(false);
		});

		it("turnEnd() emits correct shape with all token fields and model", () => {
			const emitter = new EventEmitter(true);
			emitter.turnEnd(2, 500, 100, 20, 10, "claude-sonnet-4-6", 0.45);
			const parsed = parseFirstEvent(writeSpy);
			expect(parsed.type).toBe("turn_end");
			expect(parsed.turn).toBe(2);
			expect(parsed.inputTokens).toBe(500);
			expect(parsed.outputTokens).toBe(100);
			expect(parsed.cacheReadTokens).toBe(20);
			expect(parsed.cacheWriteTokens).toBe(10);
			expect(parsed.model).toBe("claude-sonnet-4-6");
			expect(parsed.contextUtilization).toBe(0.45);
		});

		it("result() emits correct shape for success outcome", () => {
			const emitter = new EventEmitter(true);
			emitter.result("success", "Task completed.", 5, 1000, 400);
			const parsed = parseFirstEvent(writeSpy);
			expect(parsed.type).toBe("result");
			expect(parsed.outcome).toBe("success");
			expect(parsed.summary).toBe("Task completed.");
			expect(parsed.totalTurns).toBe(5);
			expect(parsed.totalInputTokens).toBe(1000);
			expect(parsed.totalOutputTokens).toBe(400);
		});

		it("result() emits correct shape for max_turns outcome", () => {
			const emitter = new EventEmitter(true);
			emitter.result("max_turns", "max turns reached", 10, 2000, 800);
			const parsed = parseFirstEvent(writeSpy);
			expect(parsed.type).toBe("result");
			expect(parsed.outcome).toBe("max_turns");
		});

		it("result() emits correct shape for error outcome", () => {
			const emitter = new EventEmitter(true);
			emitter.result("error", "API error", 1, 50, 0);
			const parsed = parseFirstEvent(writeSpy);
			expect(parsed.type).toBe("result");
			expect(parsed.outcome).toBe("error");
			expect(parsed.summary).toBe("API error");
		});

		it("error() emits correct shape", () => {
			const emitter = new EventEmitter(true);
			emitter.error("Authentication failed", "AUTH_FAILED");
			const parsed = parseFirstEvent(writeSpy);
			expect(parsed.type).toBe("error");
			expect(parsed.message).toBe("Authentication failed");
			expect(parsed.classification).toBe("AUTH_FAILED");
		});

		it("progress() emits correct shape", () => {
			const emitter = new EventEmitter(true);
			emitter.progress(75, "Writing implementation", 5);
			const parsed = parseFirstEvent(writeSpy);
			expect(parsed.type).toBe("progress");
			expect(parsed.percent).toBe(75);
			expect(parsed.subtask).toBe("Writing implementation");
			expect(parsed.filesChanged).toBe(5);
		});

		it("progress() emits 0 percent at start", () => {
			const emitter = new EventEmitter(true);
			emitter.progress(0, "Starting task", 0);
			const parsed = parseFirstEvent(writeSpy);
			expect(parsed.type).toBe("progress");
			expect(parsed.percent).toBe(0);
			expect(parsed.filesChanged).toBe(0);
		});

		it("progress() emits 100 percent at completion", () => {
			const emitter = new EventEmitter(true);
			emitter.progress(100, "Task complete", 12);
			const parsed = parseFirstEvent(writeSpy);
			expect(parsed.percent).toBe(100);
			expect(parsed.subtask).toBe("Task complete");
		});

		it("multiple emits produce separate newline-terminated lines", () => {
			const emitter = new EventEmitter(true);
			emitter.turnStart(1);
			emitter.turnStart(2);
			expect(writeSpy).toHaveBeenCalledTimes(2);
		});
	});
});
