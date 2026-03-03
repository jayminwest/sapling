import { ClientError } from "../errors.ts";
import type { ContentBlock, LlmClient, LlmRequest, LlmResponse } from "./types.ts";

interface AnthropicConfig {
	model?: string;
	apiKey?: string;
	_client?: SdkClient;
}

export interface SdkTextBlock {
	type: "text";
	text: string;
}

export interface SdkToolUseBlock {
	type: "tool_use";
	id: string;
	name: string;
	input: Record<string, unknown>;
}

export type SdkContentBlock = SdkTextBlock | SdkToolUseBlock;

export interface SdkResponse {
	content: SdkContentBlock[];
	usage: {
		input_tokens: number;
		output_tokens: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
	};
	model: string;
	stop_reason: string;
}

export interface SdkClient {
	messages: {
		create(params: {
			model: string;
			system: string;
			messages: unknown[];
			tools: unknown[];
			max_tokens: number;
		}): Promise<SdkResponse>;
	};
}

function classifySdkError(err: unknown): { message: string; code: string } {
	const message = err instanceof Error ? err.message : String(err);
	const status =
		typeof err === "object" && err !== null && "status" in err
			? (err as { status: unknown }).status
			: undefined;
	if (typeof status === "number") {
		switch (status) {
			case 401:
				return { message, code: "SDK_AUTH_FAILED" };
			case 403:
				return { message, code: "SDK_PERMISSION_DENIED" };
			case 404:
				return { message, code: "SDK_MODEL_NOT_FOUND" };
			case 429:
				return { message, code: "SDK_RATE_LIMITED" };
			case 529:
				return { message, code: "SDK_OVERLOADED" };
		}
	}
	return { message, code: "SDK_API_ERROR" };
}

export class AnthropicClient implements LlmClient {
	readonly id = "anthropic-sdk";

	private readonly model: string | undefined;
	private readonly apiKey: string | undefined;
	private sdkClient: SdkClient | null = null;

	constructor(config?: AnthropicConfig) {
		this.model = config?.model;
		this.apiKey = config?.apiKey;
		if (config?._client) {
			this.sdkClient = config._client;
		}
	}

	estimateTokens(text: string): number {
		return Math.ceil(text.length / 4);
	}

	private async getClient(): Promise<SdkClient> {
		if (this.sdkClient) {
			return this.sdkClient;
		}

		let mod: { default?: unknown } | undefined;
		try {
			mod = await import("@anthropic-ai/sdk");
		} catch {
			throw new ClientError(
				"@anthropic-ai/sdk not installed. Install it: bun add @anthropic-ai/sdk",
				"SDK_NOT_INSTALLED",
			);
		}

		const AnthropicSdk = mod?.default;
		if (!AnthropicSdk || typeof AnthropicSdk !== "function") {
			throw new ClientError(
				"@anthropic-ai/sdk not installed. Install it: bun add @anthropic-ai/sdk",
				"SDK_NOT_INSTALLED",
			);
		}

		const ctor = AnthropicSdk as new (opts?: { apiKey?: string }) => SdkClient;
		this.sdkClient = new ctor(this.apiKey ? { apiKey: this.apiKey } : undefined);
		return this.sdkClient;
	}

	async call(request: LlmRequest): Promise<LlmResponse> {
		let client: SdkClient;
		try {
			client = await this.getClient();
		} catch (err) {
			if (err instanceof ClientError) throw err;
			throw new ClientError("Failed to initialize Anthropic SDK", "SDK_NOT_INSTALLED", {
				cause: err,
			});
		}

		try {
			const response = await client.messages.create({
				model: request.model ?? this.model ?? "claude-sonnet-4-6",
				system: request.systemPrompt,
				messages: request.messages,
				tools: request.tools,
				max_tokens: request.maxTokens ?? 8192,
			});

			const content: ContentBlock[] = response.content.map((block): ContentBlock => {
				if (block.type === "text") {
					return { type: "text", text: block.text };
				}
				return {
					type: "tool_use",
					id: block.id,
					name: block.name,
					input: block.input,
				};
			});

			const stopReason = response.stop_reason as "end_turn" | "tool_use" | "max_tokens";

			return {
				content,
				usage: {
					inputTokens: response.usage.input_tokens,
					outputTokens: response.usage.output_tokens,
					cacheReadTokens: response.usage.cache_read_input_tokens,
					cacheCreationTokens: response.usage.cache_creation_input_tokens,
				},
				model: response.model,
				stopReason,
			};
		} catch (err) {
			if (err instanceof ClientError) throw err;
			const classified = classifySdkError(err);
			throw new ClientError(classified.message, classified.code, { cause: err });
		}
	}
}
