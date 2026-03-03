/**
 * HookManager — loads guard config and provides pre/post tool call hooks.
 *
 * Rules are evaluated in order. For pre_tool_call:
 *   - "block" → return false (tool call is rejected)
 *   - "warn"  → log a warning, continue (return true)
 *   - "allow" → return true immediately (short-circuit remaining rules)
 * For post_tool_call:
 *   - "warn"  → log a warning (only meaningful action post-call)
 *   - "block" / "allow" → no-op (cannot undo a completed tool call)
 *
 * A rule with no `tool` field matches ALL tools.
 * A rule with a `tool` field matches only that tool name (case-sensitive).
 */

import { logger } from "../logging/logger.ts";
import type { GuardConfig, IHookManager } from "../types.ts";

export class HookManager implements IHookManager {
	readonly config: GuardConfig;

	constructor(config: GuardConfig) {
		this.config = config;
	}

	/**
	 * Called before a tool executes.
	 * Returns false if a "block" rule matches — the tool call should be skipped.
	 * Returns true to allow the tool call to proceed.
	 */
	preToolCall(toolName: string, input: Record<string, unknown>): boolean {
		for (const rule of this.config.rules) {
			if (rule.event !== "pre_tool_call") continue;
			// A rule without a tool field matches all tools
			if (rule.tool !== undefined && rule.tool !== toolName) continue;

			if (rule.action === "block") {
				const reason = rule.reason ? `: ${rule.reason}` : "";
				logger.warn(`Tool call blocked by guard rule: "${toolName}"${reason}`, { input });
				return false;
			}

			if (rule.action === "warn") {
				const reason = rule.reason ? `: ${rule.reason}` : "";
				logger.warn(`Guard warning for tool call: "${toolName}"${reason}`, { input });
				// continue evaluating remaining rules
			}

			// "allow" — short-circuit, no further rule evaluation
			if (rule.action === "allow") {
				return true;
			}
		}

		return true;
	}

	/**
	 * Called after a tool call completes.
	 * "warn" rules log a warning. "block"/"allow" are no-ops post-call.
	 */
	postToolCall(toolName: string, result: string): void {
		for (const rule of this.config.rules) {
			if (rule.event !== "post_tool_call") continue;
			if (rule.tool !== undefined && rule.tool !== toolName) continue;

			if (rule.action === "warn") {
				const reason = rule.reason ? `: ${rule.reason}` : "";
				logger.warn(`Guard post-call warning for tool: "${toolName}"${reason}`, {
					resultLength: result.length,
				});
			}
		}
	}
}
