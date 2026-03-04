/**
 * Tests for RpcServer.
 */

import { describe, expect, it } from "bun:test";
import { EventEmitter } from "../hooks/events.ts";
import { RpcServer } from "./server.ts";

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

interface CapturedEvent {
	type: string;
	method?: string;
	status?: string;
	reason?: string;
	[key: string]: unknown;
}

/** EventEmitter that captures emitted events for assertions. */
function makeCaptureEmitter(): { emitter: EventEmitter; events: CapturedEvent[] } {
	const events: CapturedEvent[] = [];
	const emitter = new EventEmitter(false); // disabled = no stdout write
	// Override emit to capture events
	emitter.emit = (event: Record<string, unknown>) => {
		events.push(event as CapturedEvent);
	};
	return { emitter, events };
}

/** Capture lines written via the server's writer function. */
function makeCapturingWriter(): { writer: (line: string) => void; lines: string[] } {
	const lines: string[] = [];
	return { writer: (line: string) => lines.push(line), lines };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("RpcServer", () => {
	it("emits queued ack for steer request", async () => {
		const { emitter, events } = makeCaptureEmitter();
		const stream = makeStream([JSON.stringify({ method: "steer", params: { content: "go" } })]);
		const server = new RpcServer(stream, emitter);
		await server.drained;

		const ack = events.find((e) => e.type === "rpc_request_ack");
		expect(ack).toBeDefined();
		expect(ack?.method).toBe("steer");
		expect(ack?.status).toBe("queued");
	});

	it("emits queued ack for followUp request", async () => {
		const { emitter, events } = makeCaptureEmitter();
		const stream = makeStream([
			JSON.stringify({ method: "followUp", params: { content: "next" } }),
		]);
		const server = new RpcServer(stream, emitter);
		await server.drained;

		const ack = events.find((e) => e.type === "rpc_request_ack");
		expect(ack?.method).toBe("followUp");
		expect(ack?.status).toBe("queued");
	});

	it("emits accepted ack for abort request", async () => {
		const { emitter, events } = makeCaptureEmitter();
		const stream = makeStream([JSON.stringify({ method: "abort" })]);
		const server = new RpcServer(stream, emitter);
		await server.drained;

		const ack = events.find((e) => e.type === "rpc_request_ack");
		expect(ack?.method).toBe("abort");
		expect(ack?.status).toBe("accepted");
	});

	it("emits rejected ack for invalid JSON", async () => {
		const { emitter, events } = makeCaptureEmitter();
		const stream = makeStream(["not valid json"]);
		const server = new RpcServer(stream, emitter);
		await server.drained;

		const ack = events.find((e) => e.type === "rpc_request_ack");
		expect(ack?.status).toBe("rejected");
		expect(ack?.reason).toBe("Invalid JSON");
	});

	it("emits rejected ack with rawMethod for unknown method", async () => {
		const { emitter, events } = makeCaptureEmitter();
		const stream = makeStream([JSON.stringify({ method: "explode" })]);
		const server = new RpcServer(stream, emitter);
		await server.drained;

		const ack = events.find((e) => e.type === "rpc_request_ack");
		expect(ack?.status).toBe("rejected");
		expect(ack?.method).toBe("explode");
	});

	it("dequeue returns queued steer request", async () => {
		const { emitter } = makeCaptureEmitter();
		const stream = makeStream([JSON.stringify({ method: "steer", params: { content: "focus" } })]);
		const server = new RpcServer(stream, emitter);
		await server.drained;

		const req = server.dequeue();
		expect(req).toBeDefined();
		expect(req?.method).toBe("steer");
		if (req) {
			expect(req.params.content).toBe("focus");
		}
	});

	it("dequeue returns undefined when queue is empty", async () => {
		const { emitter } = makeCaptureEmitter();
		const stream = makeStream([]);
		const server = new RpcServer(stream, emitter);
		await server.drained;

		expect(server.dequeue()).toBeUndefined();
	});

	it("isAbortRequested returns false initially", async () => {
		const { emitter } = makeCaptureEmitter();
		const stream = makeStream([JSON.stringify({ method: "steer", params: { content: "ok" } })]);
		const server = new RpcServer(stream, emitter);
		await server.drained;

		expect(server.isAbortRequested()).toBe(false);
	});

	it("isAbortRequested returns true after abort", async () => {
		const { emitter } = makeCaptureEmitter();
		const stream = makeStream([JSON.stringify({ method: "abort" })]);
		const server = new RpcServer(stream, emitter);
		await server.drained;

		expect(server.isAbortRequested()).toBe(true);
	});

	it("abort is not enqueued — dequeue returns undefined", async () => {
		const { emitter } = makeCaptureEmitter();
		const stream = makeStream([JSON.stringify({ method: "abort" })]);
		const server = new RpcServer(stream, emitter);
		await server.drained;

		expect(server.dequeue()).toBeUndefined();
	});
});

// ─── getState tests ───────────────────────────────────────────────────────────

describe("RpcServer.getState", () => {
	it("responds with idle status by default", async () => {
		const { emitter } = makeCaptureEmitter();
		const { writer, lines } = makeCapturingWriter();
		const stream = makeStream([JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getState" })]);
		const server = new RpcServer(stream, emitter, writer);
		await server.drained;

		expect(lines).toHaveLength(1);
		const resp = JSON.parse(lines[0] as string) as Record<string, unknown>;
		expect(resp.jsonrpc).toBe("2.0");
		expect(resp.id).toBe(1);
		const result = resp.result as Record<string, unknown>;
		expect(result.status).toBe("idle");
		expect(result.currentTool).toBeUndefined();
	});

	it("responds with working status and tool name after setWorking", async () => {
		const { emitter } = makeCaptureEmitter();
		const { writer, lines } = makeCapturingWriter();
		// Set state before the request arrives (simulate async timing)
		const stream = makeStream([JSON.stringify({ id: 2, method: "getState" })]);
		const server = new RpcServer(stream, emitter, writer);
		server.setWorking("bash");
		await server.drained;

		const resp = JSON.parse(lines[0] as string) as Record<string, unknown>;
		expect(resp.id).toBe(2);
		const result = resp.result as Record<string, unknown>;
		expect(result.status).toBe("working");
		expect(result.currentTool).toBe("bash");
	});

	it("responds with error status after setError", async () => {
		const { emitter } = makeCaptureEmitter();
		const { writer, lines } = makeCapturingWriter();
		const stream = makeStream([JSON.stringify({ id: 3, method: "getState" })]);
		const server = new RpcServer(stream, emitter, writer);
		server.setError();
		await server.drained;

		const resp = JSON.parse(lines[0] as string) as Record<string, unknown>;
		const result = resp.result as Record<string, unknown>;
		expect(result.status).toBe("error");
		expect(result.currentTool).toBeUndefined();
	});

	it("clears currentTool when transitioning to idle from working", async () => {
		const { emitter } = makeCaptureEmitter();
		const { writer, lines } = makeCapturingWriter();
		const stream = makeStream([JSON.stringify({ id: 4, method: "getState" })]);
		const server = new RpcServer(stream, emitter, writer);
		server.setWorking("read");
		server.setIdle();
		await server.drained;

		const resp = JSON.parse(lines[0] as string) as Record<string, unknown>;
		const result = resp.result as Record<string, unknown>;
		expect(result.status).toBe("idle");
		expect(result.currentTool).toBeUndefined();
	});

	it("responds with string id unchanged", async () => {
		const { emitter } = makeCaptureEmitter();
		const { writer, lines } = makeCapturingWriter();
		const stream = makeStream([JSON.stringify({ id: "req-99", method: "getState" })]);
		const server = new RpcServer(stream, emitter, writer);
		await server.drained;

		const resp = JSON.parse(lines[0] as string) as Record<string, unknown>;
		expect(resp.id).toBe("req-99");
	});

	it("does not emit rpc_request_ack for getState", async () => {
		const { emitter, events } = makeCaptureEmitter();
		const { writer } = makeCapturingWriter();
		const stream = makeStream([JSON.stringify({ id: 5, method: "getState" })]);
		const server = new RpcServer(stream, emitter, writer);
		await server.drained;

		const acks = events.filter((e) => e.type === "rpc_request_ack");
		expect(acks).toHaveLength(0);
	});

	it("getState is not queued — dequeue returns undefined", async () => {
		const { emitter } = makeCaptureEmitter();
		const { writer } = makeCapturingWriter();
		const stream = makeStream([JSON.stringify({ id: 6, method: "getState" })]);
		const server = new RpcServer(stream, emitter, writer);
		await server.drained;

		expect(server.dequeue()).toBeUndefined();
	});

	it("handles multiple getState requests with different states", async () => {
		const { emitter } = makeCaptureEmitter();
		const lines: string[] = [];
		// We'll use a manual stream to control ordering
		let enqueue: ((chunk: Uint8Array) => void) | undefined;
		let closeStream: (() => void) | undefined;
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				enqueue = (chunk) => controller.enqueue(chunk);
				closeStream = () => controller.close();
			},
		});
		const server = new RpcServer(stream, emitter, (line) => lines.push(line));

		// Send first getState while idle
		enqueue?.(encoder.encode(`${JSON.stringify({ id: 10, method: "getState" })}\n`));
		// Give the async reader a tick to process
		await new Promise<void>((r) => setTimeout(r, 5));

		server.setWorking("glob");
		// Send second getState while working
		enqueue?.(encoder.encode(`${JSON.stringify({ id: 11, method: "getState" })}\n`));
		await new Promise<void>((r) => setTimeout(r, 5));

		closeStream?.();
		await server.drained;

		expect(lines).toHaveLength(2);
		const r1 = JSON.parse(lines[0] as string) as { id: number; result: { status: string } };
		const r2 = JSON.parse(lines[1] as string) as {
			id: number;
			result: { status: string; currentTool?: string };
		};
		expect(r1.id).toBe(10);
		expect(r1.result.status).toBe("idle");
		expect(r2.id).toBe(11);
		expect(r2.result.status).toBe("working");
		expect(r2.result.currentTool).toBe("glob");
	});
});
