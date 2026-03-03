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
			emitter.emit({ type: "started", model: "claude" });
			expect(writeSpy).not.toHaveBeenCalled();
		});

		it("all convenience methods are no-ops", () => {
			const emitter = new EventEmitter(false);
			emitter.started("model", 200, ["bash"]);
			emitter.turnStart(1);
			emitter.toolCall(1, "bash", "t1");
			emitter.toolResult(1, "bash", "t1", false);
			emitter.turnEnd(1, 100, 50, 0.5);
			emitter.runComplete("task_complete", 1, 100, 50);
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

		it("started() emits correct shape", () => {
			const emitter = new EventEmitter(true);
			emitter.started("claude-sonnet", 200, ["bash", "read"]);
			const parsed = parseFirstEvent(writeSpy);
			expect(parsed.type).toBe("started");
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

		it("toolCall() emits correct shape", () => {
			const emitter = new EventEmitter(true);
			emitter.toolCall(2, "bash", "call-abc-123");
			const parsed = parseFirstEvent(writeSpy);
			expect(parsed.type).toBe("tool_call");
			expect(parsed.turn).toBe(2);
			expect(parsed.toolName).toBe("bash");
			expect(parsed.toolCallId).toBe("call-abc-123");
		});

		it("toolResult() emits correct shape with isError=false", () => {
			const emitter = new EventEmitter(true);
			emitter.toolResult(2, "bash", "call-abc-123", false);
			const parsed = parseFirstEvent(writeSpy);
			expect(parsed.type).toBe("tool_result");
			expect(parsed.toolName).toBe("bash");
			expect(parsed.toolCallId).toBe("call-abc-123");
			expect(parsed.isError).toBe(false);
		});

		it("toolResult() emits isError=true on error", () => {
			const emitter = new EventEmitter(true);
			emitter.toolResult(1, "write", "call-xyz", true);
			expect(parseFirstEvent(writeSpy).isError).toBe(true);
		});

		it("turnEnd() emits correct shape with contextUtilization ratio", () => {
			const emitter = new EventEmitter(true);
			emitter.turnEnd(2, 500, 100, 0.45);
			const parsed = parseFirstEvent(writeSpy);
			expect(parsed.type).toBe("turn_end");
			expect(parsed.turn).toBe(2);
			expect(parsed.inputTokens).toBe(500);
			expect(parsed.outputTokens).toBe(100);
			expect(parsed.contextUtilization).toBe(0.45);
		});

		it("runComplete() emits correct shape", () => {
			const emitter = new EventEmitter(true);
			emitter.runComplete("task_complete", 5, 1000, 400);
			const parsed = parseFirstEvent(writeSpy);
			expect(parsed.type).toBe("run_complete");
			expect(parsed.exitReason).toBe("task_complete");
			expect(parsed.totalTurns).toBe(5);
			expect(parsed.totalInputTokens).toBe(1000);
			expect(parsed.totalOutputTokens).toBe(400);
		});

		it("multiple emits produce separate newline-terminated lines", () => {
			const emitter = new EventEmitter(true);
			emitter.turnStart(1);
			emitter.turnStart(2);
			expect(writeSpy).toHaveBeenCalledTimes(2);
		});
	});
});
