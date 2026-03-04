/**
 * Session history tracking for Sapling.
 *
 * Appends JSONL records to .sapling/session.jsonl after each completed task.
 * Silently no-ops if .sapling/ directory does not exist (project not initialized).
 */

import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { SessionRecord } from "./types.ts";

/**
 * Collapse newlines to spaces, trim, and truncate to 200 chars with "..." suffix.
 */
export function summarizePrompt(prompt: string): string {
	const collapsed = prompt.replace(/\n+/g, " ").trim();
	if (collapsed.length <= 200) return collapsed;
	return `${collapsed.slice(0, 200)}...`;
}

/**
 * Append a session record as a JSONL line to .sapling/session.jsonl.
 * Silently no-ops if .sapling/ directory does not exist.
 */
export function appendSessionRecord(cwd: string, record: SessionRecord): void {
	const saplingDir = join(cwd, ".sapling");
	if (!existsSync(saplingDir)) return;
	const sessionFile = join(saplingDir, "session.jsonl");
	appendFileSync(sessionFile, `${JSON.stringify(record)}\n`);
}
