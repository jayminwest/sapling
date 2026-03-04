/**
 * Type definitions for the JSON-RPC stdin control channel.
 *
 * Incoming requests arrive as NDJSON lines on stdin (one per line).
 * Outgoing acknowledgments are NDJSON events emitted to stdout.
 */

export interface SteerRequest {
	method: "steer";
	params: { content: string };
}

export interface FollowUpRequest {
	method: "followUp";
	params: { content: string };
}

export interface AbortRequest {
	method: "abort";
}

export interface GetStateRequest {
	id: number | string;
	method: "getState";
}

export type RpcRequest = SteerRequest | FollowUpRequest | AbortRequest | GetStateRequest;

export type RpcAckStatus = "queued" | "accepted" | "rejected";

export type AgentStatus = "idle" | "working" | "error";

export interface AgentStateSnapshot {
	status: AgentStatus;
	currentTool?: string;
}
