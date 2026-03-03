/**
 * Tests for src/hooks/guards.ts
 *
 * Covers each guard function individually and the evaluateGuards() aggregator.
 */

import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import type { GuardConfig } from "../types.ts";
import {
	checkBlockedBashPatterns,
	checkBlockedTools,
	checkFileScope,
	checkPathBoundary,
	checkReadOnly,
	evaluateGuards,
} from "./guards.ts";

// ─── checkPathBoundary ────────────────────────────────────────────────────────

describe("checkPathBoundary", () => {
	const boundary = "/workspace/project";

	it("allows file op inside boundary", () => {
		const result = checkPathBoundary(
			"read",
			{ file_path: "/workspace/project/src/foo.ts" },
			boundary,
		);
		expect(result.allowed).toBe(true);
	});

	it("allows file op at the boundary root itself", () => {
		const result = checkPathBoundary("write", { file_path: "/workspace/project" }, boundary);
		expect(result.allowed).toBe(true);
	});

	it("blocks file op outside boundary (absolute path)", () => {
		const result = checkPathBoundary("write", { file_path: "/etc/passwd" }, boundary);
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("/etc/passwd");
	});

	it("blocks ../ traversal attacks", () => {
		const result = checkPathBoundary(
			"read",
			{ file_path: "/workspace/project/../../../etc/passwd" },
			boundary,
		);
		expect(result.allowed).toBe(false);
	});

	it("passes through non-file tools (bash)", () => {
		const result = checkPathBoundary("bash", { command: "ls" }, boundary);
		expect(result.allowed).toBe(true);
	});

	it("handles input.path (grep/glob tools)", () => {
		const result = checkPathBoundary("grep", { path: "/workspace/project/src" }, boundary);
		expect(result.allowed).toBe(true);
	});

	it("blocks glob with input.path outside boundary", () => {
		const result = checkPathBoundary("glob", { path: "/other/dir" }, boundary);
		expect(result.allowed).toBe(false);
	});

	it("allows when no path in input", () => {
		const result = checkPathBoundary("read", {}, boundary);
		expect(result.allowed).toBe(true);
	});

	it("resolves relative boundary paths", () => {
		const relativeBoundary = "./project";
		const resolved = resolve(relativeBoundary);
		const result = checkPathBoundary(
			"read",
			{ file_path: `${resolved}/src/foo.ts` },
			relativeBoundary,
		);
		expect(result.allowed).toBe(true);
	});
});

// ─── checkFileScope ───────────────────────────────────────────────────────────

describe("checkFileScope", () => {
	const scope = ["/workspace/project/src/foo.ts", "/workspace/project/src/bar.ts"];

	it("allows write to file in scope", () => {
		const result = checkFileScope("write", { file_path: "/workspace/project/src/foo.ts" }, scope);
		expect(result.allowed).toBe(true);
	});

	it("allows edit to file in scope", () => {
		const result = checkFileScope("edit", { file_path: "/workspace/project/src/bar.ts" }, scope);
		expect(result.allowed).toBe(true);
	});

	it("blocks write to file not in scope", () => {
		const result = checkFileScope("write", { file_path: "/workspace/project/src/other.ts" }, scope);
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("other.ts");
	});

	it("passes through read operations", () => {
		const result = checkFileScope("read", { file_path: "/workspace/other.ts" }, scope);
		expect(result.allowed).toBe(true);
	});

	it("passes through glob", () => {
		const result = checkFileScope("glob", { path: "/workspace" }, scope);
		expect(result.allowed).toBe(true);
	});

	it("passes through grep", () => {
		const result = checkFileScope("grep", { path: "/workspace" }, scope);
		expect(result.allowed).toBe(true);
	});

	it("passes through bash", () => {
		const result = checkFileScope("bash", { command: "ls" }, scope);
		expect(result.allowed).toBe(true);
	});

	it("allows when input has no file_path (edit without path)", () => {
		const result = checkFileScope("write", {}, scope);
		expect(result.allowed).toBe(true);
	});
});

// ─── checkReadOnly ────────────────────────────────────────────────────────────

describe("checkReadOnly", () => {
	it("blocks write when readOnly is true", () => {
		const result = checkReadOnly("write", true);
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("write");
	});

	it("blocks edit when readOnly is true", () => {
		const result = checkReadOnly("edit", true);
		expect(result.allowed).toBe(false);
	});

	it("blocks bash when readOnly is true", () => {
		const result = checkReadOnly("bash", true);
		expect(result.allowed).toBe(false);
	});

	it("allows read when readOnly is true", () => {
		const result = checkReadOnly("read", true);
		expect(result.allowed).toBe(true);
	});

	it("allows glob when readOnly is true", () => {
		const result = checkReadOnly("glob", true);
		expect(result.allowed).toBe(true);
	});

	it("allows grep when readOnly is true", () => {
		const result = checkReadOnly("grep", true);
		expect(result.allowed).toBe(true);
	});

	it("allows write when readOnly is false", () => {
		const result = checkReadOnly("write", false);
		expect(result.allowed).toBe(true);
	});

	it("allows bash when readOnly is false", () => {
		const result = checkReadOnly("bash", false);
		expect(result.allowed).toBe(true);
	});
});

// ─── checkBlockedBashPatterns ─────────────────────────────────────────────────

describe("checkBlockedBashPatterns", () => {
	it("blocks bash command matching a literal pattern", () => {
		const result = checkBlockedBashPatterns("bash", { command: "rm -rf /" }, ["rm\\s+-rf"]);
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("rm\\s+-rf");
	});

	it("allows bash command not matching any pattern", () => {
		const result = checkBlockedBashPatterns("bash", { command: "ls -la" }, ["rm\\s+-rf"]);
		expect(result.allowed).toBe(true);
	});

	it("only applies to bash tool", () => {
		const result = checkBlockedBashPatterns("write", { command: "rm -rf /" }, ["rm\\s+-rf"]);
		expect(result.allowed).toBe(true);
	});

	it("handles regex patterns with git push", () => {
		const result = checkBlockedBashPatterns("bash", { command: "git push --force origin main" }, [
			"git\\s+push",
		]);
		expect(result.allowed).toBe(false);
	});

	it("allows git pull when only git push is blocked", () => {
		const result = checkBlockedBashPatterns("bash", { command: "git pull origin main" }, [
			"git\\s+push",
		]);
		expect(result.allowed).toBe(true);
	});

	it("blocks on first matching pattern", () => {
		const result = checkBlockedBashPatterns("bash", { command: "sudo rm -rf /" }, [
			"sudo",
			"rm\\s+-rf",
		]);
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("sudo");
	});

	it("allows when no command in input", () => {
		const result = checkBlockedBashPatterns("bash", {}, ["rm\\s+-rf"]);
		expect(result.allowed).toBe(true);
	});
});

// ─── checkBlockedTools ────────────────────────────────────────────────────────

describe("checkBlockedTools", () => {
	it("blocks tool in the list", () => {
		const result = checkBlockedTools("bash", ["bash", "write"]);
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("bash");
	});

	it("allows tool not in the list", () => {
		const result = checkBlockedTools("read", ["bash", "write"]);
		expect(result.allowed).toBe(true);
	});

	it("is case-sensitive", () => {
		const result = checkBlockedTools("Bash", ["bash"]);
		expect(result.allowed).toBe(true);
	});

	it("allows any tool when list is empty", () => {
		const result = checkBlockedTools("bash", []);
		expect(result.allowed).toBe(true);
	});
});

// ─── evaluateGuards ───────────────────────────────────────────────────────────

describe("evaluateGuards", () => {
	it("returns allowed when config has no flat guards", () => {
		const config: GuardConfig = { rules: [] };
		expect(evaluateGuards("bash", { command: "ls" }, config).allowed).toBe(true);
	});

	it("short-circuits on blockedTools before checking other guards", () => {
		const config: GuardConfig = {
			rules: [],
			blockedTools: ["bash"],
			readOnly: true,
			pathBoundary: "/workspace",
		};
		const result = evaluateGuards("bash", { command: "ls" }, config);
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("bash");
	});

	it("short-circuits on readOnly before pathBoundary", () => {
		const config: GuardConfig = {
			rules: [],
			readOnly: true,
			pathBoundary: "/workspace",
		};
		const result = evaluateGuards("write", { file_path: "/workspace/foo.ts" }, config);
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("read-only");
	});

	it("short-circuits on pathBoundary before fileScope", () => {
		const config: GuardConfig = {
			rules: [],
			pathBoundary: "/workspace",
			fileScope: ["/other/file.ts"],
		};
		const result = evaluateGuards("write", { file_path: "/etc/passwd" }, config);
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("/etc/passwd");
	});

	it("returns allowed when all guards pass", () => {
		const config: GuardConfig = {
			rules: [],
			blockedTools: ["edit"],
			readOnly: false,
			pathBoundary: "/workspace",
			fileScope: ["/workspace/src/foo.ts"],
			blockedBashPatterns: ["rm\\s+-rf"],
		};
		const result = evaluateGuards("bash", { command: "ls" }, config);
		expect(result.allowed).toBe(true);
	});

	it("skips undefined config fields", () => {
		const config: GuardConfig = { rules: [], blockedBashPatterns: ["rm\\s+-rf"] };
		// bash with non-matching command — no other guards defined
		expect(evaluateGuards("bash", { command: "ls" }, config).allowed).toBe(true);
		// bash with matching command — blocked
		expect(evaluateGuards("bash", { command: "rm -rf /" }, config).allowed).toBe(false);
	});

	it("evaluates fileScope after pathBoundary when both present", () => {
		const config: GuardConfig = {
			rules: [],
			pathBoundary: "/workspace",
			fileScope: ["/workspace/src/foo.ts"],
		};
		// Inside boundary but not in scope → blocked by fileScope
		const result = evaluateGuards("write", { file_path: "/workspace/src/other.ts" }, config);
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("other.ts");
	});
});
