/**
 * RPC stdin channel — reads NDJSON lines from a stream, parses them as
 * RpcRequest objects, and maintains a FIFO queue.
 *
 * Uses Bun.stdin.stream() with manual line buffering (not Bun.stdin.text())
 * so the agent loop is never blocked waiting for control messages.
 */

import type { FollowUpRequest, RpcRequest, SteerRequest } from "./types.ts";

/** Steer/followUp requests that can appear in the queue (abort sets a flag, getState is handled immediately, never queued). */
type QueuableRequest = SteerRequest | FollowUpRequest;

// ─── Parse Helpers ────────────────────────────────────────────────────────────

export type ParseResult =
	| { ok: true; request: RpcRequest }
	| { ok: false; error: string; rawMethod?: string };

function isValidRpcRequest(v: unknown): v is RpcRequest {
	if (typeof v !== "object" || v === null) return false;
	const obj = v as Record<string, unknown>;
	const method = obj.method;
	if (method === "abort") return true;
	if (method === "getState") {
		return typeof obj.id === "number" || typeof obj.id === "string";
	}
	if (method === "steer" || method === "followUp") {
		return (
			typeof obj.params === "object" &&
			obj.params !== null &&
			typeof (obj.params as Record<string, unknown>).content === "string"
		);
	}
	return false;
}

/**
 * Parse a single NDJSON line as an RpcRequest.
 * Exported for unit testing.
 */
export function parseLine(line: string): ParseResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return { ok: false, error: "Invalid JSON" };
	}
	if (!isValidRpcRequest(parsed)) {
		const rawObj = parsed as Record<string, unknown>;
		const rawMethod = typeof rawObj?.method === "string" ? (rawObj.method as string) : undefined;
		return { ok: false, error: "Unknown or malformed RPC method", rawMethod };
	}
	return { ok: true, request: parsed };
}

// ─── Channel ──────────────────────────────────────────────────────────────────

/**
 * Reads NDJSON lines from a ReadableStream, parses RpcRequest objects,
 * and maintains a FIFO queue for the agent loop to consume.
 *
 * The `drained` promise resolves when the stream is exhausted.
 * Useful in tests to await all lines being processed.
 */
export class RpcChannel {
	private readonly queue: QueuableRequest[] = [];
	private abortRequested = false;
	private closed = false;
	private readonly onParsed: (result: ParseResult) => void;

	/** Resolves when the input stream is exhausted (all lines processed). */
	readonly drained: Promise<void>;

	constructor(stream: ReadableStream<Uint8Array>, onParsed: (result: ParseResult) => void) {
		this.onParsed = onParsed;
		this.drained = this.startReading(stream);
	}

	private async startReading(stream: ReadableStream<Uint8Array>): Promise<void> {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			while (!this.closed) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let newlineIdx = buffer.indexOf("\n");
				while (newlineIdx !== -1) {
					const line = buffer.slice(0, newlineIdx).trim();
					buffer = buffer.slice(newlineIdx + 1);
					if (line) this.processLine(line);
					newlineIdx = buffer.indexOf("\n");
				}
			}
		} finally {
			reader.releaseLock();
		}
	}

	private processLine(line: string): void {
		const result = parseLine(line);
		if (result.ok) {
			if (result.request.method === "abort") {
				this.abortRequested = true;
			} else if (result.request.method === "steer" || result.request.method === "followUp") {
				this.queue.push(result.request);
			}
			// getState is not queued — handled immediately by the server callback
		}
		this.onParsed(result);
	}

	/** Dequeue the next steer/followUp request (FIFO). Non-blocking. */
	dequeue(): QueuableRequest | undefined {
		return this.queue.shift();
	}

	/** True if an abort request has been received. */
	isAbortRequested(): boolean {
		return this.abortRequested;
	}

	/** Stop reading from the stream. */
	close(): void {
		this.closed = true;
	}
}
