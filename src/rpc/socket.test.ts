/**
 * Tests for RpcSocketServer — Unix domain socket for external getState queries.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "../hooks/events.ts";
import { RpcServer } from "./server.ts";
import { RpcSocketServer } from "./socket.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEmptyStream(): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(c) {
			c.close();
		},
	});
}

function makeRpcServer(): RpcServer {
	const emitter = new EventEmitter(false);
	return new RpcServer(makeEmptyStream(), emitter);
}

/** Send a line to a Unix socket and collect one response line. */
async function socketRoundtrip(socketPath: string, request: unknown): Promise<unknown> {
	return new Promise((resolve, reject) => {
		Bun.connect({
			unix: socketPath,
			socket: {
				open(s) {
					s.write(`${JSON.stringify(request)}\n`);
				},
				data(_s, chunk) {
					const text = new TextDecoder().decode(chunk);
					const line = text.trim();
					if (line) {
						try {
							resolve(JSON.parse(line));
						} catch (e) {
							reject(e);
						}
					}
				},
				error(_s, err) {
					reject(err);
				},
			},
		});
		// Timeout safety
		setTimeout(() => reject(new Error("timeout")), 3000);
	});
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("RpcSocketServer", () => {
	let socketPath: string;
	let server: RpcSocketServer;

	beforeEach(() => {
		socketPath = join(
			tmpdir(),
			`sapling-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
		);
		server = new RpcSocketServer(makeRpcServer());
	});

	afterEach(async () => {
		await server.stop();
		// Clean up socket file if still present
		try {
			await rm(socketPath);
		} catch {}
	});

	it("starts and accepts connections", async () => {
		await server.start(socketPath);
		const resp = (await socketRoundtrip(socketPath, {
			jsonrpc: "2.0",
			id: 1,
			method: "getState",
		})) as Record<string, unknown>;
		expect(resp.jsonrpc).toBe("2.0");
		expect(resp.id).toBe(1);
		expect(resp.result).toBeDefined();
	});

	it("returns idle status by default", async () => {
		await server.start(socketPath);
		const resp = (await socketRoundtrip(socketPath, {
			jsonrpc: "2.0",
			id: 2,
			method: "getState",
		})) as Record<string, unknown>;
		const result = resp.result as Record<string, unknown>;
		expect(result.status).toBe("idle");
	});

	it("reflects updated state from RpcServer", async () => {
		const rpcServer = makeRpcServer();
		const socketSrv = new RpcSocketServer(rpcServer);
		await socketSrv.start(socketPath);

		rpcServer.setWorking("bash");
		const resp = (await socketRoundtrip(socketPath, {
			jsonrpc: "2.0",
			id: 3,
			method: "getState",
		})) as Record<string, unknown>;
		const result = resp.result as Record<string, unknown>;
		expect(result.status).toBe("working");
		expect(result.currentTool).toBe("bash");

		await socketSrv.stop();
	});

	it("returns method-not-found for unknown methods", async () => {
		await server.start(socketPath);
		const resp = (await socketRoundtrip(socketPath, {
			jsonrpc: "2.0",
			id: 4,
			method: "steer",
			params: { content: "x" },
		})) as Record<string, unknown>;
		expect(resp.error).toBeDefined();
		const err = resp.error as Record<string, unknown>;
		expect(err.code).toBe(-32601);
	});

	it("returns parse error for invalid JSON", async () => {
		await server.start(socketPath);
		const result = (await new Promise<unknown>((resolve, reject) => {
			Bun.connect({
				unix: socketPath,
				socket: {
					open(s) {
						s.write("not-valid-json\n");
					},
					data(_s, chunk) {
						const text = new TextDecoder().decode(chunk).trim();
						if (text) {
							try {
								resolve(JSON.parse(text));
							} catch (e) {
								reject(e);
							}
						}
					},
					error(_s, err) {
						reject(err);
					},
				},
			});
			setTimeout(() => reject(new Error("timeout")), 3000);
		})) as Record<string, unknown>;
		expect(result.error).toBeDefined();
		const err = result.error as Record<string, unknown>;
		expect(err.code).toBe(-32700);
	});

	it("removes socket file on stop", async () => {
		await server.start(socketPath);
		await server.stop();
		const exists = await Bun.file(socketPath).exists();
		expect(exists).toBe(false);
	});

	it("handles stale socket file gracefully on start", async () => {
		// Create a file at the socket path to simulate a stale socket
		await Bun.write(socketPath, "stale");
		// Should not throw — removes stale file and creates new socket
		await expect(server.start(socketPath)).resolves.toBeUndefined();
	});
});
