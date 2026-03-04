/**
 * Tests for RpcChannel and parseLine.
 */

import { describe, expect, it } from "bun:test";
import type { ParseResult } from "./channel.ts";
import { parseLine, RpcChannel } from "./channel.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeStream(lines: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const line of lines) {
				controller.enqueue(encoder.encode(`${line}\n`));
			}
			controller.close();
		},
	});
}

// ─── parseLine unit tests ─────────────────────────────────────────────────────

describe("parseLine", () => {
	it("parses a valid steer request", () => {
		const result = parseLine(
			JSON.stringify({ method: "steer", params: { content: "focus on X" } }),
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.request.method).toBe("steer");
			if (result.request.method === "steer") {
				expect(result.request.params.content).toBe("focus on X");
			}
		}
	});

	it("parses a valid followUp request", () => {
		const result = parseLine(
			JSON.stringify({ method: "followUp", params: { content: "now do Y" } }),
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.request.method).toBe("followUp");
		}
	});

	it("parses a valid abort request", () => {
		const result = parseLine(JSON.stringify({ method: "abort" }));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.request.method).toBe("abort");
		}
	});

	it("rejects invalid JSON", () => {
		const result = parseLine("not json {{{");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toBe("Invalid JSON");
			expect(result.rawMethod).toBeUndefined();
		}
	});

	it("rejects unknown method", () => {
		const result = parseLine(JSON.stringify({ method: "explode" }));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.rawMethod).toBe("explode");
		}
	});

	it("rejects steer without params", () => {
		const result = parseLine(JSON.stringify({ method: "steer" }));
		expect(result.ok).toBe(false);
	});

	it("rejects steer with non-string content", () => {
		const result = parseLine(JSON.stringify({ method: "steer", params: { content: 42 } }));
		expect(result.ok).toBe(false);
	});

	it("rejects empty object", () => {
		const result = parseLine(JSON.stringify({}));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.rawMethod).toBeUndefined();
		}
	});

	it("rejects non-object JSON", () => {
		const result = parseLine(JSON.stringify([1, 2, 3]));
		expect(result.ok).toBe(false);
	});

	it("parses a valid getState request with numeric id", () => {
		const result = parseLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getState" }));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.request.method).toBe("getState");
			if (result.request.method === "getState") {
				expect(result.request.id).toBe(1);
			}
		}
	});

	it("parses a valid getState request with string id", () => {
		const result = parseLine(JSON.stringify({ id: "req-42", method: "getState" }));
		expect(result.ok).toBe(true);
		if (result.ok && result.request.method === "getState") {
			expect(result.request.id).toBe("req-42");
		}
	});

	it("rejects getState without id", () => {
		const result = parseLine(JSON.stringify({ method: "getState" }));
		expect(result.ok).toBe(false);
	});
});

// ─── RpcChannel tests ─────────────────────────────────────────────────────────

describe("RpcChannel", () => {
	it("queues steer requests in FIFO order", async () => {
		const results: ParseResult[] = [];
		const stream = makeStream([
			JSON.stringify({ method: "steer", params: { content: "first" } }),
			JSON.stringify({ method: "steer", params: { content: "second" } }),
		]);
		const channel = new RpcChannel(stream, (r) => results.push(r));
		await channel.drained;

		const r1 = channel.dequeue();
		const r2 = channel.dequeue();
		const r3 = channel.dequeue();

		expect(r1).toBeDefined();
		expect(r2).toBeDefined();
		expect(r3).toBeUndefined(); // queue exhausted

		if (r1 && r1.method === "steer") expect(r1.params.content).toBe("first");
		if (r2 && r2.method === "steer") expect(r2.params.content).toBe("second");
	});

	it("queues followUp requests", async () => {
		const stream = makeStream([
			JSON.stringify({ method: "followUp", params: { content: "follow this" } }),
		]);
		const channel = new RpcChannel(stream, () => {});
		await channel.drained;

		const req = channel.dequeue();
		expect(req?.method).toBe("followUp");
	});

	it("sets abortRequested on abort and does not queue it", async () => {
		const stream = makeStream([JSON.stringify({ method: "abort" })]);
		const channel = new RpcChannel(stream, () => {});
		await channel.drained;

		expect(channel.isAbortRequested()).toBe(true);
		expect(channel.dequeue()).toBeUndefined(); // abort not queued
	});

	it("calls onParsed for each valid request", async () => {
		const called: ParseResult[] = [];
		const stream = makeStream([
			JSON.stringify({ method: "steer", params: { content: "go" } }),
			JSON.stringify({ method: "abort" }),
		]);
		const channel = new RpcChannel(stream, (r) => called.push(r));
		await channel.drained;

		expect(called).toHaveLength(2);
		expect(called[0]?.ok).toBe(true);
		expect(called[1]?.ok).toBe(true);
	});

	it("calls onParsed with error for invalid JSON", async () => {
		const called: ParseResult[] = [];
		const stream = makeStream(["not json", "also bad"]);
		const channel = new RpcChannel(stream, (r) => called.push(r));
		await channel.drained;

		expect(called).toHaveLength(2);
		expect(called[0]?.ok).toBe(false);
		expect(called[1]?.ok).toBe(false);
	});

	it("skips blank lines", async () => {
		const called: ParseResult[] = [];
		const stream = makeStream([
			"",
			"   ",
			JSON.stringify({ method: "steer", params: { content: "hi" } }),
		]);
		const channel = new RpcChannel(stream, (r) => called.push(r));
		await channel.drained;

		// Only one non-blank line processed
		expect(called).toHaveLength(1);
		expect(called[0]?.ok).toBe(true);
	});

	it("handles multiple requests in a single chunk (line-buffered)", async () => {
		const encoder = new TextEncoder();
		const twoLines =
			JSON.stringify({ method: "steer", params: { content: "a" } }) +
			"\n" +
			JSON.stringify({ method: "followUp", params: { content: "b" } }) +
			"\n";

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(twoLines));
				controller.close();
			},
		});

		const channel = new RpcChannel(stream, () => {});
		await channel.drained;

		expect(channel.dequeue()?.method).toBe("steer");
		expect(channel.dequeue()?.method).toBe("followUp");
	});

	it("isAbortRequested starts false", async () => {
		const stream = makeStream([JSON.stringify({ method: "steer", params: { content: "ok" } })]);
		const channel = new RpcChannel(stream, () => {});
		await channel.drained;

		expect(channel.isAbortRequested()).toBe(false);
	});

	it("getState is not queued — dequeue returns undefined", async () => {
		const stream = makeStream([JSON.stringify({ id: 1, method: "getState" })]);
		const channel = new RpcChannel(stream, () => {});
		await channel.drained;

		expect(channel.dequeue()).toBeUndefined();
	});

	it("calls onParsed for getState request", async () => {
		const called: ParseResult[] = [];
		const stream = makeStream([JSON.stringify({ id: 2, method: "getState" })]);
		const channel = new RpcChannel(stream, (r) => called.push(r));
		await channel.drained;

		expect(called).toHaveLength(1);
		expect(called[0]?.ok).toBe(true);
		if (called[0]?.ok && called[0].request.method === "getState") {
			expect(called[0].request.id).toBe(2);
		}
	});
});
