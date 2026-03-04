// WHY MOCK: Anthropic SDK calls have real API costs and require a valid ANTHROPIC_API_KEY.
// We mock the SDK module to test response mapping and error handling without API calls.

import { describe, expect, it, mock } from "bun:test";
import type { SdkClient, SdkResponse } from "./anthropic.ts";
import { AnthropicClient } from "./anthropic.ts";
import type { LlmRequest } from "./types.ts";

const baseRequest: LlmRequest = {
	systemPrompt: "You are a helpful assistant.",
	messages: [{ role: "user", content: "Hello" }],
	tools: [],
};

function makeSdkResponse(overrides?: Partial<SdkResponse>): SdkResponse {
	return {
		content: overrides?.content ?? [{ type: "text", text: "Hi there!" }],
		usage: overrides?.usage ?? { input_tokens: 10, output_tokens: 5 },
		model: overrides?.model ?? "claude-sonnet-4-6",
		stop_reason: overrides?.stop_reason ?? "end_turn",
	};
}

function makeMockSdk(createFn: () => Promise<unknown>) {
	return {
		default: class MockAnthropic {
			messages = { create: createFn };
		},
	};
}

describe("AnthropicClient", () => {
	describe("estimateTokens", () => {
		const client = new AnthropicClient();

		it("estimates tokens for short text", () => {
			expect(client.estimateTokens("hello")).toBe(2);
		});

		it("returns 0 for empty string", () => {
			expect(client.estimateTokens("")).toBe(0);
		});

		it("returns 1 for 4-char string", () => {
			expect(client.estimateTokens("abcd")).toBe(1);
		});
	});

	describe("id", () => {
		it("returns anthropic-sdk", () => {
			const client = new AnthropicClient();
			expect(client.id).toBe("anthropic-sdk");
		});
	});

	describe("call", () => {
		it("maps text block response to LlmResponse correctly", async () => {
			const sdkResp = makeSdkResponse({
				content: [{ type: "text", text: "Hello!" }],
				stop_reason: "end_turn",
			});

			const client = new AnthropicClient();
			// Inject mock via dynamic import override
			mock.module("@anthropic-ai/sdk", () => makeMockSdk(() => Promise.resolve(sdkResp)));

			const result = await client.call(baseRequest);
			expect(result.content).toHaveLength(1);
			const block = result.content[0];
			expect(block?.type).toBe("text");
			if (block?.type === "text") {
				expect(block.text).toBe("Hello!");
			}
			expect(result.stopReason).toBe("end_turn");
		});

		it("maps tool_use block response correctly", async () => {
			const sdkResp = makeSdkResponse({
				content: [
					{
						type: "tool_use",
						id: "tu_abc123",
						name: "bash",
						input: { command: "ls" },
					},
				],
				stop_reason: "tool_use",
			});

			mock.module("@anthropic-ai/sdk", () => makeMockSdk(() => Promise.resolve(sdkResp)));
			const client = new AnthropicClient();

			const result = await client.call(baseRequest);
			expect(result.content).toHaveLength(1);
			const block = result.content[0];
			expect(block?.type).toBe("tool_use");
			if (block?.type === "tool_use") {
				expect(block.id).toBe("tu_abc123");
				expect(block.name).toBe("bash");
				expect(block.input).toEqual({ command: "ls" });
			}
			expect(result.stopReason).toBe("tool_use");
		});

		it("maps usage fields correctly", async () => {
			const sdkResp = makeSdkResponse({
				usage: {
					input_tokens: 100,
					output_tokens: 50,
					cache_read_input_tokens: 20,
					cache_creation_input_tokens: 5,
				},
			});

			mock.module("@anthropic-ai/sdk", () => makeMockSdk(() => Promise.resolve(sdkResp)));
			const client = new AnthropicClient();

			const result = await client.call(baseRequest);
			expect(result.usage.inputTokens).toBe(100);
			expect(result.usage.outputTokens).toBe(50);
			expect(result.usage.cacheReadTokens).toBe(20);
			expect(result.usage.cacheCreationTokens).toBe(5);
		});

		it("maps stop_reason to stopReason", async () => {
			const sdkResp = makeSdkResponse({ stop_reason: "max_tokens" });

			mock.module("@anthropic-ai/sdk", () => makeMockSdk(() => Promise.resolve(sdkResp)));
			const client = new AnthropicClient();

			const result = await client.call(baseRequest);
			expect(result.stopReason).toBe("max_tokens");
		});

		it("throws ClientError SDK_NOT_INSTALLED when SDK unavailable", async () => {
			// Simulate missing SDK by returning a module with no default export
			mock.module("@anthropic-ai/sdk", () => ({ default: null }));
			const client = new AnthropicClient();

			await expect(client.call(baseRequest)).rejects.toMatchObject({
				code: "SDK_NOT_INSTALLED",
			});
		});

		it("throws ClientError SDK_API_ERROR on API errors", async () => {
			mock.module("@anthropic-ai/sdk", () =>
				makeMockSdk(() => Promise.reject(new Error("Rate limit exceeded"))),
			);
			const client = new AnthropicClient();

			await expect(client.call(baseRequest)).rejects.toMatchObject({
				code: "SDK_API_ERROR",
			});
		});
	});

	describe("dependency injection (_client)", () => {
		function makeDiClient(createFn: SdkClient["messages"]["create"]): SdkClient {
			return {
				messages: { create: createFn },
			};
		}

		it("uses injected _client instead of dynamic import", async () => {
			const sdkResp = makeSdkResponse({ content: [{ type: "text", text: "DI works!" }] });
			const diClient = makeDiClient(() => Promise.resolve(sdkResp));
			const client = new AnthropicClient({ _client: diClient });

			const result = await client.call(baseRequest);
			expect(result.content[0]).toMatchObject({ type: "text", text: "DI works!" });
		});

		it("passes MiniMax-M2.5 as default model", async () => {
			let capturedModel: unknown;
			const sdkResp = makeSdkResponse();
			const diClient = makeDiClient((params) => {
				capturedModel = (params as { model: string }).model;
				return Promise.resolve(sdkResp);
			});
			const client = new AnthropicClient({ _client: diClient });

			await client.call(baseRequest);
			expect(capturedModel).toBe("MiniMax-M2.5");
		});

		it("classifies 401 as SDK_AUTH_FAILED", async () => {
			const diClient = makeDiClient(() => Promise.reject({ status: 401, message: "auth error" }));
			const client = new AnthropicClient({ _client: diClient });

			await expect(client.call(baseRequest)).rejects.toMatchObject({ code: "SDK_AUTH_FAILED" });
		});

		it("classifies 403 as SDK_PERMISSION_DENIED", async () => {
			const diClient = makeDiClient(() => Promise.reject({ status: 403, message: "forbidden" }));
			const client = new AnthropicClient({ _client: diClient });

			await expect(client.call(baseRequest)).rejects.toMatchObject({
				code: "SDK_PERMISSION_DENIED",
			});
		});

		it("classifies 404 as SDK_MODEL_NOT_FOUND", async () => {
			const diClient = makeDiClient(() => Promise.reject({ status: 404, message: "not found" }));
			const client = new AnthropicClient({ _client: diClient });

			await expect(client.call(baseRequest)).rejects.toMatchObject({
				code: "SDK_MODEL_NOT_FOUND",
			});
		});

		it("classifies 429 as SDK_RATE_LIMITED", async () => {
			const diClient = makeDiClient(() => Promise.reject({ status: 429, message: "rate limited" }));
			const client = new AnthropicClient({ _client: diClient });

			await expect(client.call(baseRequest)).rejects.toMatchObject({ code: "SDK_RATE_LIMITED" });
		});

		it("classifies 529 as SDK_OVERLOADED", async () => {
			const diClient = makeDiClient(() => Promise.reject({ status: 529, message: "overloaded" }));
			const client = new AnthropicClient({ _client: diClient });

			await expect(client.call(baseRequest)).rejects.toMatchObject({ code: "SDK_OVERLOADED" });
		});

		it("classifies plain Error as SDK_API_ERROR", async () => {
			const diClient = makeDiClient(() => Promise.reject(new Error("network error")));
			const client = new AnthropicClient({ _client: diClient });

			await expect(client.call(baseRequest)).rejects.toMatchObject({ code: "SDK_API_ERROR" });
		});

		it("classifies missing ANTHROPIC_API_KEY error as SDK_AUTH_FAILED", async () => {
			const diClient = makeDiClient(() =>
				Promise.reject(
					new Error(
						"The ANTHROPIC_API_KEY environment variable is missing or empty; either provide it, or instantiate the Anthropic client with an apiKey option",
					),
				),
			);
			const client = new AnthropicClient({ _client: diClient });

			await expect(client.call(baseRequest)).rejects.toMatchObject({ code: "SDK_AUTH_FAILED" });
		});

		it("classifies 'api key' message as SDK_AUTH_FAILED when no status", async () => {
			const diClient = makeDiClient(() => Promise.reject(new Error("Invalid API key provided")));
			const client = new AnthropicClient({ _client: diClient });

			await expect(client.call(baseRequest)).rejects.toMatchObject({ code: "SDK_AUTH_FAILED" });
		});

		it("classifies 'authentication' message as SDK_AUTH_FAILED when no status", async () => {
			const diClient = makeDiClient(() =>
				Promise.reject(new Error("authentication failed: no credentials")),
			);
			const client = new AnthropicClient({ _client: diClient });

			await expect(client.call(baseRequest)).rejects.toMatchObject({ code: "SDK_AUTH_FAILED" });
		});
	});

	describe("baseURL passthrough", () => {
		it("passes baseURL to the SDK constructor", async () => {
			let capturedOpts: Record<string, unknown> | undefined;
			mock.module("@anthropic-ai/sdk", () => ({
				default: class MockAnthropic {
					messages = {
						create: () => Promise.resolve(makeSdkResponse()),
					};
					constructor(opts?: Record<string, unknown>) {
						capturedOpts = opts;
					}
				},
			}));

			const client = new AnthropicClient({
				baseURL: "https://api.minimax.io/anthropic",
			});
			await client.call(baseRequest);

			expect(capturedOpts).toBeDefined();
			expect(capturedOpts?.baseURL).toBe("https://api.minimax.io/anthropic");
		});

		it("omits baseURL from constructor when not provided", async () => {
			let capturedOpts: Record<string, unknown> | undefined;
			mock.module("@anthropic-ai/sdk", () => ({
				default: class MockAnthropic {
					messages = {
						create: () => Promise.resolve(makeSdkResponse()),
					};
					constructor(opts?: Record<string, unknown>) {
						capturedOpts = opts;
					}
				},
			}));

			const client = new AnthropicClient();
			await client.call(baseRequest);

			expect(capturedOpts).toBeUndefined();
		});
	});
});
