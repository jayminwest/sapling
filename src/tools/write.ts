import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { ToolError } from "../errors.ts";
import type { Tool, ToolResult } from "./types.ts";

export class WriteTool implements Tool {
	readonly name = "write";
	readonly description =
		"Write content to a file, creating it or overwriting if it exists. " +
		"Creates parent directories as needed. Uses atomic write.";

	readonly inputSchema = {
		type: "object",
		properties: {
			file_path: {
				type: "string",
				description: "Absolute path to the file to write",
			},
			content: {
				type: "string",
				description: "Content to write to the file",
			},
		},
		required: ["file_path", "content"],
	};

	async execute(input: Record<string, unknown>, _cwd: string): Promise<ToolResult> {
		const filePath = input.file_path;
		if (typeof filePath !== "string" || filePath.trim() === "") {
			throw new ToolError("file_path must be a non-empty string", "INVALID_INPUT");
		}

		const content = input.content;
		if (typeof content !== "string") {
			throw new ToolError("content must be a string", "INVALID_INPUT");
		}

		const dir = dirname(filePath);
		await mkdir(dir, { recursive: true });

		await Bun.write(filePath, content);

		const byteSize = new TextEncoder().encode(content).length;

		return {
			content: `Written ${byteSize} bytes to ${filePath}`,
			metadata: {
				filePath,
				tokensEstimate: Math.ceil(content.length / 4),
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

export const writeTool = new WriteTool();
