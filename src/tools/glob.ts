import { stat } from "node:fs/promises";
import { join } from "node:path";
import { ToolError } from "../errors.ts";
import type { Tool, ToolResult } from "./types.ts";

const DEFAULT_FILE_LIMIT = 500;

export class GlobTool implements Tool {
	readonly name = "glob";
	dryRun = false;
	readonly description =
		"Find files matching a glob pattern. Returns paths sorted by modification time (most recent first). " +
		"Truncates beyond 500 files by default.";

	readonly inputSchema = {
		type: "object",
		properties: {
			pattern: {
				type: "string",
				description: "Glob pattern to match (e.g. '**/*.ts', 'src/**/*.json')",
			},
			path: {
				type: "string",
				description: "Directory to search in (default: cwd)",
			},
		},
		required: ["pattern"],
	};

	async execute(input: Record<string, unknown>, cwd: string): Promise<ToolResult> {
		const pattern = input.pattern;
		if (typeof pattern !== "string" || pattern.trim() === "") {
			throw new ToolError("pattern must be a non-empty string", "INVALID_INPUT");
		}

		const searchDir = typeof input.path === "string" ? input.path : cwd;

		if (this.dryRun) {
			return {
				content: `[dry-run] Would glob pattern "${pattern}" in ${searchDir}`,
				metadata: { tokensEstimate: Math.ceil(pattern.length / 4) },
			};
		}

		const glob = new Bun.Glob(pattern);
		const matchedPaths: string[] = [];

		for await (const file of glob.scan({ cwd: searchDir, absolute: false })) {
			matchedPaths.push(file);
		}

		if (matchedPaths.length === 0) {
			return {
				content: "No files matched",
				metadata: { tokensEstimate: 3 },
			};
		}

		// Sort by modification time (most recent first)
		const withMtimes = await Promise.all(
			matchedPaths.map(async (p) => {
				try {
					const s = await stat(join(searchDir, p));
					return { path: p, mtime: s.mtimeMs };
				} catch {
					return { path: p, mtime: 0 };
				}
			}),
		);

		withMtimes.sort((a, b) => b.mtime - a.mtime);

		let truncated = false;
		let sorted = withMtimes.map((e) => e.path);

		if (sorted.length > DEFAULT_FILE_LIMIT) {
			sorted = sorted.slice(0, DEFAULT_FILE_LIMIT);
			truncated = true;
		}

		const output = sorted.join("\n");

		return {
			content: output,
			metadata: {
				tokensEstimate: Math.ceil(output.length / 4),
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

export const globTool = new GlobTool();
