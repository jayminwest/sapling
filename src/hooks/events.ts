/**
 * NDJSON event emitter for Sapling --json mode.
 *
 * Emits structured per-turn events to process.stdout when enabled.
 * Each event is a single JSON line (NDJSON format) with a timestamp field added automatically.
 * When disabled (non-json mode), all methods are no-ops.
 *
 * Event types (consumed by overstory SaplingRuntime.parseEvents()):
 *   ready      — once after initialization
 *   turn_start — at the start of each turn (1-based)
 *   tool_start — before each tool execution
 *   tool_end   — after each tool, with duration and success
 *   turn_end   — after each LLM call, with token counts and model
 *   progress   — at meaningful milestones, with estimated percent complete and subtask label
 *   result     — when run loop exits, with outcome and summary
 *   error      — on failures, with message and classification
 */

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Emits NDJSON per-turn events to process.stdout when enabled.
 *
 * Convenience methods build the correct event shape and delegate to emit().
 * All events have a `type` discriminator and a `timestamp` ISO 8601 field injected by emit().
 */
export class EventEmitter {
	readonly enabled: boolean;

	constructor(enabled: boolean) {
		this.enabled = enabled;
	}

	/**
	 * Emit a single NDJSON event to stdout.
	 * Adds a `timestamp` field automatically.
	 * No-op if disabled.
	 */
	emit(event: Record<string, unknown>): void {
		if (!this.enabled) return;
		process.stdout.write(`${JSON.stringify({ ...event, timestamp: new Date().toISOString() })}\n`);
	}

	/** Emitted once when the agent loop begins. */
	ready(model: string, maxTurns: number, tools: string[]): void {
		this.emit({ type: "ready", model, maxTurns, tools });
	}

	/** Emitted at the start of each turn (1-based). */
	turnStart(turn: number): void {
		this.emit({ type: "turn_start", turn });
	}

	/** Emitted before a tool call is dispatched. argsSummary is a truncated JSON of the inputs. */
	toolStart(turn: number, toolName: string, toolCallId: string, argsSummary: string): void {
		this.emit({ type: "tool_start", turn, toolName, toolCallId, argsSummary });
	}

	/** Emitted after a tool call completes. */
	toolEnd(
		turn: number,
		toolName: string,
		toolCallId: string,
		success: boolean,
		durationMs: number,
		filesModified?: string[],
		errorMessage?: string,
		outputSummary?: string,
	): void {
		this.emit({
			type: "tool_end",
			turn,
			toolName,
			toolCallId,
			success,
			durationMs,
			filesModified,
			...(errorMessage ? { errorMessage } : {}),
			...(outputSummary ? { outputSummary } : {}),
		});
	}

	/**
	 * Emitted at the end of each turn after context management runs.
	 * Token counts are cumulative totals; cache counts are from the most recent LLM response.
	 * @param contextUtilization - Ratio of total context used (0.0–1.0).
	 */
	turnEnd(
		turn: number,
		inputTokens: number,
		outputTokens: number,
		cacheReadTokens: number,
		cacheWriteTokens: number,
		model: string,
		contextUtilization: number,
	): void {
		this.emit({
			type: "turn_end",
			turn,
			inputTokens,
			outputTokens,
			cacheReadTokens,
			cacheWriteTokens,
			model,
			contextUtilization,
		});
	}

	/**
	 * Emitted at meaningful milestones to report estimated progress.
	 * @param percent - Estimated completion percentage (0–100). Can be derived from turn/maxTurns ratio.
	 * @param subtask - Human-readable description of the current activity (e.g. 'Running tests').
	 * @param filesChanged - Number of files modified so far in this run.
	 */
	progress(percent: number, subtask: string, filesChanged: number): void {
		this.emit({ type: "progress", percent, subtask, filesChanged });
	}

	/** Emitted once when the agent loop finishes (all exit paths). */
	result(
		outcome: "success" | "max_turns" | "error",
		summary: string,
		totalTurns: number,
		totalInputTokens: number,
		totalOutputTokens: number,
	): void {
		this.emit({
			type: "result",
			outcome,
			summary,
			totalTurns,
			totalInputTokens,
			totalOutputTokens,
		});
	}

	/** Emitted on LLM or unrecoverable errors. */
	error(message: string, classification: string): void {
		this.emit({ type: "error", message, classification });
	}
}
