/**
 * Relevance scoring for messages in the context window.
 *
 * Each message receives a score from 0.0 (irrelevant) to 1.0 (critical).
 * The scorer uses six weighted signals:
 *   - Recency (0.30): recent turns score higher
 *   - File overlap (0.25): messages about files currently being worked on
 *   - Error context (0.20): error messages and surrounding context
 *   - Decision content (0.12): messages containing explicit decisions
 *   - Unresolved question (0.08): assistant messages ending with open questions
 *   - Size penalty (0.05): larger messages are penalized
 */

import type { ContentBlock, Message, MessageCategory, ScoredMessage } from "../types.ts";
import { estimateMessageTokens } from "./measure.ts";

// Score weights (must sum to 1.0)
const WEIGHT_RECENCY = 0.3;
const WEIGHT_FILE_OVERLAP = 0.25;
const WEIGHT_ERROR_CONTEXT = 0.2;
const WEIGHT_DECISION = 0.12;
const WEIGHT_UNRESOLVED = 0.08; // bonus for messages with open questions
const WEIGHT_SIZE = 0.05;

// Recency: messages from the last 3 turns score 1.0; score < 0.3 at 10+ turns
const RECENCY_HALF_LIFE = 5; // turns for score to drop by half

/**
 * Compute a recency score that decays exponentially with age.
 * Age 0-2: ~1.0, Age 5: ~0.5, Age 10+: ~0.25
 */
function recencyScore(age: number): number {
	return Math.exp((-Math.log(2) * age) / RECENCY_HALF_LIFE);
}

/**
 * Extract file paths referenced in a message's content.
 * Looks for absolute paths and common relative path patterns.
 */
export function extractFilePaths(message: Message): string[] {
	const paths = new Set<string>();
	const pathPattern = /(?:^|[\s"'`(,])(\/?(?:[\w.-]+\/)+[\w.-]+\.\w+)/gm;

	const extractFromText = (text: string) => {
		for (const match of text.matchAll(pathPattern)) {
			const p = match[1];
			if (p) paths.add(p);
		}
	};

	if (typeof message.content === "string") {
		extractFromText(message.content);
	} else {
		for (const block of message.content) {
			if (block.type === "text") {
				extractFromText(block.text);
			} else if (block.type === "tool_use") {
				// Check tool input for file paths
				const inputStr = JSON.stringify(block.input);
				extractFromText(inputStr);
			}
		}
	}

	return Array.from(paths);
}

/**
 * Check whether a message contains error context.
 * Looks for error keywords in tool results and text content.
 */
function hasErrorContent(message: Message): boolean {
	const errorPattern = /\b(error|Error|failed|FAILED|exception|Exception|stderr|exit code [^0])\b/;

	if (typeof message.content === "string") {
		return errorPattern.test(message.content);
	}

	for (const block of message.content) {
		if (block.type === "text" && errorPattern.test(block.text)) {
			return true;
		}
		if (block.type === "tool_use") {
			const inputStr = JSON.stringify(block.input);
			if (errorPattern.test(inputStr)) return true;
		}
	}
	return false;
}

/**
 * Check whether a message contains decision language.
 */
function hasDecisionContent(message: Message): boolean {
	const decisionPattern =
		/\b(decided|decision|chose|choosing|approach|strategy|because|reason|therefore|instead)\b/i;

	if (typeof message.content === "string") {
		return decisionPattern.test(message.content);
	}

	for (const block of message.content) {
		if (block.type === "text" && decisionPattern.test(block.text)) {
			return true;
		}
	}
	return false;
}

/**
 * Check whether a message appears to contain an unresolved question.
 */
function hasUnresolvedQuestion(message: Message): boolean {
	if (message.role !== "assistant") return false;
	const questionPattern = /\?[\s]*$/m;

	if (typeof message.content === "string") {
		return questionPattern.test(message.content);
	}

	for (const block of message.content) {
		if (block.type === "text" && questionPattern.test(block.text)) {
			return true;
		}
	}
	return false;
}

/**
 * Compute the file overlap score between a message and the currently active files.
 * Returns 1.0 if any file in the message is in currentFiles, else 0.0.
 */
function fileOverlapScore(filesReferenced: string[], currentFiles: string[]): number {
	if (currentFiles.length === 0 || filesReferenced.length === 0) return 0.0;

	const currentSet = new Set(currentFiles.map((f) => f.toLowerCase()));
	for (const f of filesReferenced) {
		// Check exact match or substring match (handles relative vs absolute)
		if (currentSet.has(f.toLowerCase())) return 1.0;
		for (const cf of currentFiles) {
			if (cf.includes(f) || f.includes(cf)) return 0.8;
		}
	}
	return 0.0;
}

/**
 * Compute a size penalty score. Large messages score lower.
 * Messages with < 500 tokens get full marks; > 5000 tokens get 0.
 */
function sizePenaltyScore(tokenCount: number): number {
	if (tokenCount <= 500) return 1.0;
	if (tokenCount >= 5000) return 0.0;
	// Linear interpolation between 500 and 5000
	return 1.0 - (tokenCount - 500) / 4500;
}

/**
 * Assign a category to a message based on its position and content.
 */
export function categorizeMessage(
	_message: Message,
	index: number,
	totalMessages: number,
	currentTurnStart: number,
): MessageCategory {
	// Only treat index 0 as "task" when the array includes pre-current messages
	// (i.e., currentTurnStart < totalMessages means this is the full message array
	// with a real task message at index 0, not a pre-sliced history sub-array).
	if (index === 0 && currentTurnStart < totalMessages) return "task";
	if (index >= currentTurnStart) return "current";
	return "history";
}

/**
 * Score a single message for relevance.
 *
 * @param message       - The message to score
 * @param age           - How many turns ago this message was added (0 = current turn)
 * @param currentFiles  - Files the agent is currently working on
 * @param isErrorContext - Whether this message is within error context window
 */
export function scoreMessage(
	message: Message,
	age: number,
	currentFiles: string[],
	isErrorContext: boolean,
	category: MessageCategory,
): ScoredMessage {
	const filesReferenced = extractFilePaths(message);
	const tokenCount = estimateMessageTokens(message);
	const isError = hasErrorContent(message) || isErrorContext;
	const isDecision = hasDecisionContent(message);
	const unresolved = hasUnresolvedQuestion(message);

	// Compute individual signal scores
	const recency = recencyScore(age);
	const fileOverlap = fileOverlapScore(filesReferenced, currentFiles);
	const errorSignal = isError ? 1.0 : 0.0;
	const decisionSignal = isDecision ? 1.0 : 0.0;
	const sizeSignal = sizePenaltyScore(tokenCount);

	// Weighted sum (weights sum to 1.0)
	const unresolvedSignal = unresolved ? 1.0 : 0.0;
	const score =
		WEIGHT_RECENCY * recency +
		WEIGHT_FILE_OVERLAP * fileOverlap +
		WEIGHT_ERROR_CONTEXT * errorSignal +
		WEIGHT_DECISION * decisionSignal +
		WEIGHT_UNRESOLVED * unresolvedSignal +
		WEIGHT_SIZE * sizeSignal;

	return {
		message,
		score: Math.min(1.0, Math.max(0.0, score)),
		category,
		tokenCount,
		age,
		metadata: {
			filesReferenced,
			isErrorContext: isError,
			hasUnresolvedQuestion: unresolved,
		},
	};
}

/**
 * Detect whether the last tool result in the message array was an error.
 * Used to boost surrounding context messages.
 */
function lastResultWasError(messages: Message[]): boolean {
	// Look at the last user message (tool results come back as user messages)
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg && msg.role === "user") {
			return hasErrorContent(msg);
		}
	}
	return false;
}

/**
 * Score all messages in the conversation history.
 *
 * @param messages      - Full message array (excluding system prompt)
 * @param currentFiles  - Files the agent is actively working on
 * @param currentTurnIdx - Index where the current turn starts
 */
export function scoreMessages(
	messages: Message[],
	currentFiles: string[],
	currentTurnIdx: number,
): ScoredMessage[] {
	const isLastError = lastResultWasError(messages);
	const errorWindowSize = 3; // boost this many messages before a recent error

	return messages.map((message, index) => {
		const age = messages.length - 1 - index;
		const category = categorizeMessage(message, index, messages.length, currentTurnIdx);

		// Error context: messages in the error window get the error boost
		const withinErrorWindow = isLastError && index >= messages.length - errorWindowSize - 1;

		return scoreMessage(message, age, currentFiles, withinErrorWindow, category);
	});
}

/**
 * Extract the tool name from a ContentBlock for summarization purposes.
 */
export function extractToolName(block: ContentBlock): string | null {
	if (block.type === "tool_use") return block.name;
	return null;
}
