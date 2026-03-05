/**
 * RPC Unix domain socket server — exposes getState queries to external tools.
 *
 * When --rpc-socket <path> is provided, Sapling creates a Unix socket at that
 * path and accepts connections. Each connection can send NDJSON getState
 * requests and receive JSON-RPC responses. The socket is removed on exit.
 *
 * Only getState requests are handled; all other methods are rejected.
 * The socket is independent of the stdin RPC channel and may be active even
 * when --mode rpc is not set, allowing external state inspection from any
 * invocation mode.
 */

import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { RpcServer } from "./server.ts";

// ─── Socket Server ────────────────────────────────────────────────────────────

/**
 * A Unix domain socket server that proxies getState queries to the RpcServer.
 *
 * Usage:
 * ```ts
 * const socketServer = new RpcSocketServer(rpcServer);
 * await socketServer.start("/path/to/rpc.sock");
 * // ...agent runs...
 * await socketServer.stop();
 * ```
 */
export class RpcSocketServer {
	private server: ReturnType<typeof Bun.listen> | null = null;
	private socketPath = "";

	constructor(private readonly rpcServer: RpcServer) {}

	/**
	 * Start listening on the given Unix socket path.
	 * Creates parent directories as needed. Removes stale socket if present.
	 */
	async start(socketPath: string): Promise<void> {
		this.socketPath = socketPath;

		// Ensure parent directory exists
		await mkdir(dirname(socketPath), { recursive: true });

		// Remove stale socket file if present (avoids EADDRINUSE)
		try {
			await rm(socketPath);
		} catch {
			// Not present — fine
		}

		const self = this;
		this.server = Bun.listen<{ buf: string }>({
			unix: socketPath,
			socket: {
				open(socket) {
					socket.data = { buf: "" };
				},
				data(socket, chunk) {
					socket.data.buf += new TextDecoder().decode(chunk);
					let newlineIdx = socket.data.buf.indexOf("\n");
					while (newlineIdx !== -1) {
						const line = socket.data.buf.slice(0, newlineIdx).trim();
						socket.data.buf = socket.data.buf.slice(newlineIdx + 1);
						if (line) self.handleLine(socket, line);
						newlineIdx = socket.data.buf.indexOf("\n");
					}
				},
				error(_socket, _err) {
					// Ignore per-connection errors
				},
			},
		});
	}

	/** Handle a single NDJSON line received on the socket. */
	private handleLine(socket: { write(data: string): void }, line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			// Not valid JSON — send parse error
			const response = {
				jsonrpc: "2.0",
				id: null,
				error: { code: -32700, message: "Parse error" },
			};
			socket.write(`${JSON.stringify(response)}\n`);
			return;
		}

		if (
			typeof parsed !== "object" ||
			parsed === null ||
			(parsed as Record<string, unknown>).method !== "getState"
		) {
			const id = (parsed as Record<string, unknown>)?.id ?? null;
			const response = {
				jsonrpc: "2.0",
				id,
				error: { code: -32601, message: "Method not found" },
			};
			socket.write(`${JSON.stringify(response)}\n`);
			return;
		}

		const req = parsed as Record<string, unknown>;
		const snap = this.rpcServer.getSnapshot();
		const response = { jsonrpc: "2.0", id: req.id ?? null, result: snap };
		socket.write(`${JSON.stringify(response)}\n`);
	}

	/** Stop the socket server and remove the socket file. */
	async stop(): Promise<void> {
		try {
			this.server?.stop(true);
		} catch {
			// Ignore errors stopping the server
		}
		if (this.socketPath) {
			try {
				await rm(this.socketPath);
			} catch {
				// Already removed or never created
			}
		}
	}
}
