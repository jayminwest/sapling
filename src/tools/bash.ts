import { ToolError } from "../errors.ts";
import type { Tool, ToolResult } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_LIMIT = 50_000;

export class BashTool implements Tool {
	readonly name = "bash";
	readonly description =
		"Execute a shell command. Captures stdout and stderr. Returns exit code and output.";

	readonly inputSchema = {
		type: "object",
		properties: {
			command: {
				type: "string",
				description: "The shell command to execute",
			},
			timeout: {
				type: "number",
				description: "Timeout in milliseconds (default: 120000)",
			},
		},
		required: ["command"],
	};

	async execute(input: Record<string, unknown>, cwd: string): Promise<ToolResult> {
		const command = input.command;
		if (typeof command !== "string" || command.trim() === "") {
			throw new ToolError("command must be a non-empty string", "INVALID_INPUT");
		}

		const timeoutMs = typeof input.timeout === "number" ? input.timeout : DEFAULT_TIMEOUT_MS;

		const proc = Bun.spawn(["bash", "-c", command], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});

		const timeoutId = setTimeout(() => {
			proc.kill();
		}, timeoutMs);

		let exitCode: number;
		try {
			exitCode = await proc.exited;
		} finally {
			clearTimeout(timeoutId);
		}

		const [stdoutText, stderrText] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);

		let output = stdoutText;
		if (stderrText) {
			output = output ? `${output}\n[stderr]\n${stderrText}` : `[stderr]\n${stderrText}`;
		}

		let truncated = false;
		if (output.length > DEFAULT_OUTPUT_LIMIT) {
			output = `${output.slice(0, DEFAULT_OUTPUT_LIMIT)}\n...[truncated]`;
			truncated = true;
		}

		const content = `Exit code: ${exitCode}\n${output}`.trimEnd();

		return {
			content,
			isError: exitCode !== 0,
			metadata: {
				tokensEstimate: Math.ceil(content.length / 4),
				truncated,
			},
		};
	}

	toDefinition() {
		return {
			name: this.name,
			description: this.description,
			input_schema: this.inputSchema,
		};
	}
}

export const bashTool = new BashTool();
