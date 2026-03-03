/**
 * Tests for HookManager (src/hooks/manager.ts).
 *
 * Validates guard rule evaluation for pre/post tool call hooks.
 */

import { describe, expect, it } from "bun:test";
import type { GuardConfig } from "../types.ts";
import { HookManager } from "./manager.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeManager(config: GuardConfig): HookManager {
	return new HookManager(config);
}

const noRules: GuardConfig = { rules: [] };

// ─── preToolCall ──────────────────────────────────────────────────────────────

describe("HookManager.preToolCall", () => {
	it("allows all tools when rules are empty", () => {
		const hm = makeManager(noRules);
		expect(hm.preToolCall("bash", {})).toBe(true);
		expect(hm.preToolCall("read", {})).toBe(true);
	});

	it("blocks a specific tool matched by name", () => {
		const hm = makeManager({
			rules: [{ event: "pre_tool_call", tool: "bash", action: "block" }],
		});
		expect(hm.preToolCall("bash", {})).toBe(false);
		expect(hm.preToolCall("read", {})).toBe(true);
	});

	it("blocks all tools when rule has no tool field", () => {
		const hm = makeManager({
			rules: [{ event: "pre_tool_call", action: "block" }],
		});
		expect(hm.preToolCall("bash", {})).toBe(false);
		expect(hm.preToolCall("read", {})).toBe(false);
		expect(hm.preToolCall("write", {})).toBe(false);
	});

	it("allows when action is allow", () => {
		const hm = makeManager({
			rules: [{ event: "pre_tool_call", tool: "read", action: "allow" }],
		});
		expect(hm.preToolCall("read", {})).toBe(true);
	});

	it("short-circuits on allow — subsequent block rule not evaluated", () => {
		const hm = makeManager({
			rules: [
				{ event: "pre_tool_call", tool: "read", action: "allow" },
				{ event: "pre_tool_call", action: "block" },
			],
		});
		// "allow" for "read" fires first — block-all never reached
		expect(hm.preToolCall("read", {})).toBe(true);
		// "bash" doesn't match the allow rule, hits the block-all
		expect(hm.preToolCall("bash", {})).toBe(false);
	});

	it("warn rule allows but does not block", () => {
		const hm = makeManager({
			rules: [{ event: "pre_tool_call", tool: "bash", action: "warn", reason: "be careful" }],
		});
		expect(hm.preToolCall("bash", {})).toBe(true);
	});

	it("ignores post_tool_call rules during preToolCall", () => {
		const hm = makeManager({
			rules: [{ event: "post_tool_call", action: "block" }],
		});
		expect(hm.preToolCall("bash", {})).toBe(true);
	});

	it("evaluates rules in order — first block wins", () => {
		const hm = makeManager({
			rules: [
				{ event: "pre_tool_call", tool: "bash", action: "block", reason: "first" },
				{ event: "pre_tool_call", tool: "bash", action: "allow" },
			],
		});
		// First rule is block — should return false without reaching allow
		expect(hm.preToolCall("bash", {})).toBe(false);
	});

	it("stores the guard config on the instance", () => {
		const config: GuardConfig = {
			version: "1.0",
			rules: [{ event: "pre_tool_call", action: "allow" }],
		};
		const hm = makeManager(config);
		expect(hm.config).toBe(config);
	});
});

// ─── postToolCall ─────────────────────────────────────────────────────────────

describe("HookManager.postToolCall", () => {
	it("does not throw with empty rules", () => {
		const hm = makeManager(noRules);
		expect(() => hm.postToolCall("bash", "some output")).not.toThrow();
	});

	it("does not throw for warn rule", () => {
		const hm = makeManager({
			rules: [{ event: "post_tool_call", tool: "bash", action: "warn", reason: "output is large" }],
		});
		expect(() => hm.postToolCall("bash", "big output")).not.toThrow();
	});

	it("does not act on pre_tool_call rules", () => {
		// block pre_tool_call rule should not affect postToolCall
		const hm = makeManager({
			rules: [{ event: "pre_tool_call", action: "block" }],
		});
		expect(() => hm.postToolCall("bash", "output")).not.toThrow();
	});

	it("ignores block action post-call (no-op)", () => {
		const hm = makeManager({
			rules: [{ event: "post_tool_call", action: "block" }],
		});
		// block is a no-op post-call; should not throw
		expect(() => hm.postToolCall("bash", "output")).not.toThrow();
	});

	it("only processes rules matching the tool name", () => {
		const hm = makeManager({
			rules: [{ event: "post_tool_call", tool: "write", action: "warn" }],
		});
		// warn for "write" — does not affect "read"
		expect(() => hm.postToolCall("read", "output")).not.toThrow();
		expect(() => hm.postToolCall("write", "output")).not.toThrow();
	});
});
