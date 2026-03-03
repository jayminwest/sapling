/**
 * Context Manager — orchestrates the measure → score → prune → archive → reshape pipeline.
 *
 * This is the core innovation of Sapling. Between every LLM call, the context
 * manager evaluates, prunes, and reshapes what the model sees — so it operates
 * at maximum capacity for the entire task, not just the first 20 turns.
 *
 * Pipeline:
 *   1. MEASURE  — count tokens per category, check budget
 *   2. SCORE    — rate each message's relevance to the current subtask
 *   3. PRUNE    — apply strategies based on category + score
 *   4. ARCHIVE  — move pruned content to long-term store
 *   5. RESHAPE  — rebuild messages array for next LLM call
 */

import { logger } from "../logging/logger.ts";
import type {
	BudgetUtilization,
	ContextArchive,
	ContextBudget,
	ContextManager,
	Message,
	TokenUsage,
} from "../types.ts";
import {
	appendToWorkSummary,
	createArchive,
	recordFileModification,
	recordResolvedError,
	renderArchive,
	summarizeTurn,
} from "./archive.ts";
import { computeBudgets, DEFAULT_BUDGET, estimateTokens, measureUtilization } from "./measure.ts";
import { pruneMessages } from "./prune.ts";
import { findCurrentTurnStart, reshapeMessages, splitMessageSegments } from "./reshape.ts";
import { extractFilePaths, scoreMessages } from "./score.ts";

export interface ContextManagerOptions {
	budget?: ContextBudget;
	verbose?: boolean;
	/** Token count of the system prompt (measured externally, set once). */
	systemPromptTokens?: number;
}

/**
 * Context manager metrics logged per turn.
 */
export interface ContextMetrics {
	turn: number;
	beforePruning: BudgetUtilization;
	afterPruning: BudgetUtilization;
	messagesPruned: number;
	messagesSummarized: number;
	messagesDropped: number;
	archiveSize: number;
}

export class SaplingContextManager implements ContextManager {
	private readonly budget: ContextBudget;
	private readonly verbose: boolean;
	private systemPromptTokens: number;
	private archive: ContextArchive;
	private lastUtilization: BudgetUtilization;
	private turnCount: number;
	private currentFiles: string[];

	constructor(options: ContextManagerOptions = {}) {
		this.budget = options.budget ?? DEFAULT_BUDGET;
		this.verbose = options.verbose ?? false;
		this.systemPromptTokens = options.systemPromptTokens ?? 0;
		this.archive = createArchive();
		this.turnCount = 0;
		this.currentFiles = [];

		// Initialize with zero utilization
		const budgets = computeBudgets(this.budget);
		this.lastUtilization = {
			systemPrompt: { used: 0, budget: budgets.systemPrompt },
			archiveSummary: { used: 0, budget: budgets.archiveSummary },
			recentHistory: { used: 0, budget: budgets.recentHistory },
			currentTurn: { used: 0, budget: budgets.currentTurn },
			headroom: { used: this.budget.windowSize, budget: budgets.headroom },
			total: { used: 0, budget: this.budget.windowSize },
		};
	}

	/**
	 * Process the message array after a turn.
	 * Called between every LLM call.
	 *
	 * @param messages    - Current full message array
	 * @param lastUsage   - Token usage from the most recent LLM call
	 * @param currentFiles - Files the agent is actively working on
	 */
	process(messages: Message[], lastUsage: TokenUsage, currentFiles: string[]): Message[] {
		this.turnCount++;
		this.currentFiles = currentFiles;

		// Update system prompt token count from actual usage if available
		if (lastUsage.inputTokens > 0 && this.systemPromptTokens === 0) {
			// Rough estimate: system prompt is ~15% of input tokens
			this.systemPromptTokens = Math.floor(lastUsage.inputTokens * 0.15);
		}

		// 1. Find the current turn boundary
		const currentTurnIdx = findCurrentTurnStart(messages);

		// 2. Split into segments
		const { taskMessage, historyMessages, currentMessages } = splitMessageSegments(
			messages,
			currentTurnIdx,
		);

		if (!taskMessage) return messages;

		// 3. Render current archive for measurement
		const archiveContent = renderArchive(this.archive);
		const archiveTokens = estimateTokens(archiveContent);

		// 4. MEASURE — compute budget utilization before pruning
		const beforeUtilization = measureUtilization(
			this.systemPromptTokens,
			archiveTokens,
			historyMessages,
			currentMessages,
			this.budget,
		);

		// 5. SCORE — rate each history message
		// Pass historyMessages.length as currentTurnIdx so all messages are categorized as
		// "history" (not "current" or "task") — historyMessages is already a pre-split slice.
		const allHistoryScored = scoreMessages(
			historyMessages,
			this.currentFiles,
			historyMessages.length,
		);

		// 6. PRUNE — apply pruning strategies
		const budgets = computeBudgets(this.budget);

		// Merge explicit write/edit modifications with hash-detected staleness
		const hashStaleFiles = this.detectHashStaleFiles([...historyMessages, ...currentMessages]);
		const modifiedFiles = new Set([...this.archive.modifiedFiles.keys(), ...hashStaleFiles]);

		const prunedHistory = pruneMessages(
			allHistoryScored,
			modifiedFiles,
			currentTurnIdx,
			budgets.recentHistory,
		);

		// 7. ARCHIVE — update archive with summaries of pruned turns
		this.updateArchive(historyMessages, prunedHistory, budgets.archiveSummary);

		// 8. Detect file modifications from current turn
		this.detectFileModifications(currentMessages);

		// 9. Detect resolved errors
		this.detectResolvedErrors(historyMessages, currentMessages);

		// 10. MEASURE after pruning
		const updatedArchiveContent = renderArchive(this.archive);
		const updatedArchiveTokens = estimateTokens(updatedArchiveContent);

		const afterUtilization = measureUtilization(
			this.systemPromptTokens,
			updatedArchiveTokens,
			prunedHistory,
			currentMessages,
			this.budget,
		);

		this.lastUtilization = afterUtilization;

		// 11. Log metrics if verbose
		if (this.verbose) {
			this.logMetrics({
				turn: this.turnCount,
				beforePruning: beforeUtilization,
				afterPruning: afterUtilization,
				messagesPruned: historyMessages.length - prunedHistory.length,
				messagesSummarized: 0, // tracked inside pruneMessages
				messagesDropped: historyMessages.length - prunedHistory.length,
				archiveSize: updatedArchiveTokens,
			});
		}

		// 12. RESHAPE — rebuild the message array
		return reshapeMessages(
			taskMessage,
			this.archive,
			prunedHistory,
			currentMessages,
			budgets.archiveSummary,
		);
	}

	getUtilization(): BudgetUtilization {
		return this.lastUtilization;
	}

	getArchive(): ContextArchive {
		return this.archive;
	}

	/**
	 * Update system prompt token count (called when the system prompt is known).
	 */
	setSystemPromptTokens(tokens: number): void {
		this.systemPromptTokens = tokens;
	}

	/**
	 * Update the archive when turns are pruned or summarized.
	 * Messages that were dropped from history get summarized into the archive.
	 */
	private updateArchive(
		originalHistory: Message[],
		prunedHistory: Message[],
		archiveBudget: number,
	): void {
		const keptSet = new Set(prunedHistory);

		for (let i = 0; i < originalHistory.length; i++) {
			const msg = originalHistory[i];
			if (!msg || keptSet.has(msg)) continue;

			// This message was dropped — summarize it into the archive
			const turnSummary = summarizeTurn(this.turnCount - originalHistory.length + i, [msg]);
			this.archive = appendToWorkSummary(this.archive, turnSummary, archiveBudget);
		}
	}

	/**
	 * Detect file write/edit operations in the current turn and update the archive.
	 * Also hashes the new content and stores it in archive.fileHashes so that
	 * subsequent read-staleness checks can detect content changes.
	 */
	private detectFileModifications(currentMessages: Message[]): void {
		for (const msg of currentMessages) {
			if (msg.role !== "assistant") continue;
			if (typeof msg.content === "string") continue;

			for (const block of msg.content) {
				if (block.type !== "tool_use") continue;

				if (block.name === "write" || block.name === "edit") {
					const filePath = block.input.file_path;
					if (typeof filePath === "string") {
						const description =
							block.name === "write" ? "Created/overwritten by agent" : "Edited by agent";
						this.archive = recordFileModification(this.archive, filePath, description);

						// Hash the written/edited content for downstream staleness detection.
						const rawContent =
							block.name === "write"
								? String(block.input.content ?? "")
								: String(block.input.new_string ?? "");
						const hash = String(Bun.hash(rawContent));
						const updatedHashes = new Map(this.archive.fileHashes);
						updatedHashes.set(filePath, hash);
						this.archive = { ...this.archive, fileHashes: updatedHashes };
					}
				}
			}
		}
	}

	/**
	 * Compute a lightweight fingerprint of text content for read-staleness detection.
	 * Uses length + head + tail; not cryptographic.
	 */
	private static fingerprint(content: string): string {
		const len = content.length;
		const head = content.slice(0, 120);
		const tail = len > 120 ? content.slice(-60) : "";
		return `${len}:${head}:${tail}`;
	}

	/**
	 * Return the first text block content from a user message, or null.
	 */
	private static firstText(message: Message): string | null {
		if (typeof message.content === "string") return message.content || null;
		for (const block of message.content) {
			if (block.type === "text") return block.text;
		}
		return null;
	}

	/**
	 * Scan message history for repeated reads of the same file with different content.
	 * This catches staleness caused by bash commands or other out-of-band writes
	 * that are not tracked via detectFileModifications.
	 *
	 * Updates archive.fileHashes with the latest fingerprint for each file seen.
	 * Returns a set of file paths whose read history contains stale content.
	 */
	private detectHashStaleFiles(messages: Message[]): Set<string> {
		const staleFiles = new Set<string>();
		// Seed with persisted fingerprints from prior turns
		const latestFingerprints = new Map<string, string>(this.archive.fileHashes);

		for (let i = 0; i < messages.length - 1; i++) {
			const msg = messages[i];
			if (!msg || msg.role !== "assistant") continue;
			if (typeof msg.content === "string") continue;

			for (const block of msg.content) {
				if (block.type !== "tool_use" || block.name !== "read") continue;
				const path = block.input.file_path;
				if (typeof path !== "string") continue;

				// The next message carries the tool result
				const nextMsg = messages[i + 1];
				if (!nextMsg || nextMsg.role !== "user") continue;
				const content = SaplingContextManager.firstText(nextMsg);
				if (!content) continue;

				const fp = SaplingContextManager.fingerprint(content);
				const previous = latestFingerprints.get(path);
				if (previous !== undefined && previous !== fp) {
					staleFiles.add(path);
				}
				latestFingerprints.set(path, fp);
			}
		}

		// Persist updated fingerprints to the archive
		this.archive = { ...this.archive, fileHashes: latestFingerprints };
		return staleFiles;
	}

	/**
	 * Detect whether a recent error was resolved (error followed by success).
	 */
	private detectResolvedErrors(history: Message[], current: Message[]): void {
		// Simple heuristic: if recent history has an error message followed by
		// a successful operation in the current turn, record it as resolved.
		const recentMessages = [...history.slice(-3), ...current];
		let hadError = false;
		let errorSummary = "";

		for (const msg of recentMessages) {
			if (msg.role === "user" && typeof msg.content !== "string") {
				for (const block of msg.content) {
					if (block.type === "text") {
						if (!hadError && /error|failed/i.test(block.text)) {
							hadError = true;
							errorSummary = block.text.slice(0, 100);
						} else if (hadError && !/error|failed/i.test(block.text)) {
							this.archive = recordResolvedError(this.archive, `Resolved: ${errorSummary}`);
							hadError = false;
							errorSummary = "";
						}
					}
				}
			}
		}
	}

	/**
	 * Extract currently active files from the message array.
	 * Used when currentFiles is not explicitly provided.
	 */
	static inferCurrentFiles(messages: Message[]): string[] {
		const files = new Set<string>();

		// Look at the last 5 messages for file references
		const recent = messages.slice(-5);
		for (const msg of recent) {
			const paths = extractFilePaths(msg);
			for (const p of paths) {
				files.add(p);
			}
		}

		return Array.from(files);
	}

	private logMetrics(metrics: ContextMetrics): void {
		const b = metrics.beforePruning;
		const a = metrics.afterPruning;
		logger.debug(
			`[context] turn=${metrics.turn} ` +
				`before=${b.total.used}/${b.total.budget} ` +
				`after=${a.total.used}/${a.total.budget} ` +
				`pruned=${metrics.messagesPruned} ` +
				`archive=${metrics.archiveSize}tok`,
		);
	}
}

/**
 * Create a context manager with default settings.
 */
export function createContextManager(options: ContextManagerOptions = {}): ContextManager {
	return new SaplingContextManager(options);
}
