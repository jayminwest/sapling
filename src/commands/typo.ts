/**
 * Typo suggestion handler for unknown sapling commands.
 * Uses Levenshtein distance to find close matches.
 */

import type { Command } from "commander";

/**
 * Compute Levenshtein edit distance between two strings.
 * Uses a flat 1D array to avoid index access issues.
 */
function levenshtein(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	// dp[i*(n+1)+j] = edit distance between a[0..i) and b[0..j)
	const dp = new Uint16Array((m + 1) * (n + 1));
	const idx = (i: number, j: number) => i * (n + 1) + j;
	for (let i = 0; i <= m; i++) dp[idx(i, 0)] = i;
	for (let j = 0; j <= n; j++) dp[idx(0, j)] = j;
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			dp[idx(i, j)] =
				a[i - 1] === b[j - 1]
					? (dp[idx(i - 1, j - 1)] ?? 0)
					: 1 +
						Math.min(dp[idx(i - 1, j)] ?? 0, dp[idx(i, j - 1)] ?? 0, dp[idx(i - 1, j - 1)] ?? 0);
		}
	}
	return dp[idx(m, n)] ?? 0;
}

/**
 * Find the closest command name to `input` from `candidates`.
 * Returns the best match if within distance <= 2, otherwise undefined.
 */
export function suggestCommand(input: string, candidates: string[]): string | undefined {
	let bestMatch: string | undefined;
	let bestDist = 3; // Only suggest if distance <= 2
	for (const name of candidates) {
		const dist = levenshtein(input, name);
		if (dist < bestDist) {
			bestDist = dist;
			bestMatch = name;
		}
	}
	return bestMatch;
}

/**
 * Register the unknown-command handler on the program.
 * When a user types an unknown command, prints a "Did you mean?" suggestion.
 */
export function registerTypoHandler(program: Command): void {
	program.on("command:*", (operands: string[]) => {
		const unknown = operands[0] ?? "";
		const knownNames = program.commands.map((c) => c.name());
		process.stderr.write(`Unknown command: ${unknown}\n`);
		const suggestion = suggestCommand(unknown, knownNames);
		if (suggestion) {
			process.stderr.write(`Did you mean ${suggestion}?\n`);
		}
		process.stderr.write(`Run 'sp --help' for usage.\n`);
		process.exitCode = 1;
	});
}
