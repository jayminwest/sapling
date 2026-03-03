/**
 * Guard evaluator functions for HookManager.
 *
 * Each guard is a pure synchronous function that inspects tool call inputs
 * and returns { allowed: boolean; reason?: string }.
 *
 * Guards are applied in this order by evaluateGuards():
 *   blockedTools → readOnly → pathBoundary → fileScope → blockedBashPatterns
 */

import { resolve } from "node:path";
import type { GuardConfig } from "../types.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GuardResult {
	allowed: boolean;
	reason?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Tools that access files by path (input.file_path or input.path). */
const FILE_ACCESS_TOOLS = new Set(["read", "write", "edit", "glob", "grep"]);

/** Tools that mutate files (write or edit). */
const FILE_MUTATE_TOOLS = new Set(["write", "edit"]);

/**
 * Extract a path string from tool input.
 * read/write/edit use input.file_path; glob/grep use input.path.
 */
function extractPath(input: Record<string, unknown>): string | undefined {
	const fp = input.file_path;
	if (typeof fp === "string") return fp;
	const p = input.path;
	if (typeof p === "string") return p;
	return undefined;
}

// ─── Guards ───────────────────────────────────────────────────────────────────

/**
 * Block file operations outside the given pathBoundary.
 * Uses path.resolve() for normalization — no filesystem access.
 */
export function checkPathBoundary(
	toolName: string,
	input: Record<string, unknown>,
	pathBoundary: string,
): GuardResult {
	if (!FILE_ACCESS_TOOLS.has(toolName)) {
		return { allowed: true };
	}
	const rawPath = extractPath(input);
	if (!rawPath) {
		// No path in input — guard does not apply
		return { allowed: true };
	}
	const resolvedTarget = resolve(rawPath);
	const resolvedBoundary = resolve(pathBoundary);
	// Allow if path equals boundary or is inside it
	if (resolvedTarget === resolvedBoundary || resolvedTarget.startsWith(`${resolvedBoundary}/`)) {
		return { allowed: true };
	}
	return {
		allowed: false,
		reason: `Path "${resolvedTarget}" is outside the allowed boundary "${resolvedBoundary}"`,
	};
}

/**
 * Block file-mutating operations on files not in the allowed scope list.
 * Only applies to write and edit tools.
 */
export function checkFileScope(
	toolName: string,
	input: Record<string, unknown>,
	fileScope: string[],
): GuardResult {
	if (!FILE_MUTATE_TOOLS.has(toolName)) {
		return { allowed: true };
	}
	const rawPath = input.file_path;
	if (typeof rawPath !== "string") {
		// No file_path — guard does not apply
		return { allowed: true };
	}
	const resolvedTarget = resolve(rawPath);
	const resolvedScope = fileScope.map((f) => resolve(f));
	if (resolvedScope.includes(resolvedTarget)) {
		return { allowed: true };
	}
	return {
		allowed: false,
		reason: `File "${resolvedTarget}" is outside the allowed file scope`,
	};
}

/**
 * Block write, edit, and bash tools when read-only mode is active.
 */
export function checkReadOnly(toolName: string, readOnly: boolean): GuardResult {
	if (!readOnly) {
		return { allowed: true };
	}
	if (toolName === "write" || toolName === "edit" || toolName === "bash") {
		return {
			allowed: false,
			reason: `Tool "${toolName}" is blocked in read-only mode`,
		};
	}
	return { allowed: true };
}

/**
 * Block bash commands that match any of the given regex patterns.
 * Only applies to the bash tool.
 */
export function checkBlockedBashPatterns(
	toolName: string,
	input: Record<string, unknown>,
	patterns: string[],
): GuardResult {
	if (toolName !== "bash") {
		return { allowed: true };
	}
	const command = input.command;
	if (typeof command !== "string") {
		return { allowed: true };
	}
	for (const pattern of patterns) {
		if (new RegExp(pattern).test(command)) {
			return {
				allowed: false,
				reason: `Bash command matches blocked pattern "${pattern}"`,
			};
		}
	}
	return { allowed: true };
}

/**
 * Block tools that appear in the blockedTools list.
 */
export function checkBlockedTools(toolName: string, blockedTools: string[]): GuardResult {
	if (blockedTools.includes(toolName)) {
		return {
			allowed: false,
			reason: `Tool "${toolName}" is blocked`,
		};
	}
	return { allowed: true };
}

/**
 * Evaluate all flat guards from the config.
 *
 * Order: blockedTools → readOnly → pathBoundary → fileScope → blockedBashPatterns
 * Returns the first block result, or { allowed: true } if all pass.
 * Skips guards whose config fields are undefined.
 */
export function evaluateGuards(
	toolName: string,
	input: Record<string, unknown>,
	config: GuardConfig,
): GuardResult {
	if (config.blockedTools !== undefined) {
		const result = checkBlockedTools(toolName, config.blockedTools);
		if (!result.allowed) return result;
	}

	if (config.readOnly !== undefined) {
		const result = checkReadOnly(toolName, config.readOnly);
		if (!result.allowed) return result;
	}

	if (config.pathBoundary !== undefined) {
		const result = checkPathBoundary(toolName, input, config.pathBoundary);
		if (!result.allowed) return result;
	}

	if (config.fileScope !== undefined) {
		const result = checkFileScope(toolName, input, config.fileScope);
		if (!result.allowed) return result;
	}

	if (config.blockedBashPatterns !== undefined) {
		const result = checkBlockedBashPatterns(toolName, input, config.blockedBashPatterns);
		if (!result.allowed) return result;
	}

	return { allowed: true };
}
