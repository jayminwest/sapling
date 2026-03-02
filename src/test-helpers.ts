import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmClient, LlmRequest, LlmResponse } from "./types.ts";

export async function createTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "sapling-test-"));
}

export async function cleanupTempDir(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true });
}

export function mockTextResponse(text: string): LlmResponse {
	return {
		content: [{ type: "text", text }],
		usage: { inputTokens: 100, outputTokens: 50 },
		model: "mock-model",
		stopReason: "end_turn",
	};
}

export function mockToolUseResponse(
	toolName: string,
	input: Record<string, unknown>,
	id: string,
): LlmResponse {
	return {
		content: [{ type: "tool_use", id, name: toolName, input }],
		usage: { inputTokens: 100, outputTokens: 50 },
		model: "mock-model",
		stopReason: "tool_use",
	};
}

export function createMockClient(responses: LlmResponse[]): LlmClient & { calls: LlmRequest[] } {
	const calls: LlmRequest[] = [];
	let callIndex = 0;

	return {
		id: "mock",
		calls,
		call: async (request: LlmRequest): Promise<LlmResponse> => {
			calls.push(request);
			const response = responses[callIndex] ?? responses[responses.length - 1];
			callIndex++;
			return response as LlmResponse;
		},
		estimateTokens: (text: string): number => Math.ceil(text.length / 4),
	};
}
