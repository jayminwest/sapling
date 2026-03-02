import { ToolError } from "../errors.ts";
import type { Tool, ToolResult } from "./types.ts";

const DEFAULT_LINE_LIMIT = 2000;

export class ReadTool implements Tool {
	readonly name = "read";
	readonly description =
		"Read a file from the filesystem. Returns content with line numbers (like cat -n). " +
		"Supports offset and limit for large files. Truncates files beyond 2000 lines by default.";

	readonly inputSchema = {
		type: "object",
		properties: {
			file_path: {
				type: "string",
				description: "Absolute path to the file to read",
			},
			offset: {
				type: "number",
				description: "Line number to start reading from (1-indexed)",
			},
			limit: {
				type: "number",
				description: "Number of lines to read",
			},
		},
		required: ["file_path"],
	};

	async execute(input: Record<string, unknown>, _cwd: string): Promise<ToolResult> {
		const filePath = input.file_path;
		if (typeof filePath !== "string" || filePath.trim() === "") {
			throw new ToolError("file_path must be a non-empty string", "INVALID_INPUT");
		}

		const offset = typeof input.offset === "number" ? Math.max(1, input.offset) : 1;
		const limit =
			typeof input.limit === "number"
				? Math.min(input.limit, DEFAULT_LINE_LIMIT)
				: DEFAULT_LINE_LIMIT;

		const file = Bun.file(filePath);
		const exists = await file.exists();
		if (!exists) {
			return {
				content: `File not found: ${filePath}`,
				isError: true,
			};
		}

		const text = await file.text();
		const allLines = text.split("\n");

		// Remove trailing empty line from split if file ends with newline
		const lines = allLines[allLines.length - 1] === "" ? allLines.slice(0, -1) : allLines;

		const startIdx = offset - 1; // convert to 0-indexed
		const endIdx = Math.min(startIdx + limit, lines.length);
		const selectedLines = lines.slice(startIdx, endIdx);

		const truncated = endIdx < lines.length || startIdx > 0;

		const numbered = selectedLines
			.map((line, i) => {
				const lineNum = startIdx + i + 1;
				return `${String(lineNum).padStart(6)}\t${line}`;
			})
			.join("\n");

		const header = truncated ? `[Lines ${startIdx + 1}-${endIdx} of ${lines.length} total]\n` : "";

		const content = header + numbered;

		return {
			content,
			metadata: {
				tokensEstimate: Math.ceil(content.length / 4),
				filePath,
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

export const readTool = new ReadTool();
