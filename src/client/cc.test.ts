// WHY MOCK: CC subprocess calls have real API costs and require a valid claude CLI installation.
// We mock Bun.spawn to return controlled output so we can test response parsing and error handling.

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { CcClient } from "./cc.ts";
import type { LlmRequest } from "./types.ts";

const baseRequest: LlmRequest = {
	systemPrompt: "You are a helpful assistant.",
	messages: [{ role: "user", content: "Hello" }],
	tools: [],
};

function makeFakeProcess(opts: { exitCode: number; stdout: string; stderr?: string }) {
	const encoder = new TextEncoder();
	const stdoutBytes = encoder.encode(opts.stdout);
	const stderrBytes = encoder.encode(opts.stderr ?? "");

	return {
		exited: Promise.resolve(opts.exitCode),
		kill: () => {},
		stdout: new ReadableStream({
			start(controller) {
				controller.enqueue(stdoutBytes);
				controller.close();
			},
		}),
		stderr: new ReadableStream({
			start(controller) {
				controller.enqueue(stderrBytes);
				controller.close();
			},
		}),
	};
}

// A process that never exits — simulates a hung subprocess for timeout tests.
function makeHangingProcess() {
	return {
		exited: new Promise<number>(() => {}),
		kill: () => {},
		stdout: new ReadableStream({
			start() {
				// Never close — simulates blocked output
			},
		}),
		stderr: new ReadableStream({
			start(controller) {
				controller.close();
			},
		}),
	};
}

function makeCcOutput(structured: unknown, usage?: unknown, model?: string): string {
	return JSON.stringify({
		type: "result",
		subtype: "success",
		structured_output: structured,
		result: "Plain text summary (ignored when structured_output present)",
		usage: usage ?? { input_tokens: 10, output_tokens: 5 },
		model: model ?? "claude-sonnet-4-6",
	});
}

function makeCcOutputLegacy(structured: unknown, usage?: unknown, model?: string): string {
	return JSON.stringify({
		type: "result",
		subtype: "success",
		result: JSON.stringify(structured),
		usage: usage ?? { input_tokens: 10, output_tokens: 5 },
		model: model ?? "claude-sonnet-4-6",
	});
}

describe("CcClient", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	describe("estimateTokens", () => {
		const client = new CcClient();

		it("estimates tokens for short text", () => {
			expect(client.estimateTokens("hello")).toBe(2); // ceil(5/4) = 2
		});

		it("returns 0 for empty string", () => {
			expect(client.estimateTokens("")).toBe(0);
		});

		it("returns 1 for 4-char string", () => {
			expect(client.estimateTokens("abcd")).toBe(1);
		});
	});

	describe("id", () => {
		it("returns cc", () => {
			const client = new CcClient();
			expect(client.id).toBe("cc");
		});
	});

	describe("call", () => {
		it("parses valid CC response with tool_calls", async () => {
			const structured = {
				thinking: "I need to call a tool.",
				tool_calls: [{ name: "bash", input: { command: "ls" } }],
			};
			spawnSpy.mockReturnValue(makeFakeProcess({ exitCode: 0, stdout: makeCcOutput(structured) }));

			const client = new CcClient();
			const result = await client.call({
				...baseRequest,
				tools: [{ name: "bash", description: "run bash", input_schema: {} }],
			});

			expect(result.stopReason).toBe("tool_use");
			const toolBlock = result.content.find((b) => b.type === "tool_use");
			expect(toolBlock).toBeDefined();
			if (toolBlock?.type === "tool_use") {
				expect(toolBlock.name).toBe("bash");
				expect(toolBlock.input).toEqual({ command: "ls" });
				expect(typeof toolBlock.id).toBe("string");
			}
			const textBlock = result.content.find((b) => b.type === "text");
			expect(textBlock).toBeDefined();
		});

		it("parses valid CC response with text_response only", async () => {
			const structured = {
				thinking: "Task is done.",
				text_response: "All done!",
			};
			spawnSpy.mockReturnValue(makeFakeProcess({ exitCode: 0, stdout: makeCcOutput(structured) }));

			const client = new CcClient();
			const result = await client.call(baseRequest);

			expect(result.stopReason).toBe("end_turn");
			const textBlocks = result.content.filter((b) => b.type === "text");
			expect(textBlocks.length).toBe(2);
			const texts = textBlocks.map((b) => (b.type === "text" ? b.text : ""));
			expect(texts).toContain("All done!");
			expect(texts).toContain("Task is done.");
		});

		it("throws ClientError with CC_FAILED on non-zero exit code", async () => {
			spawnSpy.mockReturnValue(makeFakeProcess({ exitCode: 1, stdout: "", stderr: "auth failed" }));

			const client = new CcClient();
			await expect(client.call(baseRequest)).rejects.toMatchObject({
				code: "CC_FAILED",
			});
		});

		it("throws ClientError on malformed outer JSON", async () => {
			spawnSpy.mockReturnValue(makeFakeProcess({ exitCode: 0, stdout: "not-json" }));

			const client = new CcClient();
			await expect(client.call(baseRequest)).rejects.toMatchObject({
				code: "CC_INVALID_JSON",
			});
		});

		it("injects tool definitions into system prompt when tools provided", async () => {
			const structured = { thinking: "ok", text_response: "done" };
			spawnSpy.mockReturnValue(makeFakeProcess({ exitCode: 0, stdout: makeCcOutput(structured) }));

			const client = new CcClient();
			await client.call({
				...baseRequest,
				tools: [
					{
						name: "bash",
						description: "Run a bash command",
						input_schema: { type: "object", properties: { command: { type: "string" } } },
					},
				],
			});

			const callArgs = spawnSpy.mock.calls[0];
			const args = callArgs?.[0] as string[];
			const sysPromptIndex = args.indexOf("--system-prompt") + 1;
			const systemPromptArg = args[sysPromptIndex];
			expect(systemPromptArg).toContain("## Available Tools");
			expect(systemPromptArg).toContain("**bash**");
			expect(systemPromptArg).toContain("Run a bash command");
		});

		it("includes explicit directive to use exact lowercase names in system prompt", async () => {
			const structured = { thinking: "ok", text_response: "done" };
			spawnSpy.mockReturnValue(makeFakeProcess({ exitCode: 0, stdout: makeCcOutput(structured) }));

			const client = new CcClient();
			await client.call({
				...baseRequest,
				tools: [
					{ name: "bash", description: "run bash", input_schema: {} },
					{ name: "write", description: "write file", input_schema: {} },
				],
			});

			const callArgs = spawnSpy.mock.calls[0];
			const args = callArgs?.[0] as string[];
			const sysPromptIndex = args.indexOf("--system-prompt") + 1;
			const systemPromptArg = args[sysPromptIndex];
			// Must instruct the LLM to use exact names, not capitalized aliases
			expect(systemPromptArg).toContain("MUST use the exact tool names");
			expect(systemPromptArg).toContain("Do not use capitalized names");
			// Must list the allowed names
			expect(systemPromptArg).toContain("bash, write");
		});

		it("normalizes capitalized tool names from CC to lowercase", async () => {
			// CC LLM may return 'Write', 'Read', 'Bash' despite instructions
			const structured = {
				thinking: "Writing a file.",
				tool_calls: [{ name: "Write", input: { file_path: "/tmp/foo.ts", content: "hello" } }],
			};
			spawnSpy.mockReturnValue(makeFakeProcess({ exitCode: 0, stdout: makeCcOutput(structured) }));

			const client = new CcClient();
			const result = await client.call({
				...baseRequest,
				tools: [{ name: "write", description: "write a file", input_schema: {} }],
			});

			expect(result.stopReason).toBe("tool_use");
			const toolBlock = result.content.find((b) => b.type === "tool_use");
			expect(toolBlock).toBeDefined();
			if (toolBlock?.type === "tool_use") {
				// Must be normalized to lowercase 'write', not 'Write'
				expect(toolBlock.name).toBe("write");
			}
		});

		it("normalizes all CC built-in capitalized names to lowercase", async () => {
			const structured = {
				thinking: "Calling multiple tools.",
				tool_calls: [
					{ name: "Read", input: { file_path: "/tmp/a.ts" } },
					{ name: "Bash", input: { command: "ls" } },
					{ name: "Glob", input: { pattern: "**/*.ts" } },
				],
			};
			spawnSpy.mockReturnValue(makeFakeProcess({ exitCode: 0, stdout: makeCcOutput(structured) }));

			const client = new CcClient();
			const result = await client.call({
				...baseRequest,
				tools: [
					{ name: "read", description: "read file", input_schema: {} },
					{ name: "bash", description: "run bash", input_schema: {} },
					{ name: "glob", description: "glob files", input_schema: {} },
				],
			});

			expect(result.stopReason).toBe("tool_use");
			const toolBlocks = result.content.filter((b) => b.type === "tool_use");
			expect(toolBlocks).toHaveLength(3);
			const names = toolBlocks.map((b) => (b.type === "tool_use" ? b.name : ""));
			expect(names).toEqual(["read", "bash", "glob"]);
		});

		it("does not inject tool section when no tools provided", async () => {
			const structured = { thinking: "ok", text_response: "done" };
			spawnSpy.mockReturnValue(makeFakeProcess({ exitCode: 0, stdout: makeCcOutput(structured) }));

			const client = new CcClient();
			await client.call(baseRequest); // tools: []

			const callArgs = spawnSpy.mock.calls[0];
			const args = callArgs?.[0] as string[];
			const sysPromptIndex = args.indexOf("--system-prompt") + 1;
			const systemPromptArg = args[sysPromptIndex];
			expect(systemPromptArg).not.toContain("## Available Tools");
		});

		it("serializes tool_result blocks in user messages correctly", async () => {
			const structured = { thinking: "ok", text_response: "done" };
			spawnSpy.mockReturnValue(makeFakeProcess({ exitCode: 0, stdout: makeCcOutput(structured) }));

			const client = new CcClient();
			const req: LlmRequest = {
				...baseRequest,
				messages: [
					{ role: "user", content: "Run bash" },
					{
						role: "assistant",
						content: [
							{
								type: "tool_use" as const,
								id: "tu-1",
								name: "bash",
								input: { command: "ls" },
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result" as const,
								tool_use_id: "tu-1",
								content: "file1.ts\nfile2.ts",
							},
						] as never,
					},
				],
			};
			await client.call(req);

			const callArgs = spawnSpy.mock.calls[0];
			expect(callArgs).toBeDefined();
			const args = callArgs?.[0] as string[];
			const promptIndex = args.indexOf("-p") + 1;
			const prompt = args[promptIndex];
			// Tool result content must appear verbatim, not as '[Tool Call: undefined(undefined)]'
			expect(prompt).toContain("file1.ts");
			expect(prompt).not.toContain("undefined");
		});

		it("serializes plain text user messages correctly", async () => {
			const structured = { thinking: "ok", text_response: "done" };
			spawnSpy.mockReturnValue(makeFakeProcess({ exitCode: 0, stdout: makeCcOutput(structured) }));

			const client = new CcClient();
			const req: LlmRequest = {
				...baseRequest,
				messages: [{ role: "user", content: "What is 2+2?" }],
			};
			const result = await client.call(req);
			expect(result.content.length).toBeGreaterThan(0);

			// Verify spawn was called with a prompt containing our message
			const callArgs = spawnSpy.mock.calls[0];
			expect(callArgs).toBeDefined();
			const args = callArgs?.[0] as string[];
			const promptIndex = args.indexOf("-p") + 1;
			expect(args[promptIndex]).toContain("What is 2+2?");
		});

		it("sets stopReason to tool_use when tool_calls present", async () => {
			const structured = {
				thinking: "Calling tool",
				tool_calls: [{ name: "read", input: { file_path: "/tmp/foo" } }],
			};
			spawnSpy.mockReturnValue(makeFakeProcess({ exitCode: 0, stdout: makeCcOutput(structured) }));

			const client = new CcClient();
			const result = await client.call({
				...baseRequest,
				tools: [{ name: "read", description: "read file", input_schema: {} }],
			});
			expect(result.stopReason).toBe("tool_use");
		});

		it("prefers structured_output over result when both present", async () => {
			// structured_output has tool_calls; result has plain text — structured_output must win
			const structured = {
				thinking: "Using structured_output field.",
				tool_calls: [{ name: "bash", input: { command: "echo hi" } }],
			};
			spawnSpy.mockReturnValue(makeFakeProcess({ exitCode: 0, stdout: makeCcOutput(structured) }));

			const client = new CcClient();
			const result = await client.call({
				...baseRequest,
				tools: [{ name: "bash", description: "run bash", input_schema: {} }],
			});

			expect(result.stopReason).toBe("tool_use");
			const toolBlock = result.content.find((b) => b.type === "tool_use");
			expect(toolBlock).toBeDefined();
			if (toolBlock?.type === "tool_use") {
				expect(toolBlock.name).toBe("bash");
			}
		});

		it("falls back to result field when structured_output absent (legacy)", async () => {
			const structured = {
				thinking: "Legacy path.",
				text_response: "Done via legacy result field.",
			};
			spawnSpy.mockReturnValue(
				makeFakeProcess({ exitCode: 0, stdout: makeCcOutputLegacy(structured) }),
			);

			const client = new CcClient();
			const result = await client.call(baseRequest);

			expect(result.stopReason).toBe("end_turn");
			const textBlocks = result.content.filter((b) => b.type === "text");
			const texts = textBlocks.map((b) => (b.type === "text" ? b.text : ""));
			expect(texts).toContain("Done via legacy result field.");
		});

		it("throws CC_INVALID_RESPONSE when both structured_output and result absent", async () => {
			const payload = JSON.stringify({ type: "result", subtype: "success" });
			spawnSpy.mockReturnValue(makeFakeProcess({ exitCode: 0, stdout: payload }));

			const client = new CcClient();
			await expect(client.call(baseRequest)).rejects.toMatchObject({
				code: "CC_INVALID_RESPONSE",
			});
		});
	});

	describe("timeout", () => {
		it("throws CC_TIMEOUT when subprocess hangs past timeoutMs", async () => {
			spawnSpy.mockReturnValue(makeHangingProcess());

			const client = new CcClient({ timeoutMs: 50 });
			await expect(client.call(baseRequest)).rejects.toMatchObject({
				code: "CC_TIMEOUT",
			});
		});

		it("does not timeout when subprocess responds before deadline", async () => {
			const structured = { thinking: "fast response", text_response: "done" };
			spawnSpy.mockReturnValue(makeFakeProcess({ exitCode: 0, stdout: makeCcOutput(structured) }));

			// Very short timeout — but fake process resolves immediately so it must not trigger
			const client = new CcClient({ timeoutMs: 5000 });
			const result = await client.call(baseRequest);
			expect(result.stopReason).toBe("end_turn");
		});

		it("uses 120_000ms default timeout when not configured", () => {
			const client = new CcClient();
			// Access private field via cast to verify default
			expect((client as unknown as { timeoutMs: number }).timeoutMs).toBe(120_000);
		});

		it("respects custom timeoutMs from config", () => {
			const client = new CcClient({ timeoutMs: 30_000 });
			expect((client as unknown as { timeoutMs: number }).timeoutMs).toBe(30_000);
		});
	});
});
