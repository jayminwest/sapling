import { isAbsolute, resolve } from "node:path";
import { ToolError } from "../errors.ts";
import type { Tool, ToolResult } from "./types.ts";

export class EditTool implements Tool {
	readonly name = "edit";
	dryRun = false;
	readonly description =
		"Perform an exact string replacement in a file. " +
		"Fails if old_string is not found or appears more than once. " +
		"Returns the line range affected by the edit.";

	readonly inputSchema = {
		type: "object",
		properties: {
			file_path: {
				type: "string",
				description: "Path to the file to edit (absolute or relative to cwd)",
			},
			old_string: {
				type: "string",
				description: "Exact text to replace (must appear exactly once)",
			},
			new_string: {
				type: "string",
				description: "Text to replace it with",
			},
		},
		required: ["file_path", "old_string", "new_string"],
	};

	async execute(input: Record<string, unknown>, cwd: string): Promise<ToolResult> {
		const filePath = input.file_path;
		if (typeof filePath !== "string" || filePath.trim() === "") {
			throw new ToolError("file_path must be a non-empty string", "INVALID_INPUT");
		}

		const oldString = input.old_string;
		if (typeof oldString !== "string") {
			throw new ToolError("old_string must be a string", "INVALID_INPUT");
		}

		const newString = input.new_string;
		if (typeof newString !== "string") {
			throw new ToolError("new_string must be a string", "INVALID_INPUT");
		}

		const resolved = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);

		if (this.dryRun) {
			return {
				content: `[dry-run] Would edit ${resolved}: replace old_string with new_string`,
				metadata: { filePath: resolved, tokensEstimate: Math.ceil(newString.length / 4) },
			};
		}

		const file = Bun.file(resolved);
		const exists = await file.exists();
		if (!exists) {
			return {
				content: `File not found: ${resolved}`,
				isError: true,
			};
		}

		const original = await file.text();

		const firstIdx = original.indexOf(oldString);
		if (firstIdx === -1) {
			return {
				content: `old_string not found in ${resolved}`,
				isError: true,
			};
		}

		const secondIdx = original.indexOf(oldString, firstIdx + 1);
		if (secondIdx !== -1) {
			return {
				content: `old_string appears more than once in ${resolved} — must be unique`,
				isError: true,
			};
		}

		const updated =
			original.slice(0, firstIdx) + newString + original.slice(firstIdx + oldString.length);
		await Bun.write(resolved, updated);

		// Determine the line range affected
		const beforeEdit = original.slice(0, firstIdx);
		const startLine = beforeEdit.split("\n").length;
		const endLine = startLine + newString.split("\n").length - 1;

		return {
			content: `Edited ${resolved}: lines ${startLine}-${endLine}`,
			metadata: {
				filePath: resolved,
				tokensEstimate: Math.ceil(newString.length / 4),
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

export const editTool = new EditTool();
