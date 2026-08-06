/**
 * Spike proofs for sapling-bec1: embed the pi SDK in-process and prove
 * per-turn message-array control.
 *
 * Two layers:
 *
 * 1. DRIFT TRIPWIRES (always run, no network): pin the pi SDK surface the
 *    plan's later steps build against — exact pinned version, expected
 *    exports, expected event/option shapes. Upstream drift fails loudly here
 *    (plan constraint a).
 *
 * 2. LIVE PROOFS (gated on SAPLING_INTEGRATION_TESTS=1 + ANTHROPIC_API_KEY,
 *    matching src/integration.test.ts): a real in-process pi session proves
 *    the context hook replaces the provider-visible message array per turn
 *    non-destructively, the system prompt override reaches the wire, usage
 *    reads from turn_end, and a hard provider error surfaces as stopReason
 *    "error" without prompt() throwing (plan constraints d and e).
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as piAgentCore from "@earendil-works/pi-agent-core";
import * as pi from "@earendil-works/pi-coding-agent";
import { cleanupTempDir, createTempDir } from "../test-helpers.ts";
import { runPiSpike, SPIKE_MODEL_ID, SPIKE_MODEL_PROVIDER } from "./spike.ts";

const PINNED_PI_VERSION = "0.83.0";

describe("pi SDK surface tripwires (sapling-bec1)", () => {
	it("pins @earendil-works/pi-coding-agent to an exact version", () => {
		const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8")) as {
			dependencies: Record<string, string>;
		};
		expect(pkg.dependencies["@earendil-works/pi-coding-agent"]).toBe(PINNED_PI_VERSION);
		const installed = JSON.parse(
			readFileSync(
				join(import.meta.dir, "../../node_modules/@earendil-works/pi-coding-agent/package.json"),
				"utf8",
			),
		) as { version: string };
		expect(installed.version).toBe(PINNED_PI_VERSION);
	});

	it("exposes the session factories and managers the adapter will use", () => {
		expect(typeof pi.createAgentSession).toBe("function");
		expect(typeof pi.ModelRuntime.create).toBe("function");
		expect(typeof pi.SessionManager.inMemory).toBe("function");
		expect(typeof pi.SettingsManager.inMemory).toBe("function");
		expect(typeof pi.DefaultResourceLoader).toBe("function");
	});

	it("keeps AgentMessage/transformContext types in pi-agent-core", () => {
		// The pipeline hook must stay harness-agnostic: message types come from
		// pi-agent-core, not from pi-coding-agent's CLI surface.
		expect(piAgentCore).toBeDefined();
	});

	it("pins the spike model to anthropic/claude-haiku-4-5", () => {
		expect(SPIKE_MODEL_PROVIDER).toBe("anthropic");
		expect(SPIKE_MODEL_ID).toBe("claude-haiku-4-5");
	});

	it("accepts compaction-disabled and retry-disabled in-memory settings", () => {
		const settings = pi.SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		});
		expect(settings).toBeDefined();
	});
});

const SKIP = !process.env.SAPLING_INTEGRATION_TESTS || !process.env.ANTHROPIC_API_KEY;
const SPIKE_SYSTEM_PROMPT = "You are a test harness. Answer tersely.";

describe.skipIf(SKIP)("pi SDK in-process spike (live, sapling-bec1)", () => {
	it("context hook replaces the provider-visible messages per turn, non-destructively", async () => {
		const workDir = await createTempDir();
		try {
			const sentinel = "SPIKE_SENTINEL_7f3a: reply with the single word OK.";
			const result = await runPiSpike({
				workDir,
				apiKey: process.env.ANTHROPIC_API_KEY as string,
				systemPrompt: SPIKE_SYSTEM_PROMPT,
				rewriteSentinel: sentinel,
				prompts: ["Reply with exactly the word ALPHA and nothing else."],
			});

			// The context hook fired before the LLM call and saw pi's real history.
			expect(result.contextHookMessageCounts.length).toBeGreaterThanOrEqual(1);
			// The serialized provider payload carries the REPLACED array: exactly
			// one message, containing the sentinel, and not the original prompt.
			expect(result.payloads.length).toBe(result.contextHookMessageCounts.length);
			const payload = result.payloads[0];
			expect(payload).toBeDefined();
			expect(payload?.messageCount).toBe(1);
			expect(payload?.body).toContain("SPIKE_SENTINEL_7f3a");
			expect(payload?.body).not.toContain("ALPHA");
			// System prompt override reached the provider payload. pi appends
			// its own "Current working directory:" trailer, so assert contains.
			expect(payload?.systemText).toContain(SPIKE_SYSTEM_PROMPT);
			// Non-destructive: session history still holds the original exchange.
			expect(result.finalMessages.length).toBeGreaterThanOrEqual(2);
			expect(JSON.stringify(result.finalMessages)).toContain("ALPHA");
			// Usage is readable from turn_end; the run completed normally.
			expect(result.turns.length).toBeGreaterThanOrEqual(1);
			expect(result.turns[0]?.inputTokens).toBeGreaterThan(0);
			expect(result.turns[0]?.outputTokens).toBeGreaterThan(0);
			expect(result.finalStopReason).toBe("stop");
		} finally {
			await cleanupTempDir(workDir);
		}
	}, 60_000);

	it("pi fires the context hook on every LLM call across turns", async () => {
		const workDir = await createTempDir();
		try {
			const result = await runPiSpike({
				workDir,
				apiKey: process.env.ANTHROPIC_API_KEY as string,
				systemPrompt: SPIKE_SYSTEM_PROMPT,
				prompts: ["Say hi.", "Say hi again."],
			});
			// One context hook + one provider payload per prompt, and the hook
			// observes history growth between turns.
			expect(result.contextHookMessageCounts.length).toBe(2);
			expect(result.payloads.length).toBe(2);
			expect(result.contextHookMessageCounts[1]).toBeGreaterThan(
				result.contextHookMessageCounts[0] as number,
			);
			expect(result.turns.length).toBe(2);
			expect(result.finalStopReason).toBe("stop");
		} finally {
			await cleanupTempDir(workDir);
		}
	}, 120_000);

	it("a hard provider error does not throw; it ends with stopReason error", async () => {
		const workDir = await createTempDir();
		try {
			const result = await runPiSpike({
				workDir,
				apiKey: "sk-ant-invalid-sapling-spike",
				systemPrompt: SPIKE_SYSTEM_PROMPT,
				prompts: ["This call must fail."],
			});
			// Plan constraint (e): exit-0-with-stopReason-error must be treated
			// as failure. The SDK does not throw; classification must read
			// stopReason from the final assistant message.
			expect(result.finalStopReason).toBe("error");
			expect(result.finalErrorMessage).toBeTruthy();
		} finally {
			await cleanupTempDir(workDir);
		}
	}, 60_000);
});
