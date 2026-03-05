/**
 * RPC server — combines the stdin channel with the event emitter to send
 * acknowledgment events and expose a clean API for the agent loop.
 *
 * Abort requests are acknowledged immediately (status: "accepted").
 * Steer/followUp requests are acknowledged as queued (status: "queued")
 * on receipt; the loop dequeues and injects them between turns.
 * GetState requests are answered synchronously with the current agent state.
 * Invalid requests are acknowledged as rejected (status: "rejected").
 *
 * Agent state is tracked via setWorking/setIdle/setError calls from the loop.
 * Defaults to "idle".
 */

import type { EventEmitter } from "../hooks/events.ts";
import { RpcChannel } from "./channel.ts";
import type {
	AgentStateSnapshot,
	AgentStatus,
	FollowUpRequest,
	PipelineRpcState,
	SteerRequest,
} from "./types.ts";

/** Writer function type — injected for testability, defaults to process.stdout.write. */
type LineWriter = (line: string) => void;

export class RpcServer {
	private readonly channel: RpcChannel;
	private agentStatus: AgentStatus = "idle";
	private agentCurrentTool: string | undefined;
	private pipelineState: PipelineRpcState | undefined;

	/** Resolves when the input stream is exhausted. Useful in tests. */
	readonly drained: Promise<void>;

	constructor(
		stream: ReadableStream<Uint8Array>,
		eventEmitter: EventEmitter,
		writer: LineWriter = (line) => process.stdout.write(line),
	) {
		this.channel = new RpcChannel(stream, (result) => {
			if (result.ok) {
				if (result.request.method === "abort") {
					// Abort is handled immediately — no queue, just ack+flag
					eventEmitter.emit({
						type: "rpc_request_ack",
						method: "abort",
						status: "accepted",
					});
				} else if (result.request.method === "getState") {
					// Respond synchronously with current agent state
					const snap = this.getSnapshot();
					const response: Record<string, unknown> = {
						jsonrpc: "2.0",
						id: result.request.id,
						result: snap,
					};
					writer(`${JSON.stringify(response)}\n`);
				} else {
					// Steer/followUp queued — will be injected at next turn boundary
					eventEmitter.emit({
						type: "rpc_request_ack",
						method: result.request.method,
						status: "queued",
					});
				}
			} else {
				eventEmitter.emit({
					type: "rpc_request_ack",
					method: result.rawMethod ?? "unknown",
					status: "rejected",
					reason: result.error,
				});
			}
		});
		this.drained = this.channel.drained;
	}

	// ─── State Tracking ────────────────────────────────────────────────────────

	/** Notify that the agent is now executing tool(s). Call before tool dispatch. */
	setWorking(toolName: string): void {
		this.agentStatus = "working";
		this.agentCurrentTool = toolName;
	}

	/** Notify that tool execution has finished and the agent is between turns. */
	setIdle(): void {
		this.agentStatus = "idle";
		this.agentCurrentTool = undefined;
	}

	/** Notify that the last LLM call failed with an unrecoverable error. */
	setError(): void {
		this.agentStatus = "error";
		this.agentCurrentTool = undefined;
	}

	/** Update the v1 pipeline state for inclusion in getState responses. */
	setPipelineState(state: PipelineRpcState | undefined): void {
		this.pipelineState = state;
	}

	/** Return a snapshot of the current agent state. */
	getSnapshot(): AgentStateSnapshot {
		const snap: AgentStateSnapshot = { status: this.agentStatus };
		if (this.agentCurrentTool !== undefined) {
			snap.currentTool = this.agentCurrentTool;
		}
		if (this.pipelineState !== undefined) {
			snap.pipeline = this.pipelineState;
		}
		return snap;
	}

	// ─── Loop API ──────────────────────────────────────────────────────────────

	/** Dequeue the next steer/followUp request. Returns undefined if empty. */
	dequeue(): SteerRequest | FollowUpRequest | undefined {
		return this.channel.dequeue();
	}

	/** Returns true if an abort request has been received. */
	isAbortRequested(): boolean {
		return this.channel.isAbortRequested();
	}

	/** Close the stdin channel. */
	close(): void {
		this.channel.close();
	}
}
