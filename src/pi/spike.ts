/**
 * Spike harness for sapling-bec1: embed the pi SDK in-process and prove
 * per-turn message-array control.
 *
 * This module is spike code, not the production adapter (sapling-a075). It
 * exists to pin the real pi SDK surface with runnable proof:
 *
 * 1. pi embeds fully in-process (createAgentSession + in-memory managers,
 *    no subprocess, no ~/.pi/agent touchpoints).
 * 2. The `context` extension hook fires before every LLM call and may
 *    REPLACE the message array the provider sees, non-destructively (the
 *    session history keeps the original messages).
 * 3. `before_provider_request` exposes the exact serialized payload, so the
 *    effect of the context hook on the wire is directly observable.
 * 4. System prompt control works via ResourceLoader systemPromptOverride.
 * 5. Usage is readable from `turn_end` (plan constraint d).
 * 6. A hard provider error does NOT throw from prompt(); the run ends with
 *    an assistant message whose stopReason is "error" (plan constraint e).
 *
 * Pinned against @earendil-works/pi-coding-agent@0.83.0 (exact version in
 * package.json; see src/pi/spike.test.ts for the drift tripwires).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type InlineExtension,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

/** pi 0.83.0 built-in catalogue id used by the spike (cheap + fast). */
export const SPIKE_MODEL_PROVIDER = "anthropic";
export const SPIKE_MODEL_ID = "claude-haiku-4-5";

export interface PayloadProbe {
	/** Number of messages in the serialized provider payload. */
	messageCount: number;
	/** Serialized system prompt text, if the provider payload carries one. */
	systemText: string | undefined;
	/** Full JSON of the payload, for sentinel greps. */
	body: string;
}

export interface TurnProbe {
	turnIndex: number;
	stopReason: string;
	inputTokens: number;
	outputTokens: number;
	errorMessage: string | undefined;
}

export interface PiSpikeOptions {
	/** Isolated working directory for the session (temp dir in tests). */
	workDir: string;
	/** API key installed as a runtime override. Omit to use ambient env auth. */
	apiKey?: string;
	/** System prompt installed via ResourceLoader systemPromptOverride. */
	systemPrompt: string;
	/**
	 * When set, the context hook replaces the whole message array with a
	 * single user message containing this sentinel before every LLM call.
	 */
	rewriteSentinel?: string;
	/** Prompts sent sequentially via session.prompt(). */
	prompts: string[];
}

export interface PiSpikeResult {
	/** Model id actually used, resolved from the pinned runtime catalogue. */
	modelId: string;
	/** Message-array lengths observed by the context hook, one per LLM call. */
	contextHookMessageCounts: number[];
	/** Provider payloads observed by before_provider_request, one per LLM call. */
	payloads: PayloadProbe[];
	/** Usage/stopReason per turn, read exclusively from turn_end. */
	turns: TurnProbe[];
	/** stopReason of the final assistant message in session history. */
	finalStopReason: string | undefined;
	/** errorMessage of the final assistant message, when stopReason is "error". */
	finalErrorMessage: string | undefined;
	/** Full session message history after the run (proves non-destructive hooks). */
	finalMessages: AgentMessage[];
	/** Text content of the final assistant message. */
	finalText: string;
}

function assistantText(message: AgentMessage | undefined): string {
	if (!message || message.role !== "assistant") return "";
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("");
}

function lastAssistant(messages: AgentMessage[]): AgentMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role === "assistant") return message;
	}
	return undefined;
}

function probePayload(payload: unknown): PayloadProbe {
	const body = JSON.stringify(payload) ?? "";
	const record = payload as { messages?: unknown[]; system?: unknown };
	// pi 0.83.0 serializes the Anthropic system prompt as an array of blocks
	// (with cache_control), not a plain string.
	let systemText: string | undefined;
	if (typeof record.system === "string") {
		systemText = record.system;
	} else if (Array.isArray(record.system)) {
		systemText = record.system
			.map((block) => {
				const part = block as { type?: string; text?: string };
				return part.type === "text" ? (part.text ?? "") : "";
			})
			.join("");
	}
	return {
		messageCount: Array.isArray(record.messages) ? record.messages.length : -1,
		systemText,
		body,
	};
}

/**
 * Run a fully in-process pi SDK session with instrumented hooks and return
 * everything the spike asserts against. Never throws on provider errors —
 * those are reported through finalStopReason/finalErrorMessage.
 */
export async function runPiSpike(options: PiSpikeOptions): Promise<PiSpikeResult> {
	const agentDir = mkdtempSync(join(tmpdir(), "sapling-pi-spike-agent-"));
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
	});
	if (options.apiKey !== undefined) {
		await modelRuntime.setRuntimeApiKey(SPIKE_MODEL_PROVIDER, options.apiKey);
	}
	const model = modelRuntime.getModel(SPIKE_MODEL_PROVIDER, SPIKE_MODEL_ID);
	if (!model) {
		throw new Error(`pinned model ${SPIKE_MODEL_PROVIDER}/${SPIKE_MODEL_ID} not in pi catalogue`);
	}

	const contextHookMessageCounts: number[] = [];
	const payloads: PayloadProbe[] = [];
	const turns: TurnProbe[] = [];

	const probe: InlineExtension = {
		name: "sapling-spike",
		factory: (pi) => {
			pi.on("context", (event) => {
				contextHookMessageCounts.push(event.messages.length);
				if (options.rewriteSentinel === undefined) return undefined;
				const rewritten: AgentMessage = {
					role: "user",
					content: options.rewriteSentinel,
					timestamp: Date.now(),
				};
				return { messages: [rewritten] };
			});
			pi.on("before_provider_request", (event) => {
				payloads.push(probePayload(event.payload));
				return undefined;
			});
			pi.on("turn_end", (event) => {
				const message = event.message;
				if (message.role !== "assistant") return;
				turns.push({
					turnIndex: event.turnIndex,
					stopReason: message.stopReason,
					inputTokens: message.usage.input,
					outputTokens: message.usage.output,
					errorMessage: message.errorMessage,
				});
			});
		},
	};

	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd: options.workDir,
		agentDir,
		settingsManager,
		systemPromptOverride: () => options.systemPrompt,
		extensionFactories: [probe],
	});
	await resourceLoader.reload();

	let session: AgentSession | undefined;
	try {
		const created = await createAgentSession({
			cwd: options.workDir,
			agentDir,
			model,
			thinkingLevel: "off",
			modelRuntime,
			noTools: "all",
			resourceLoader,
			sessionManager: SessionManager.inMemory(options.workDir),
			settingsManager,
		});
		session = created.session;
		for (const prompt of options.prompts) {
			await session.prompt(prompt);
		}
		const finalMessages = [...session.messages];
		const final = lastAssistant(finalMessages);
		return {
			modelId: model.id,
			contextHookMessageCounts,
			payloads,
			turns,
			finalStopReason: final?.role === "assistant" ? final.stopReason : undefined,
			finalErrorMessage: final?.role === "assistant" ? final.errorMessage : undefined,
			finalMessages,
			finalText: assistantText(final),
		};
	} finally {
		session?.dispose();
	}
}
