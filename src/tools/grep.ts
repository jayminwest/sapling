import { ToolError } from "../errors.ts";
import type { Tool, ToolResult } from "./types.ts";

function _shellEscape(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Resolve the ripgrep invocation prefix.
 * Prefers the `rg` binary if available in PATH.
 * Falls back to `claude --ripgrep` if the claude binary provides bundled ripgrep.
 * The result is cached after first resolution.
 */
let _rgPrefix: string[] | null = null;

async function resolveRgPrefix(): Promise<string[]> {
	if (_rgPrefix !== null) return _rgPrefix;

	// Try rg as a direct binary first
	const rgPath = Bun.which("rg");
	if (rgPath !== null) {
		_rgPrefix = [rgPath];
		return _rgPrefix;
	}

	// Fall back to claude --ripgrep (bundled ripgrep in CC binary)
	const claudePath = Bun.which("claude");
	if (claudePath !== null) {
		const test = Bun.spawn([claudePath, "--ripgrep", "--version"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const code = await test.exited;
		if (code === 0) {
			_rgPrefix = [claudePath, "--ripgrep"];
			return _rgPrefix;
		}
	}

	throw new ToolError(
		"ripgrep (rg) not found. Install ripgrep: brew install ripgrep",
		"RG_NOT_FOUND",
	);
}

const DEFAULT_MATCH_LIMIT = 100;

type OutputMode = "files_with_matches" | "content" | "count";

export class GrepTool implements Tool {
	readonly name = "grep";
	dryRun = false;
	readonly description =
		"Search file contents using ripgrep (rg). " +
		"Three output modes: files_with_matches (default), content, count. " +
		"Supports regex patterns, path filtering, and context lines.";

	readonly inputSchema = {
		type: "object",
		properties: {
			pattern: {
				type: "string",
				description: "Regex pattern to search for",
			},
			path: {
				type: "string",
				description: "File or directory to search in (default: cwd)",
			},
			glob: {
				type: "string",
				description: "Glob pattern to filter files (e.g. '*.ts')",
			},
			output_mode: {
				type: "string",
				description: "Output mode: files_with_matches, content, or count",
				enum: ["files_with_matches", "content", "count"],
			},
			context: {
				type: "number",
				description: "Number of context lines before and after each match",
			},
			case_insensitive: {
				type: "boolean",
				description: "Case-insensitive search",
			},
		},
		required: ["pattern"],
	};

	async execute(input: Record<string, unknown>, cwd: string): Promise<ToolResult> {
		const pattern = input.pattern;
		if (typeof pattern !== "string" || pattern.trim() === "") {
			throw new ToolError("pattern must be a non-empty string", "INVALID_INPUT");
		}

		const searchPath = typeof input.path === "string" ? input.path : cwd;

		if (this.dryRun) {
			return {
				content: `[dry-run] Would search for pattern "${pattern}" in ${searchPath}`,
				metadata: { tokensEstimate: Math.ceil(pattern.length / 4) },
			};
		}

		const outputMode: OutputMode =
			input.output_mode === "content" || input.output_mode === "count"
				? input.output_mode
				: "files_with_matches";

		const rgPrefix = await resolveRgPrefix();
		const args = [...rgPrefix];

		if (outputMode === "files_with_matches") {
			args.push("--files-with-matches");
		} else if (outputMode === "count") {
			args.push("--count");
		}
		// content mode: no special flag, use default line output

		if (typeof input.glob === "string") {
			args.push("--glob", input.glob);
		}

		if (typeof input.context === "number") {
			args.push("--context", String(input.context));
		}

		if (input.case_insensitive === true || input.case_insensitive === "true") {
			args.push("--ignore-case");
		}

		args.push("--", pattern, searchPath);

		const proc = Bun.spawn(args, {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});

		const [exitCode, stdoutText, stderrText] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);

		// exit code 1 from rg = no matches found (not an error)
		if (exitCode > 1) {
			return {
				content: `grep failed: ${stderrText}`,
				isError: true,
			};
		}

		if (exitCode === 1 || stdoutText.trim() === "") {
			return {
				content: "No matches found",
				metadata: { tokensEstimate: 3 },
			};
		}

		const lines = stdoutText.trimEnd().split("\n");
		let truncated = false;
		let output: string;

		if (lines.length > DEFAULT_MATCH_LIMIT) {
			output = `${lines.slice(0, DEFAULT_MATCH_LIMIT).join("\n")}\n...[truncated]`;
			truncated = true;
		} else {
			output = stdoutText.trimEnd();
		}

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

export const grepTool = new GrepTool();
