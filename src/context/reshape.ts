/**
 * Message array reconstruction for the context manager.
 *
 * After pruning, reshape rebuilds the messages array that the LLM will see:
 *   [task message] + [archive summary message] + [pruned history] + [current turn]
 *
 * The task message is always first (the original user prompt).
 * The archive summary is injected after the task if it has content.
 * Recent history follows, then the current turn messages.
 */

import type { ContextArchive, Message } from "../types.ts";
import { renderArchive } from "./archive.ts";
import { estimateTokens } from "./measure.ts";

/**
 * Rebuild the messages array for the next LLM call.
 *
 * @param taskMessage    - The original task/prompt message (always kept first)
 * @param archive        - The current archive state
 * @param historyMessages - Pruned history messages (already filtered)
 * @param currentMessages - Current turn messages (always kept last)
 * @param archiveBudget  - Max tokens for the archive injection
 */
export function reshapeMessages(
	taskMessage: Message,
	archive: ContextArchive,
	historyMessages: Message[],
	currentMessages: Message[],
	archiveBudget: number,
): Message[] {
	const result: Message[] = [taskMessage];

	// Inject archive summary if it has content and fits in budget
	const archiveContent = renderArchive(archive);
	if (archiveContent.trim()) {
		const archiveTokens = estimateTokens(archiveContent);
		let archiveText: string;
		if (archiveTokens <= archiveBudget) {
			archiveText = archiveContent;
		} else {
			// Truncate archive to fit budget
			const truncated = truncateToTokenBudget(archiveContent, archiveBudget);
			archiveText = truncated.trim()
				? `${truncated}\n\n[Archive truncated to fit context budget]`
				: "";
		}

		if (archiveText.trim()) {
			// Insert synthetic assistant acknowledgment before the archive user message.
			// This prevents consecutive user messages (task then archive) which violates
			// the Anthropic API alternating-role requirement.
			result.push({
				role: "assistant",
				content: [{ type: "text", text: "[Acknowledged]" }],
			});
			result.push({ role: "user", content: archiveText });
		}
	}

	// Add pruned history
	result.push(...historyMessages);

	// Add current turn messages
	result.push(...currentMessages);

	return result;
}

/**
 * Split a full message array into task, history, and current-turn segments.
 *
 * The task message is the first message.
 * The current turn is determined by currentTurnIdx.
 * Everything in between is history.
 *
 * Any previously-injected archive message (identified by its content pattern)
 * is excluded from history.
 */
export function splitMessageSegments(
	messages: Message[],
	currentTurnIdx: number,
): {
	taskMessage: Message | null;
	historyMessages: Message[];
	currentMessages: Message[];
} {
	if (messages.length === 0) {
		return { taskMessage: null, historyMessages: [], currentMessages: [] };
	}

	const taskMessage = messages[0] ?? null;

	// Filter out previously-injected archive messages and synthetic acknowledgments.
	const isArchiveMessage = (m: Message): boolean => {
		// User-side archive injection messages
		if (m.role === "user" && typeof m.content === "string") {
			return (
				m.content.startsWith("## Work So Far") ||
				m.content.startsWith("## Files Modified") ||
				m.content.startsWith("## Key Decisions") ||
				m.content.includes("[Archive truncated to fit context budget]")
			);
		}
		// Synthetic assistant acknowledgment inserted before archive messages
		if (m.role === "assistant" && Array.isArray(m.content) && m.content.length === 1) {
			const block = m.content[0];
			return block?.type === "text" && block.text === "[Acknowledged]";
		}
		return false;
	};

	const historyMessages = messages.slice(1, currentTurnIdx).filter((m) => !isArchiveMessage(m));

	const currentMessages = messages.slice(currentTurnIdx);

	return { taskMessage, historyMessages, currentMessages };
}

/**
 * Identify where the "current turn" begins in the message array.
 * The current turn consists of the most recent assistant response and any
 * tool results that followed it.
 *
 * Returns the index of the first message of the current turn.
 * If there are no assistant messages, returns messages.length (empty current turn).
 */
export function findCurrentTurnStart(messages: Message[]): number {
	if (messages.length === 0) return 0;

	// Scan backwards to find the last assistant message
	let lastAssistantIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg && msg.role === "assistant") {
			lastAssistantIdx = i;
			break;
		}
	}

	if (lastAssistantIdx === -1) return messages.length;

	// The current turn starts at the last assistant message
	return lastAssistantIdx;
}

/**
 * Truncate text to approximately fit within a token budget.
 * Cuts from the end, preserving the beginning (most important context in archives).
 */
function truncateToTokenBudget(text: string, maxTokens: number): string {
	if (estimateTokens(text) <= maxTokens) return text;

	// Binary search for the right length
	let low = 0;
	let high = text.length;

	while (low < high - 1) {
		const mid = Math.floor((low + high) / 2);
		if (estimateTokens(text.slice(0, mid)) <= maxTokens) {
			low = mid;
		} else {
			high = mid;
		}
	}

	return text.slice(0, low);
}
