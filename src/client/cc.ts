import { ClientError } from "../errors.ts";
import { logger } from "../logging/logger.ts";
import type {
	CcStructuredResponse,
	ContentBlock,
	LlmClient,
	LlmRequest,
	LlmResponse,
} from "./types.ts";

const CC_SCHEMA: Record<string, unknown> = {
	type: "object",
	properties: {
		thinking: {
			type: "string",
			description: "Reasoning about what to do next",
		},
		tool_calls: {
			type: "array",
			items: {
				type: "object",
				properties: {
					name: { type: "string" },
					input: { type: "object" },
				},
				required: ["name", "input"],
			},
		},
		text_response: {
			type: "string",
			description: "Final text when no more tools needed",
		},
	},
	required: ["thinking"],
};

interface CcConfig {
	model?: string;
	cwd?: string;
	claudePath?: string;
}

interface CcRawResponse {
	type: string;
	subtype?: string;
	result?: string | Record<string, unknown>;
	structured_output?: Record<string, unknown>;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
	};
	model?: string;
}

function serializeContentBlock(block: ContentBlock): string {
	if (block.type === "text") {
		return block.text;
	}
	return `[Tool Call: ${block.name}(${JSON.stringify(block.input)})]`;
}

function serializeMessageContent(content: string | ContentBlock[]): string {
	if (typeof content === "string") {
		return content;
	}
	return content.map(serializeContentBlock).join("\n");
}

export class CcClient implements LlmClient {
	readonly id = "cc";

	private readonly model: string | undefined;
	private readonly cwd: string;
	private readonly claudePath: string;

	constructor(config?: CcConfig) {
		this.model = config?.model;
		this.cwd = config?.cwd ?? process.cwd();
		this.claudePath = config?.claudePath ?? "claude";
	}

	estimateTokens(text: string): number {
		return Math.ceil(text.length / 4);
	}

	async call(request: LlmRequest): Promise<LlmResponse> {
		const promptLines: string[] = [];
		for (const msg of request.messages) {
			const content = serializeMessageContent(msg.content as string | ContentBlock[]);
			promptLines.push(`[${msg.role === "user" ? "User" : "Assistant"}]: ${content}`);
		}
		const prompt = promptLines.join("\n");

		const args: string[] = [
			this.claudePath,
			"-p",
			prompt,
			"--system-prompt",
			request.systemPrompt,
			"--tools",
			"",
			"--output-format",
			"json",
		];

		if (request.tools.length > 0) {
			args.push("--json-schema", JSON.stringify(CC_SCHEMA));
		}

		if (request.model ?? this.model) {
			args.push("--model", (request.model ?? this.model) as string);
		}

		// Strip CLAUDECODE env var to avoid "nested sessions" error when
		// sapling is launched from within a Claude Code session.
		const env = { ...process.env };
		delete env.CLAUDECODE;

		logger.debug("Spawning CC subprocess", {
			claude: this.claudePath,
			model: request.model ?? this.model,
			promptLength: prompt.length,
		});

		const proc = Bun.spawn(args, {
			cwd: this.cwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env,
		});

		// Drain stdout/stderr concurrently to avoid pipe deadlock —
		// if the buffer fills before proc.exited is awaited, the subprocess blocks forever.
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);

		logger.debug("CC subprocess exited", { exitCode, stdoutLength: stdout.length });

		if (exitCode !== 0) {
			throw new ClientError(`CC subprocess failed: ${stderr}`, "CC_FAILED");
		}

		let raw: CcRawResponse;
		try {
			raw = JSON.parse(stdout) as CcRawResponse;
		} catch {
			throw new ClientError(`CC subprocess returned invalid JSON: ${stdout}`, "CC_INVALID_JSON");
		}

		logger.debug("CC raw response", {
			type: raw.type,
			subtype: raw.subtype,
			hasResult: raw.result !== undefined,
			hasStructuredOutput: raw.structured_output !== undefined,
			resultType: typeof raw.result,
			keys: Object.keys(raw),
		});

		if (!raw.structured_output && !raw.result) {
			throw new ClientError(
				`CC subprocess response missing result field. Response: ${stdout.slice(0, 500)}`,
				"CC_INVALID_RESPONSE",
			);
		}

		// Prefer structured_output (current claude CLI field) over result (legacy).
		// structured_output is an already-parsed object from --json-schema responses.
		// result may be:
		// 1. A JSON string conforming to CC_SCHEMA (structured response)
		// 2. An already-parsed object (when --json-schema returns an object)
		// 3. Plain text (when --json-schema is ignored, e.g. with --tools "")
		let structured: CcStructuredResponse;
		if (raw.structured_output !== undefined) {
			structured = raw.structured_output as unknown as CcStructuredResponse;
		} else if (typeof raw.result === "object") {
			structured = raw.result as unknown as CcStructuredResponse;
		} else {
			const resultStr = raw.result as string;
			try {
				structured = JSON.parse(resultStr) as CcStructuredResponse;
			} catch {
				// Plain text response — treat as text_response with no tool calls
				structured = { thinking: "", text_response: resultStr };
			}
		}

		const content: ContentBlock[] = [];

		if (structured.thinking) {
			content.push({ type: "text", text: structured.thinking });
		}

		let stopReason: "end_turn" | "tool_use" | "max_tokens" = "end_turn";

		if (structured.tool_calls && structured.tool_calls.length > 0) {
			stopReason = "tool_use";
			for (const tc of structured.tool_calls) {
				content.push({
					type: "tool_use",
					id: crypto.randomUUID(),
					name: tc.name,
					input: tc.input,
				});
			}
		} else if (structured.text_response) {
			content.push({ type: "text", text: structured.text_response });
		}

		const usage = raw.usage ?? {};

		return {
			content,
			usage: {
				inputTokens: usage.input_tokens ?? 0,
				outputTokens: usage.output_tokens ?? 0,
				cacheReadTokens: usage.cache_read_input_tokens,
				cacheCreationTokens: usage.cache_creation_input_tokens,
			},
			model: raw.model ?? request.model ?? this.model ?? "unknown",
			stopReason,
		};
	}
}
