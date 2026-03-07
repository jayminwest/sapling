import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { ToolError } from "../errors.ts";
import type { Tool, ToolResult } from "./types.ts";

const DEFAULT_MATCH_LIMIT = 100;

type OutputMode = "files_with_matches" | "content" | "count";

/**
 * Collect all files under `root`, optionally filtering by a glob-like extension pattern.
 * Skips hidden directories and node_modules.
 */
async function collectFiles(root: string, globPattern?: string): Promise<string[]> {
	const results: string[] = [];

	// Convert simple glob (e.g. "*.ts", "*.{ts,tsx}") to a set of extensions
	let extensions: Set<string> | null = null;
	if (globPattern) {
		const exts: string[] = [];
		// Handle *.ext and *.{ext1,ext2} patterns
		const braceMatch = globPattern.match(/^\*\.?\{(.+)\}$/);
		const simpleMatch = globPattern.match(/^\*\.(.+)$/);
		if (braceMatch?.[1]) {
			for (const ext of braceMatch[1].split(",")) {
				exts.push(`.${ext.trim()}`);
			}
		} else if (simpleMatch) {
			exts.push(`.${simpleMatch[1]}`);
		}
		if (exts.length > 0) {
			extensions = new Set(exts);
		}
	}

	async function walk(dir: string): Promise<void> {
		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(fullPath);
			} else if (entry.isFile()) {
				if (extensions) {
					const hasExt = [...extensions].some((ext) => entry.name.endsWith(ext));
					if (!hasExt) continue;
				}
				results.push(fullPath);
			}
		}
	}

	await walk(root);
	return results;
}

/**
 * Pure-JS grep fallback. Searches files using RegExp.
 */
async function jsGrep(
	pattern: string,
	searchPath: string,
	options: {
		outputMode: OutputMode;
		glob?: string;
		context?: number;
		caseInsensitive?: boolean;
	},
): Promise<{ lines: string[]; truncated: boolean }> {
	const flags = options.caseInsensitive ? "i" : "";
	let re: RegExp;
	try {
		re = new RegExp(pattern, flags);
	} catch {
		throw new ToolError(`Invalid regex pattern: ${pattern}`, "INVALID_INPUT");
	}

	// Determine if searchPath is a file or directory
	const pathStat = await stat(searchPath);
	const files = pathStat.isFile() ? [searchPath] : await collectFiles(searchPath, options.glob);

	const lines: string[] = [];
	let truncated = false;
	const contextLines = options.context ?? 0;

	for (const filePath of files) {
		if (lines.length >= DEFAULT_MATCH_LIMIT) {
			truncated = true;
			break;
		}

		let content: string;
		try {
			content = await Bun.file(filePath).text();
		} catch {
			continue;
		}

		const fileLines = content.split("\n");
		const relPath = relative(searchPath, filePath) || filePath;
		const matchingLineNums: number[] = [];

		for (let i = 0; i < fileLines.length; i++) {
			if (re.test(fileLines[i] ?? "")) {
				matchingLineNums.push(i);
			}
		}

		if (matchingLineNums.length === 0) continue;

		if (options.outputMode === "files_with_matches") {
			lines.push(relPath);
		} else if (options.outputMode === "count") {
			lines.push(`${relPath}:${matchingLineNums.length}`);
		} else {
			// content mode
			if (contextLines > 0) {
				// Collect ranges with context, merging overlaps
				const ranges: Array<[number, number]> = [];
				for (const ln of matchingLineNums) {
					const start = Math.max(0, ln - contextLines);
					const end = Math.min(fileLines.length - 1, ln + contextLines);
					const lastRange = ranges[ranges.length - 1];
					if (lastRange && start <= lastRange[1] + 1) {
						lastRange[1] = end;
					} else {
						ranges.push([start, end]);
					}
				}
				for (const [start, end] of ranges) {
					for (let i = start; i <= end; i++) {
						lines.push(`${relPath}:${fileLines[i]}`);
						if (lines.length >= DEFAULT_MATCH_LIMIT) {
							truncated = true;
							break;
						}
					}
					if (truncated) break;
				}
			} else {
				for (const ln of matchingLineNums) {
					lines.push(`${relPath}:${fileLines[ln]}`);
					if (lines.length >= DEFAULT_MATCH_LIMIT) {
						truncated = true;
						break;
					}
				}
			}
		}
	}

	return { lines, truncated };
}

/**
 * Try to run ripgrep as an external binary. Returns null if rg is not available.
 */
async function tryRg(
	args: string[],
	cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string } | null> {
	const rgPath = Bun.which("rg");
	if (rgPath === null) return null;

	const proc = Bun.spawn([rgPath, ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});

	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);

	return { exitCode, stdout, stderr };
}

export class GrepTool implements Tool {
	readonly name = "grep";
	dryRun = false;
	readonly description =
		"Search file contents using ripgrep (rg) with JS fallback. " +
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

		// Build rg args
		const rgArgs: string[] = [];

		if (outputMode === "files_with_matches") {
			rgArgs.push("--files-with-matches");
		} else if (outputMode === "count") {
			rgArgs.push("--count");
		}

		if (typeof input.glob === "string") {
			rgArgs.push("--glob", input.glob);
		}

		if (typeof input.context === "number") {
			rgArgs.push("--context", String(input.context));
		}

		if (input.case_insensitive === true || input.case_insensitive === "true") {
			rgArgs.push("--ignore-case");
		}

		rgArgs.push("--", pattern, searchPath);

		// Try ripgrep first, fall back to JS implementation
		const rgResult = await tryRg(rgArgs, cwd);

		if (rgResult !== null) {
			// exit code 1 from rg = no matches found (not an error)
			if (rgResult.exitCode > 1) {
				return {
					content: `grep failed: ${rgResult.stderr}`,
					isError: true,
				};
			}

			if (rgResult.exitCode === 1 || rgResult.stdout.trim() === "") {
				return {
					content: "No matches found",
					metadata: { tokensEstimate: 3 },
				};
			}

			const lines = rgResult.stdout.trimEnd().split("\n");
			let truncated = false;
			let output: string;

			if (lines.length > DEFAULT_MATCH_LIMIT) {
				output = `${lines.slice(0, DEFAULT_MATCH_LIMIT).join("\n")}\n...[truncated]`;
				truncated = true;
			} else {
				output = rgResult.stdout.trimEnd();
			}

			return {
				content: output,
				metadata: {
					tokensEstimate: Math.ceil(output.length / 4),
					truncated,
				},
			};
		}

		// JS fallback
		const jsResult = await jsGrep(pattern, searchPath, {
			outputMode,
			glob: typeof input.glob === "string" ? input.glob : undefined,
			context: typeof input.context === "number" ? input.context : undefined,
			caseInsensitive: input.case_insensitive === true || input.case_insensitive === "true",
		});

		if (jsResult.lines.length === 0) {
			return {
				content: "No matches found",
				metadata: { tokensEstimate: 3 },
			};
		}

		let output: string;
		if (jsResult.truncated) {
			output = `${jsResult.lines.join("\n")}\n...[truncated]`;
		} else {
			output = jsResult.lines.join("\n");
		}

		return {
			content: output,
			metadata: {
				tokensEstimate: Math.ceil(output.length / 4),
				truncated: jsResult.truncated,
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
