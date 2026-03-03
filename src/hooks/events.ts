/**
 * NDJSON event emitter for Sapling --json mode.
 *
 * Emits structured per-turn events to process.stdout when enabled.
 * Each event is a single JSON line (NDJSON format) with a timestamp field added automatically.
 * When disabled (non-json mode), all methods are no-ops.
 */

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Emits NDJSON per-turn events to process.stdout when enabled.
 *
 * Convenience methods (started, turnStart, etc.) build the correct event shape
 * and delegate to emit(). All events have a `type` discriminator and a
 * `timestamp` ISO 8601 field injected by emit().
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
	started(model: string, maxTurns: number, tools: string[]): void {
		this.emit({ type: "started", model, maxTurns, tools });
	}

	/** Emitted at the start of each turn (1-based). */
	turnStart(turn: number): void {
		this.emit({ type: "turn_start", turn });
	}

	/** Emitted when a tool call is dispatched. */
	toolCall(turn: number, toolName: string, toolCallId: string): void {
		this.emit({ type: "tool_call", turn, toolName, toolCallId });
	}

	/** Emitted when a tool call completes. */
	toolResult(turn: number, toolName: string, toolCallId: string, isError: boolean): void {
		this.emit({ type: "tool_result", turn, toolName, toolCallId, isError });
	}

	/**
	 * Emitted at the end of each turn after context management runs.
	 * @param contextUtilization - Ratio of total context used (0.0–1.0).
	 */
	turnEnd(
		turn: number,
		inputTokens: number,
		outputTokens: number,
		contextUtilization: number,
	): void {
		this.emit({ type: "turn_end", turn, inputTokens, outputTokens, contextUtilization });
	}

	/** Emitted once when the agent loop finishes (all exit paths). */
	runComplete(
		exitReason: string,
		totalTurns: number,
		totalInputTokens: number,
		totalOutputTokens: number,
	): void {
		this.emit({
			type: "run_complete",
			exitReason,
			totalTurns,
			totalInputTokens,
			totalOutputTokens,
		});
	}
}
