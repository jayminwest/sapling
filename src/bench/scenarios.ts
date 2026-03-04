/**
 * Benchmark scenarios for the Sapling context pipeline.
 *
 * Each scenario is a synthetic multi-turn conversation that simulates a realistic
 * coding agent task. Turns are pre-built Message arrays — no real LLM calls required.
 * The harness replays them through the context manager to measure token utilization.
 *
 * Three scenario sizes exercise different parts of the pipeline:
 *   - SHORT  (10 turns)  : baseline for overhead, minimal pruning expected
 *   - MEDIUM (30 turns)  : light pruning, archive starts forming
 *   - LONG   (100 turns) : heavy pruning, archive grows, 30–50% reduction target
 */

import type { Message } from "../types.ts";

// ─── Scenario Types ───────────────────────────────────────────────────────────

export interface BenchmarkScenario {
	id: string;
	name: string;
	description: string;
	/** Initial task description sent as the first user message. */
	taskPrompt: string;
	/**
	 * Full message sequence following the task prompt.
	 * Alternates: assistant → user (tool results), ending with an assistant message.
	 */
	messages: Message[];
	/** Minimum expected token reduction vs baseline (0–1). 0 = no expectation. */
	expectedReductionMin: number;
}

// ─── Message Builders ─────────────────────────────────────────────────────────

function assistantText(text: string): Message & { role: "assistant" } {
	return { role: "assistant", content: [{ type: "text", text }] };
}

function assistantTool(
	name: string,
	id: string,
	input: Record<string, unknown>,
): Message & { role: "assistant" } {
	return { role: "assistant", content: [{ type: "tool_use", id, name, input }] };
}

/**
 * User message carrying a tool result.
 * Uses plain string content (the tool_use_id is not needed for benchmark scenarios
 * since we drive the context pipeline with synthetic data, not real tool dispatch).
 * This avoids tool_result blocks which would crash the canonical estimateBlockTokens.
 */
function toolResult(_id: string, content: string, _isError = false): Message & { role: "user" } {
	return { role: "user", content };
}

function userAck(): Message & { role: "user" } {
	return { role: "user", content: "[Acknowledged]" };
}

/** Generate a realistic-looking file content string of approximately `chars` characters. */
function syntheticFile(name: string, chars: number): string {
	const header = `// ${name} — synthetic file for benchmark\n`;
	const lineLen = 80;
	const lines: string[] = [header];
	while (lines.join("\n").length < chars) {
		const lineNum = lines.length;
		lines.push(
			`export function fn${lineNum}(x: number): number { return x * ${lineNum} + ${lineNum % 7}; }`,
		);
		if (lines.join("\n").length < chars) {
			lines.push(`// comment line ${lineNum}: ${"─".repeat(lineLen - 20)}`);
		}
	}
	return lines.join("\n").slice(0, chars);
}

/** Generate a test output string for N tests. */
function syntheticTestOutput(n: number, file: string): string {
	const lines = [`bun test ${file}`, `Running ${n} tests...`];
	for (let i = 1; i <= n; i++) {
		lines.push(`  ✓ test case ${i} passes (${(i % 5) + 1}ms)`);
	}
	lines.push(`\n✓ ${n} tests passed (${n * 3}ms)`);
	return lines.join("\n");
}

// ─── SHORT Scenario: 10 turns — debug a failing test ─────────────────────────

function buildShortMessages(): Message[] {
	const msgs: Message[] = [];

	// Turn 1: read the failing file
	msgs.push(assistantTool("read", "s1", { file_path: "src/utils/validator.ts" }));
	msgs.push(toolResult("s1", syntheticFile("src/utils/validator.ts", 600)));

	// Turn 2: read the test file
	msgs.push(assistantTool("read", "s2", { file_path: "src/utils/validator.test.ts" }));
	msgs.push(
		toolResult(
			"s2",
			`import { describe, expect, it } from "bun:test";
import { validate } from "./validator.ts";

describe("validate", () => {
  it("accepts valid email", () => expect(validate("a@b.com")).toBe(true));
  it("rejects empty string", () => expect(validate("")).toBe(false));
  it("rejects malformed email", () => expect(validate("not-an-email")).toBe(false));
});`,
		),
	);

	// Turn 3: run tests to see failure
	msgs.push(assistantTool("bash", "s3", { command: "bun test src/utils/validator.test.ts" }));
	msgs.push(
		toolResult(
			"s3",
			`bun test src/utils/validator.test.ts
  ✓ accepts valid email (3ms)
  ✓ rejects empty string (2ms)
  ✗ FAILED: rejects malformed email
    Expected: false
    Received: true
1 of 3 tests failed`,
			true,
		),
	);

	// Turn 4: fix the validator
	msgs.push(
		assistantTool("edit", "s4", {
			file_path: "src/utils/validator.ts",
			old_string: "return input.length > 0;",
			new_string: "return /^[^@]+@[^@]+\\.[^@]+$/.test(input);",
		}),
	);
	msgs.push(toolResult("s4", "Edit applied successfully."));

	// Turn 5: re-run tests
	msgs.push(assistantTool("bash", "s5", { command: "bun test src/utils/validator.test.ts" }));
	msgs.push(toolResult("s5", syntheticTestOutput(3, "src/utils/validator.test.ts")));

	// Turn 6: typecheck
	msgs.push(assistantTool("bash", "s6", { command: "bun run typecheck" }));
	msgs.push(toolResult("s6", "✓ No TypeScript errors"));

	// Turn 7: lint
	msgs.push(assistantTool("bash", "s7", { command: "bun run lint" }));
	msgs.push(toolResult("s7", "✓ No lint errors"));

	// Turn 8: run broader test suite
	msgs.push(assistantTool("bash", "s8", { command: "bun test src/utils/" }));
	msgs.push(toolResult("s8", syntheticTestOutput(12, "src/utils/")));

	// Turn 9: quick grep to confirm no other callers affected
	msgs.push(assistantTool("grep", "s9", { pattern: "validate\\(", glob: "src/**/*.ts" }));
	msgs.push(
		toolResult(
			"s9",
			'src/utils/validator.test.ts:5: validate("a@b.com")\nsrc/api/auth.ts:23: validate(req.email)',
		),
	);

	// Turn 10: final summary (no tool call — loop terminates)
	msgs.push(
		assistantText(
			"Fixed the validator bug: the email regex was missing. Updated validate() to use /^[^@]+@[^@]+\\.[^@]+$/ pattern. All 12 tests pass, typecheck and lint clean.",
		),
	);

	return msgs;
}

// ─── MEDIUM Scenario: 30 turns — add a new API endpoint ──────────────────────

function buildMediumMessages(): Message[] {
	const msgs: Message[] = [];

	// Turns 1–5: exploration
	msgs.push(assistantTool("glob", "m1", { pattern: "src/api/**/*.ts" }));
	msgs.push(
		toolResult(
			"m1",
			"src/api/server.ts\nsrc/api/router.ts\nsrc/api/types.ts\nsrc/api/routes/users.ts\nsrc/api/routes/posts.ts\nsrc/api/middleware/auth.ts",
		),
	);

	msgs.push(assistantTool("read", "m2", { file_path: "src/api/types.ts" }));
	msgs.push(toolResult("m2", syntheticFile("src/api/types.ts", 400)));

	msgs.push(assistantTool("read", "m3", { file_path: "src/api/router.ts" }));
	msgs.push(toolResult("m3", syntheticFile("src/api/router.ts", 800)));

	msgs.push(assistantTool("read", "m4", { file_path: "src/api/routes/users.ts" }));
	msgs.push(toolResult("m4", syntheticFile("src/api/routes/users.ts", 900)));

	msgs.push(assistantTool("read", "m5", { file_path: "src/api/routes/posts.ts" }));
	msgs.push(toolResult("m5", syntheticFile("src/api/routes/posts.ts", 700)));

	// Turn 6: check existing tests
	msgs.push(assistantTool("glob", "m6", { pattern: "src/api/**/*.test.ts" }));
	msgs.push(
		toolResult(
			"m6",
			"src/api/routes/users.test.ts\nsrc/api/routes/posts.test.ts\nsrc/api/router.test.ts",
		),
	);

	msgs.push(assistantTool("read", "m7", { file_path: "src/api/routes/posts.test.ts" }));
	msgs.push(toolResult("m7", syntheticFile("src/api/routes/posts.test.ts", 600)));

	// Turn 8: plan
	msgs.push(
		assistantText(
			"I have a clear picture of the structure. I'll add a GET /api/tags endpoint that returns all unique tags from the posts collection. Following the existing pattern: route handler in src/api/routes/tags.ts, registered in router.ts, with tests in src/api/routes/tags.test.ts.",
		),
	);
	msgs.push(userAck());

	// Turns 9–12: implementation
	msgs.push(
		assistantTool("write", "m9", {
			file_path: "src/api/routes/tags.ts",
			content: `import type { Tag } from '../types.ts';
import { db } from '../db.ts';

export async function listTags(): Promise<Tag[]> {
  const posts = await db.posts.findAll();
  const tagSet = new Set<string>();
  for (const post of posts) {
    for (const tag of post.tags ?? []) tagSet.add(tag);
  }
  return Array.from(tagSet).sort().map(name => ({ name }));
}`,
		}),
	);
	msgs.push(toolResult("m9", "File written: src/api/routes/tags.ts"));

	msgs.push(
		assistantTool("write", "m10", {
			file_path: "src/api/routes/tags.test.ts",
			content: `import { describe, expect, it } from "bun:test";
import { listTags } from "./tags.ts";

describe("listTags", () => {
  it("returns sorted unique tags", async () => {
    const tags = await listTags();
    const names = tags.map(t => t.name);
    expect(names).toEqual([...new Set(names)].sort());
  });
  it("returns Tag objects with name field", async () => {
    const tags = await listTags();
    for (const tag of tags) expect(typeof tag.name).toBe('string');
  });
});`,
		}),
	);
	msgs.push(toolResult("m10", "File written: src/api/routes/tags.test.ts"));

	msgs.push(
		assistantTool("edit", "m11", {
			file_path: "src/api/router.ts",
			old_string: "import { listPosts } from './routes/posts.ts';",
			new_string:
				"import { listPosts } from './routes/posts.ts';\nimport { listTags } from './routes/tags.ts';",
		}),
	);
	msgs.push(toolResult("m11", "Edit applied."));

	msgs.push(
		assistantTool("edit", "m12", {
			file_path: "src/api/router.ts",
			old_string: "router.get('/api/posts', listPosts);",
			new_string: "router.get('/api/posts', listPosts);\nrouter.get('/api/tags', listTags);",
		}),
	);
	msgs.push(toolResult("m12", "Edit applied."));

	// Turns 13–16: test and fix
	msgs.push(assistantTool("bash", "m13", { command: "bun test src/api/routes/tags.test.ts" }));
	msgs.push(
		toolResult(
			"m13",
			`bun test src/api/routes/tags.test.ts
  ✗ FAILED: returns sorted unique tags
    TypeError: db is not defined
1 of 2 tests failed`,
			true,
		),
	);

	msgs.push(assistantTool("read", "m14", { file_path: "src/api/routes/tags.ts" }));
	msgs.push(
		toolResult(
			"m14",
			`import type { Tag } from '../types.ts';
import { db } from '../db.ts';

export async function listTags(): Promise<Tag[]> {
  const posts = await db.posts.findAll();
  ...
}`,
		),
	);

	msgs.push(assistantTool("grep", "m15", { pattern: "import.*db", glob: "src/api/**/*.ts" }));
	msgs.push(
		toolResult(
			"m15",
			`src/api/routes/users.ts:2: import { db } from '../db.ts';
src/api/routes/posts.ts:2: import { db } from '../db.ts';`,
		),
	);

	msgs.push(
		assistantText(
			"The db import path is correct. The test environment needs a mock db. Let me check how other route tests set up the db mock.",
		),
	);
	msgs.push(userAck());

	// Turns 17–20: fix test setup
	msgs.push(assistantTool("read", "m17", { file_path: "src/api/routes/posts.test.ts" }));
	msgs.push(
		toolResult(
			"m17",
			`import { describe, expect, it, mock } from "bun:test";
import * as dbModule from "../db.ts";

mock.module("../db.ts", () => ({
  db: { posts: { findAll: async () => [{ tags: ["a","b"] }, { tags: ["b","c"] }] } }
}));
import { listPosts } from "./posts.ts";`,
		),
	);

	msgs.push(
		assistantTool("edit", "m18", {
			file_path: "src/api/routes/tags.test.ts",
			old_string: 'import { describe, expect, it } from "bun:test";',
			new_string: `import { describe, expect, it, mock } from "bun:test";

mock.module("../db.ts", () => ({
  db: { posts: { findAll: async () => [
    { tags: ["typescript","bun"] },
    { tags: ["bun","testing"] },
  ]}}
}));`,
		}),
	);
	msgs.push(toolResult("m18", "Edit applied."));

	msgs.push(assistantTool("bash", "m19", { command: "bun test src/api/routes/tags.test.ts" }));
	msgs.push(toolResult("m19", syntheticTestOutput(2, "src/api/routes/tags.test.ts")));

	msgs.push(assistantTool("bash", "m20", { command: "bun test src/api/" }));
	msgs.push(toolResult("m20", syntheticTestOutput(18, "src/api/")));

	// Turns 21–25: quality gates
	msgs.push(assistantTool("bash", "m21", { command: "bun run typecheck" }));
	msgs.push(toolResult("m21", "✓ No TypeScript errors"));

	msgs.push(assistantTool("bash", "m22", { command: "bun run lint" }));
	msgs.push(toolResult("m22", "✓ No lint errors"));

	msgs.push(assistantTool("bash", "m23", { command: "bun test" }));
	msgs.push(toolResult("m23", syntheticTestOutput(42, "all files")));

	// Turns 24–27: documentation update
	msgs.push(assistantTool("read", "m24", { file_path: "src/api/server.ts" }));
	msgs.push(toolResult("m24", syntheticFile("src/api/server.ts", 500)));

	msgs.push(assistantTool("grep", "m25", { pattern: "/api/", glob: "README.md" }));
	msgs.push(
		toolResult(
			"m25",
			"README.md:45: GET /api/users — list users\nREADME.md:46: GET /api/posts — list posts",
		),
	);

	msgs.push(
		assistantTool("edit", "m26", {
			file_path: "README.md",
			old_string: "GET /api/posts — list posts",
			new_string: "GET /api/posts — list posts\nGET /api/tags — list all unique tags",
		}),
	);
	msgs.push(toolResult("m26", "Edit applied."));

	msgs.push(assistantTool("bash", "m27", { command: "bun run lint" }));
	msgs.push(toolResult("m27", "✓ No lint errors"));

	// Turns 28–29: final check
	msgs.push(
		assistantTool("bash", "m28", { command: "bun test && bun run typecheck && bun run lint" }),
	);
	msgs.push(toolResult("m28", "✓ All 42 tests passed\n✓ No TypeScript errors\n✓ No lint errors"));

	// Turn 30: summary (no tool call)
	msgs.push(
		assistantText(
			"Done. Added GET /api/tags endpoint:\n- src/api/routes/tags.ts: listTags() handler aggregating tags from posts\n- src/api/routes/tags.test.ts: 2 tests with mocked db\n- src/api/router.ts: registered the route\n- README.md: updated API listing\nAll 42 tests pass, typecheck and lint clean.",
		),
	);

	return msgs;
}

// ─── LONG Scenario: 100 turns — large refactor + feature addition ─────────────

function buildLongMessages(): Message[] {
	const msgs: Message[] = [];

	// --- Phase 1: Explore (turns 1–4) ---

	// Turn 1: glob structure
	msgs.push(assistantTool("glob", "l1", { pattern: "src/**/*.ts" }));
	msgs.push(
		toolResult(
			"l1",
			Array.from({ length: 20 }, (_, i) => `src/module${i + 1}.ts`).join("\n") +
				"\nsrc/index.ts\nsrc/types.ts",
		),
	);

	// Turn 2: read types.ts
	msgs.push(assistantTool("read", "l2", { file_path: "src/types.ts" }));
	msgs.push(toolResult("l2", syntheticFile("src/types.ts", 600)));

	// Turn 3: read index.ts
	msgs.push(assistantTool("read", "l3", { file_path: "src/index.ts" }));
	msgs.push(toolResult("l3", syntheticFile("src/index.ts", 500)));

	// Turn 4: plan (text response, acknowledged by user)
	msgs.push(
		assistantText(
			"I'll refactor all 20 modules to use a shared BaseModule class. Plan: (1) write base-module.ts, (2) read each module, (3) edit each module, (4) run tests in batches, (5) final quality gates.",
		),
	);
	msgs.push(userAck());

	// --- Phase 2: Write base module (turn 5) ---

	msgs.push(
		assistantTool("write", "l5", {
			file_path: "src/base-module.ts",
			content: `export abstract class BaseModule {
  abstract readonly id: string;
  abstract compute(x: number): number;
  validate(x: number): boolean { return typeof x === 'number' && !isNaN(x); }
  run(x: number): number {
    if (!this.validate(x)) throw new Error('Invalid input');
    return this.compute(x);
  }
}`,
		}),
	);
	msgs.push(toolResult("l5", "File written: src/base-module.ts"));

	// --- Phase 3: Read all 20 modules (turns 6–25, 20 reads) ---

	for (let i = 0; i < 20; i++) {
		const id = `lr${i}`;
		const file = `src/module${i + 1}.ts`;
		msgs.push(assistantTool("read", id, { file_path: file }));
		msgs.push(toolResult(id, syntheticFile(file, 700)));
	}

	// Turn 26: checkpoint
	msgs.push(
		assistantText(
			"Read all 20 modules. Each exports a standalone function fn1–fn20. Converting to class-based pattern now.",
		),
	);
	msgs.push(userAck());

	// --- Phase 4: Edit all 20 modules (turns 27–46, 20 edits) ---

	for (let i = 0; i < 20; i++) {
		const id = `le${i}`;
		msgs.push(
			assistantTool("edit", id, {
				file_path: `src/module${i + 1}.ts`,
				old_string: `export function fn${i + 1}(x: number): number`,
				new_string: `import { BaseModule } from './base-module.ts';\nexport class Module${i + 1} extends BaseModule {\n  readonly id = 'module${i + 1}';\n  compute(x: number): number`,
			}),
		);
		msgs.push(toolResult(id, "Edit applied."));
	}

	// --- Phase 5: Test in batches (turns 47–56, 10 test runs) ---

	for (let batch = 0; batch < 10; batch++) {
		const start = batch * 2 + 1;
		const end = start + 1;
		const id = `lt${batch}`;
		msgs.push(
			assistantTool("bash", id, {
				command: `bun test src/module${start}.test.ts src/module${end}.test.ts`,
			}),
		);

		if (batch === 4) {
			// Simulate a test failure at batch 5
			msgs.push(
				toolResult(
					id,
					`bun test src/module9.test.ts src/module10.test.ts
  ✓ module9 compute (2ms)
  ✗ FAILED: module10 compute
    Expected: 30, Received: 31
1 of 2 tests failed`,
					true,
				),
			);
		} else {
			msgs.push(toolResult(id, syntheticTestOutput(8, `src/module${start}–${end}.test.ts`)));
		}
	}

	// --- Phase 6: Debug the failing test (turns 57–62) ---

	// Turn 57: re-read module10
	msgs.push(assistantTool("read", "dbg1", { file_path: "src/module10.ts" }));
	msgs.push(
		toolResult(
			"dbg1",
			`import { BaseModule } from './base-module.ts';
export class Module10 extends BaseModule {
  readonly id = 'module10';
  compute(x: number): number { return x * 10 + 1; } // bug: should be + 0
}`,
		),
	);

	// Turn 58: identify bug
	msgs.push(
		assistantText(
			"Found the bug: Module10.compute returns x * 10 + 1 but should be x * 10. The +1 is wrong. Fixing now.",
		),
	);
	msgs.push(userAck());

	// Turn 59: fix module10
	msgs.push(
		assistantTool("edit", "dbg2", {
			file_path: "src/module10.ts",
			old_string: "return x * 10 + 1;",
			new_string: "return x * 10;",
		}),
	);
	msgs.push(toolResult("dbg2", "Edit applied."));

	// Turn 60: re-run failed test
	msgs.push(
		assistantTool("bash", "dbg3", { command: "bun test src/module9.test.ts src/module10.test.ts" }),
	);
	msgs.push(toolResult("dbg3", syntheticTestOutput(8, "src/module9–10.test.ts")));

	// Turn 61: run remaining 10 modules tests
	msgs.push(
		assistantTool("bash", "ltr1", {
			command:
				"bun test src/module11.test.ts src/module12.test.ts src/module13.test.ts src/module14.test.ts src/module15.test.ts",
		}),
	);
	msgs.push(toolResult("ltr1", syntheticTestOutput(20, "src/module11–15.test.ts")));

	// Turn 62: last 5 module tests
	msgs.push(
		assistantTool("bash", "ltr2", {
			command:
				"bun test src/module16.test.ts src/module17.test.ts src/module18.test.ts src/module19.test.ts src/module20.test.ts",
		}),
	);
	msgs.push(toolResult("ltr2", syntheticTestOutput(20, "src/module16–20.test.ts")));

	// --- Phase 7: Update index.ts (turns 63–66) ---

	// Turn 63: read current index.ts
	msgs.push(assistantTool("read", "idx1", { file_path: "src/index.ts" }));
	msgs.push(toolResult("idx1", syntheticFile("src/index.ts", 300)));

	// Turn 64: update exports
	msgs.push(
		assistantTool("edit", "idx2", {
			file_path: "src/index.ts",
			old_string: "// module exports",
			new_string: Array.from(
				{ length: 20 },
				(_, i) => `export { Module${i + 1} } from './module${i + 1}.ts';`,
			).join("\n"),
		}),
	);
	msgs.push(toolResult("idx2", "Edit applied."));

	// Turn 65: verify grep for old function names
	msgs.push(
		assistantTool("grep", "grep1", {
			pattern: "export function fn",
			glob: "src/module*.ts",
		}),
	);
	msgs.push(toolResult("grep1", "(no matches — all converted to classes)"));

	// Turn 66: grep for BaseModule import to confirm all modules updated
	msgs.push(
		assistantTool("grep", "grep2", {
			pattern: "extends BaseModule",
			glob: "src/module*.ts",
		}),
	);
	msgs.push(
		toolResult(
			"grep2",
			Array.from({ length: 20 }, (_, i) => `src/module${i + 1}.ts:2: extends BaseModule`).join(
				"\n",
			),
		),
	);

	// --- Phase 8: Quality gates (turns 67–72) ---

	// Turn 67: typecheck
	msgs.push(assistantTool("bash", "qg1", { command: "bun run typecheck" }));
	msgs.push(toolResult("qg1", "✓ No TypeScript errors"));

	// Turn 68: lint
	msgs.push(assistantTool("bash", "qg2", { command: "bun run lint" }));
	msgs.push(toolResult("qg2", "✓ No lint errors"));

	// Turn 69: full test suite
	msgs.push(assistantTool("bash", "qg3", { command: "bun test" }));
	msgs.push(toolResult("qg3", syntheticTestOutput(160, "all files")));

	// Turn 70: test base-module directly
	msgs.push(
		assistantTool("write", "bmt", {
			file_path: "src/base-module.test.ts",
			content: `import { describe, expect, it } from "bun:test";
import { BaseModule } from "./base-module.ts";

class TestModule extends BaseModule {
  readonly id = 'test';
  compute(x: number): number { return x * 2; }
}

describe("BaseModule", () => {
  it("validate rejects NaN", () => {
    expect(new TestModule().validate(NaN)).toBe(false);
  });
  it("run throws on invalid input", () => {
    expect(() => new TestModule().run(NaN)).toThrow('Invalid input');
  });
  it("run delegates to compute", () => {
    expect(new TestModule().run(5)).toBe(10);
  });
});`,
		}),
	);
	msgs.push(toolResult("bmt", "File written: src/base-module.test.ts"));

	// Turn 71: run base-module tests
	msgs.push(assistantTool("bash", "bmt2", { command: "bun test src/base-module.test.ts" }));
	msgs.push(toolResult("bmt2", syntheticTestOutput(3, "src/base-module.test.ts")));

	// Turn 72: run full suite again to confirm
	msgs.push(assistantTool("bash", "full2", { command: "bun test && bun run typecheck" }));
	msgs.push(toolResult("full2", "✓ 163 tests passed\n✓ No TypeScript errors"));

	// --- Phase 9: Documentation (turns 73–80) ---

	// Turn 73: check if docs/ exists
	msgs.push(assistantTool("glob", "doc_glob", { pattern: "docs/**" }));
	msgs.push(toolResult("doc_glob", "docs/README.md\ndocs/api.md\ndocs/examples.md"));

	// Turn 74: read api docs
	msgs.push(assistantTool("read", "doc_read", { file_path: "docs/api.md" }));
	msgs.push(toolResult("doc_read", syntheticFile("docs/api.md", 800)));

	// Turn 75: update api docs
	msgs.push(
		assistantTool("edit", "doc_edit", {
			file_path: "docs/api.md",
			old_string: "## Module Functions",
			new_string: "## Module Classes (v2.0)\n\nAll modules now extend BaseModule.",
		}),
	);
	msgs.push(toolResult("doc_edit", "Edit applied."));

	// Turn 76: write migration guide
	msgs.push(
		assistantTool("write", "mg_write", {
			file_path: "docs/migration-v2.md",
			content: `# Migration Guide: v1 → v2\n\n## Breaking Changes\n\nAll module exports changed from functions to classes.\n\n### Before\n\`\`\`ts\nimport { fn1 } from './module1.ts';\nconst result = fn1(42);\n\`\`\`\n\n### After\n\`\`\`ts\nimport { Module1 } from './module1.ts';\nconst result = new Module1().run(42);\n\`\`\`\n\n## Upgrading\n\nReplace all \`fn<N>\` imports with \`Module<N>\` and call \`.run(x)\` instead of calling the function directly.`,
		}),
	);
	msgs.push(toolResult("mg_write", "File written: docs/migration-v2.md"));

	// Turn 77: read CHANGELOG if it exists
	msgs.push(assistantTool("read", "cl_read", { file_path: "CHANGELOG.md" }));
	msgs.push(toolResult("cl_read", syntheticFile("CHANGELOG.md", 400)));

	// Turn 78: update CHANGELOG
	msgs.push(
		assistantTool("edit", "cl_edit", {
			file_path: "CHANGELOG.md",
			old_string: "## Unreleased",
			new_string:
				"## Unreleased\n\n### Breaking Changes\n- All module functions converted to BaseModule classes\n- New base-module.ts with shared validation and run() method",
		}),
	);
	msgs.push(toolResult("cl_edit", "Edit applied."));

	// Turn 79: lint docs
	msgs.push(assistantTool("bash", "doc_lint", { command: "bun run lint" }));
	msgs.push(toolResult("doc_lint", "✓ No lint errors"));

	// Turn 80: final full suite
	msgs.push(assistantTool("bash", "final_suite", { command: "bun test" }));
	msgs.push(toolResult("final_suite", syntheticTestOutput(163, "all files")));

	// --- Phase 10: Verification sweep (turns 81–99) ---

	// Spot-check each module's compute output via grep patterns
	for (let i = 0; i < 10; i++) {
		const id = `vg${i}`;
		msgs.push(
			assistantTool("grep", id, {
				pattern: `compute.*module${i + 1}`,
				glob: `src/module${i + 1}.ts`,
			}),
		);
		msgs.push(
			toolResult(
				id,
				`src/module${i + 1}.ts:4:   compute(x: number): number { return x * ${i + 1}; }`,
			),
		);
	}

	// Turn 92-98: verify last 7 modules
	for (let i = 10; i < 17; i++) {
		const id = `vg${i}`;
		msgs.push(
			assistantTool("grep", id, {
				pattern: `compute.*module${i + 1}`,
				glob: `src/module${i + 1}.ts`,
			}),
		);
		msgs.push(
			toolResult(
				id,
				`src/module${i + 1}.ts:4:   compute(x: number): number { return x * ${i + 1}; }`,
			),
		);
	}

	// Turn 99: confirm all done with typecheck
	msgs.push(assistantTool("bash", "final_tc", { command: "bun run typecheck && bun run lint" }));
	msgs.push(toolResult("final_tc", "✓ No TypeScript errors\n✓ No lint errors"));

	// Turn 100: final summary (no tool call)
	msgs.push(
		assistantText(
			`Refactoring complete. Converted all 20 modules from standalone functions to classes extending BaseModule:\n\n- src/base-module.ts: shared abstract base with validate() and run() (+ 3 tests)\n- src/module1.ts – src/module20.ts: each now extends BaseModule\n- src/index.ts: updated class exports\n- docs/migration-v2.md: migration guide\n- docs/api.md + CHANGELOG.md: updated\n\nAll 163 tests pass, typecheck and lint clean. Fixed 1 bug in Module10 during testing.`,
		),
	);

	return msgs;
}

// ─── SHORT Scenario 2: 10 turns — grep-driven code investigation ──────────────

function buildShortGrepMessages(): Message[] {
	const msgs: Message[] = [];

	// Turn 1: grep for usage sites
	msgs.push(assistantTool("grep", "sg1", { pattern: "parseConfig", glob: "src/**/*.ts" }));
	msgs.push(
		toolResult(
			"sg1",
			"src/config/parser.ts:12: export function parseConfig\nsrc/cli.ts:34: parseConfig(argv)\nsrc/server.ts:8: parseConfig(env)",
		),
	);

	// Turn 2: read the parser
	msgs.push(assistantTool("read", "sg2", { file_path: "src/config/parser.ts" }));
	msgs.push(toolResult("sg2", syntheticFile("src/config/parser.ts", 500)));

	// Turn 3: read cli.ts usage
	msgs.push(assistantTool("read", "sg3", { file_path: "src/cli.ts" }));
	msgs.push(toolResult("sg3", syntheticFile("src/cli.ts", 400)));

	// Turn 4: grep for the old signature
	msgs.push(assistantTool("grep", "sg4", { pattern: "parseConfig\\(", glob: "src/**/*.ts" }));
	msgs.push(
		toolResult(
			"sg4",
			"src/cli.ts:34: parseConfig(argv)\nsrc/server.ts:8: parseConfig(env)\nsrc/test/helpers.ts:5: parseConfig({})",
		),
	);

	// Turn 5: read server usage
	msgs.push(assistantTool("read", "sg5", { file_path: "src/server.ts" }));
	msgs.push(toolResult("sg5", syntheticFile("src/server.ts", 350)));

	// Turn 6: fix the signature in parser.ts
	msgs.push(
		assistantTool("edit", "sg6", {
			file_path: "src/config/parser.ts",
			old_string: "export function parseConfig(input: unknown)",
			new_string: "export function parseConfig(input: Record<string, unknown>)",
		}),
	);
	msgs.push(toolResult("sg6", "Edit applied."));

	// Turn 7: typecheck
	msgs.push(assistantTool("bash", "sg7", { command: "bun run typecheck" }));
	msgs.push(toolResult("sg7", "✓ No TypeScript errors"));

	// Turn 8: run tests
	msgs.push(assistantTool("bash", "sg8", { command: "bun test src/config/" }));
	msgs.push(toolResult("sg8", syntheticTestOutput(6, "src/config/")));

	// Turn 9: lint
	msgs.push(assistantTool("bash", "sg9", { command: "bun run lint" }));
	msgs.push(toolResult("sg9", "✓ No lint errors"));

	// Turn 10: summary
	msgs.push(
		assistantText(
			"Updated parseConfig signature to accept Record<string,unknown> instead of unknown. All 6 tests pass, typecheck and lint clean.",
		),
	);

	return msgs;
}

// ─── SHORT Scenario 3: 10 turns — add a small utility function ────────────────

function buildShortWriteMessages(): Message[] {
	const msgs: Message[] = [];

	// Turn 1: glob to understand structure
	msgs.push(assistantTool("glob", "sw1", { pattern: "src/utils/**/*.ts" }));
	msgs.push(toolResult("sw1", "src/utils/format.ts\nsrc/utils/parse.ts\nsrc/utils/index.ts"));

	// Turn 2: read format.ts
	msgs.push(assistantTool("read", "sw2", { file_path: "src/utils/format.ts" }));
	msgs.push(toolResult("sw2", syntheticFile("src/utils/format.ts", 300)));

	// Turn 3: read index.ts
	msgs.push(assistantTool("read", "sw3", { file_path: "src/utils/index.ts" }));
	msgs.push(toolResult("sw3", `export * from './format.ts';\nexport * from './parse.ts';`));

	// Turn 4: write the new function
	msgs.push(
		assistantTool("write", "sw4", {
			file_path: "src/utils/slugify.ts",
			content:
				"export function slugify(text: string): string { return text.toLowerCase().replace(/\\s+/g, '-').replace(/[^a-z0-9-]/g, ''); }",
		}),
	);
	msgs.push(toolResult("sw4", "File written: src/utils/slugify.ts"));

	// Turn 5: add to index
	msgs.push(
		assistantTool("edit", "sw5", {
			file_path: "src/utils/index.ts",
			old_string: "export * from './parse.ts';",
			new_string: "export * from './parse.ts';\nexport * from './slugify.ts';",
		}),
	);
	msgs.push(toolResult("sw5", "Edit applied."));

	// Turn 6: write tests
	msgs.push(
		assistantTool("write", "sw6", {
			file_path: "src/utils/slugify.test.ts",
			content: `import { describe, expect, it } from "bun:test";\nimport { slugify } from './slugify.ts';\ndescribe('slugify', () => {\n  it('lowercases', () => expect(slugify('Hello World')).toBe('hello-world'));\n  it('removes specials', () => expect(slugify('foo!bar')).toBe('foobar'));\n});`,
		}),
	);
	msgs.push(toolResult("sw6", "File written: src/utils/slugify.test.ts"));

	// Turn 7: run tests
	msgs.push(assistantTool("bash", "sw7", { command: "bun test src/utils/slugify.test.ts" }));
	msgs.push(toolResult("sw7", syntheticTestOutput(2, "src/utils/slugify.test.ts")));

	// Turn 8: typecheck
	msgs.push(assistantTool("bash", "sw8", { command: "bun run typecheck" }));
	msgs.push(toolResult("sw8", "✓ No TypeScript errors"));

	// Turn 9: lint
	msgs.push(assistantTool("bash", "sw9", { command: "bun run lint" }));
	msgs.push(toolResult("sw9", "✓ No lint errors"));

	// Turn 10: summary
	msgs.push(
		assistantText(
			"Added slugify() utility to src/utils/slugify.ts with 2 tests. Exported from index. Typecheck and lint clean.",
		),
	);

	return msgs;
}

// ─── MEDIUM Scenario 2: 30 turns — migrate types to strict null checks ────────

function buildMediumTypesMessages(): Message[] {
	const msgs: Message[] = [];

	// Exploration (turns 1–5)
	msgs.push(assistantTool("glob", "mt1", { pattern: "src/**/*.ts" }));
	msgs.push(
		toolResult(
			"mt1",
			"src/types.ts\nsrc/api.ts\nsrc/db.ts\nsrc/cache.ts\nsrc/index.ts\nsrc/utils.ts",
		),
	);

	msgs.push(assistantTool("read", "mt2", { file_path: "src/types.ts" }));
	msgs.push(toolResult("mt2", syntheticFile("src/types.ts", 600)));

	msgs.push(assistantTool("grep", "mt3", { pattern: "\\| undefined", glob: "src/**/*.ts" }));
	msgs.push(
		toolResult(
			"mt3",
			"src/types.ts:5: user: User | undefined\nsrc/types.ts:12: token: string | undefined\nsrc/api.ts:3: response: Response | undefined",
		),
	);

	msgs.push(assistantTool("read", "mt4", { file_path: "src/api.ts" }));
	msgs.push(toolResult("mt4", syntheticFile("src/api.ts", 700)));

	msgs.push(assistantTool("bash", "mt5", { command: "bun run typecheck" }));
	msgs.push(
		toolResult(
			"mt5",
			`src/api.ts(23,5): error TS2345: Type 'undefined' not assignable\nsrc/db.ts(12,3): error TS2532: Object possibly undefined`,
			true,
		),
	);

	// Planning (turn 6)
	msgs.push(
		assistantText(
			"Found 2 typecheck errors. I'll fix src/api.ts first (undefined assignment), then src/db.ts (object possibly undefined).",
		),
	);
	msgs.push(userAck());

	// Fixes (turns 7–16)
	for (let i = 0; i < 5; i++) {
		const file = i < 3 ? "src/api.ts" : "src/db.ts";
		const id = `mtf${i}`;
		msgs.push(
			assistantTool("edit", id, {
				file_path: file,
				old_string: `// fix target ${i}`,
				new_string: `// fixed target ${i}`,
			}),
		);
		msgs.push(toolResult(id, "Edit applied."));
	}

	// Read and fix remaining files (turns 17–22)
	msgs.push(assistantTool("read", "mt17", { file_path: "src/cache.ts" }));
	msgs.push(toolResult("mt17", syntheticFile("src/cache.ts", 500)));

	msgs.push(assistantTool("read", "mt18", { file_path: "src/db.ts" }));
	msgs.push(toolResult("mt18", syntheticFile("src/db.ts", 600)));

	msgs.push(
		assistantTool("edit", "mt19", {
			file_path: "src/db.ts",
			old_string: "if (row) return row.value;",
			new_string: "if (row !== undefined) return row.value;",
		}),
	);
	msgs.push(toolResult("mt19", "Edit applied."));

	msgs.push(assistantTool("bash", "mt20", { command: "bun run typecheck" }));
	msgs.push(toolResult("mt20", "✓ No TypeScript errors"));

	// Testing and quality gates (turns 21–29)
	for (let i = 21; i <= 29; i++) {
		const id = `mtq${i}`;
		if (i === 21) {
			msgs.push(assistantTool("bash", id, { command: "bun test" }));
			msgs.push(toolResult(id, syntheticTestOutput(30, "all files")));
		} else if (i === 22) {
			msgs.push(assistantTool("bash", id, { command: "bun run lint" }));
			msgs.push(toolResult(id, "✓ No lint errors"));
		} else if (i < 29) {
			msgs.push(assistantTool("grep", id, { pattern: "any", glob: "src/**/*.ts" }));
			msgs.push(toolResult(id, "(no explicit any types found)"));
		} else {
			msgs.push(
				assistantTool("bash", id, {
					command: "bun test && bun run typecheck && bun run lint",
				}),
			);
			msgs.push(toolResult(id, "✓ 30 tests passed\n✓ No TypeScript errors\n✓ No lint errors"));
		}
	}

	// Turn 30: summary
	msgs.push(
		assistantText(
			"Fixed 2 strict null check errors in src/api.ts and src/db.ts. All 30 tests pass, typecheck and lint clean.",
		),
	);

	return msgs;
}

// ─── MEDIUM Scenario 3: 30 turns — add comprehensive test suite ───────────────

function buildMediumTestMessages(): Message[] {
	const msgs: Message[] = [];

	// Exploration (turns 1–4)
	msgs.push(assistantTool("glob", "mts1", { pattern: "src/**/*.ts" }));
	msgs.push(
		toolResult(
			"mts1",
			"src/auth.ts\nsrc/session.ts\nsrc/token.ts\nsrc/middleware.ts\nsrc/index.ts",
		),
	);

	msgs.push(assistantTool("glob", "mts2", { pattern: "src/**/*.test.ts" }));
	msgs.push(toolResult("mts2", "(no matches)"));

	msgs.push(assistantTool("read", "mts3", { file_path: "src/auth.ts" }));
	msgs.push(toolResult("mts3", syntheticFile("src/auth.ts", 500)));

	msgs.push(assistantTool("read", "mts4", { file_path: "src/token.ts" }));
	msgs.push(toolResult("mts4", syntheticFile("src/token.ts", 400)));

	// Plan (turn 5)
	msgs.push(
		assistantText(
			"No tests exist. I'll write test files for auth.ts, token.ts, session.ts, and middleware.ts following bun:test conventions.",
		),
	);
	msgs.push(userAck());

	// Write 4 test files and run them (turns 6–20)
	const testTargets = ["auth", "token", "session", "middleware"];
	for (let i = 0; i < testTargets.length; i++) {
		const name = testTargets[i];
		const writeId = `mtsw${i}`;
		msgs.push(
			assistantTool("write", writeId, {
				file_path: `src/${name}.test.ts`,
				content: `import { describe, expect, it } from "bun:test";\nimport * as mod from './${name}.ts';\ndescribe('${name}', () => {\n  it('exports expected functions', () => expect(typeof mod).toBe('object'));\n  it('handles valid input', () => expect(mod.fn${i}(1)).toBeDefined());\n  it('rejects invalid input', () => expect(() => mod.fn${i}(null as unknown as number)).toBeDefined());\n});`,
			}),
		);
		msgs.push(toolResult(writeId, `File written: src/${name}.test.ts`));

		const runId = `mtsr${i}`;
		msgs.push(assistantTool("bash", runId, { command: `bun test src/${name}.test.ts` }));
		msgs.push(toolResult(runId, syntheticTestOutput(3, `src/${name}.test.ts`)));
	}

	// Read remaining files and add tests (turns 21–27)
	msgs.push(assistantTool("read", "mts21", { file_path: "src/session.ts" }));
	msgs.push(toolResult("mts21", syntheticFile("src/session.ts", 450)));

	msgs.push(assistantTool("read", "mts22", { file_path: "src/middleware.ts" }));
	msgs.push(toolResult("mts22", syntheticFile("src/middleware.ts", 380)));

	msgs.push(assistantTool("bash", "mts23", { command: "bun test" }));
	msgs.push(toolResult("mts23", syntheticTestOutput(12, "all files")));

	msgs.push(assistantTool("bash", "mts24", { command: "bun run typecheck" }));
	msgs.push(toolResult("mts24", "✓ No TypeScript errors"));

	msgs.push(assistantTool("bash", "mts25", { command: "bun run lint" }));
	msgs.push(toolResult("mts25", "✓ No lint errors"));

	msgs.push(assistantTool("bash", "mts26", { command: "bun test --coverage" }));
	msgs.push(toolResult("mts26", "Coverage: 84% lines, 78% branches\n✓ 12 tests passed"));

	// Turn 30: summary
	msgs.push(
		assistantText(
			"Added 12 tests across 4 new test files (auth, token, session, middleware). 84% line coverage, 78% branch coverage. All tests pass, typecheck and lint clean.",
		),
	);

	return msgs;
}

// ─── MEDIUM Scenario 4: 30 turns — fix lint errors across codebase ───────────

function buildMediumLintMessages(): Message[] {
	const msgs: Message[] = [];

	// Turn 1: run lint to see errors
	msgs.push(assistantTool("bash", "ml1", { command: "bun run lint" }));
	msgs.push(
		toolResult(
			"ml1",
			`src/core/engine.ts:45 noExplicitAny: Unexpected any. Use unknown.
src/core/engine.ts:67 noExplicitAny: Unexpected any. Use unknown.
src/utils/helpers.ts:12 noExplicitAny: Unexpected any. Use unknown.
src/api/handler.ts:23 noExplicitAny: Unexpected any. Use unknown.
src/api/handler.ts:34 noExplicitAny: Unexpected any. Use unknown.
5 errors found`,
			true,
		),
	);

	// Read files (turns 2–5)
	const lintFiles = ["src/core/engine.ts", "src/utils/helpers.ts", "src/api/handler.ts"];
	for (let i = 0; i < lintFiles.length; i++) {
		msgs.push(assistantTool("read", `mlr${i}`, { file_path: lintFiles[i] }));
		msgs.push(toolResult(`mlr${i}`, syntheticFile(lintFiles[i] as string, 500)));
	}

	// Plan (turn 5)
	msgs.push(
		assistantText(
			"5 noExplicitAny errors. I'll replace each `any` with the correct narrow type or `unknown` + narrowing.",
		),
	);
	msgs.push(userAck());

	// Fix 5 errors (turns 6–15)
	const fixes = [
		{ file: "src/core/engine.ts", old: "any", line: "45" },
		{ file: "src/core/engine.ts", old: "any", line: "67" },
		{ file: "src/utils/helpers.ts", old: "any", line: "12" },
		{ file: "src/api/handler.ts", old: "any", line: "23" },
		{ file: "src/api/handler.ts", old: "any", line: "34" },
	];
	for (let i = 0; i < fixes.length; i++) {
		const f = fixes[i] as (typeof fixes)[number];
		msgs.push(
			assistantTool("edit", `mle${i}`, {
				file_path: f.file,
				old_string: `/* line ${f.line} */ any`,
				new_string: `/* line ${f.line} */ unknown`,
			}),
		);
		msgs.push(toolResult(`mle${i}`, "Edit applied."));
		msgs.push(assistantTool("bash", `mlt${i}`, { command: `bun run lint ${f.file}` }));
		msgs.push(toolResult(`mlt${i}`, "✓ No lint errors"));
	}

	// Final quality gates (turns 16–29)
	msgs.push(assistantTool("bash", "mlq1", { command: "bun run lint" }));
	msgs.push(toolResult("mlq1", "✓ No lint errors"));

	msgs.push(assistantTool("bash", "mlq2", { command: "bun run typecheck" }));
	msgs.push(toolResult("mlq2", "✓ No TypeScript errors"));

	msgs.push(assistantTool("bash", "mlq3", { command: "bun test" }));
	msgs.push(toolResult("mlq3", syntheticTestOutput(20, "all files")));

	for (let i = 4; i <= 14; i++) {
		msgs.push(assistantTool("grep", `mlg${i}`, { pattern: ": any", glob: "src/**/*.ts" }));
		msgs.push(toolResult(`mlg${i}`, "(no explicit any types found)"));
	}

	// Turn 30: summary
	msgs.push(
		assistantText(
			"Fixed 5 noExplicitAny lint errors across 3 files. All 20 tests pass, typecheck and lint clean.",
		),
	);

	return msgs;
}

// ─── MEDIUM Scenario 5: 30 turns — debug a complex async bug ─────────────────

function buildMediumDebugMessages(): Message[] {
	const msgs: Message[] = [];

	// Turn 1: run failing tests
	msgs.push(assistantTool("bash", "md1", { command: "bun test src/queue/" }));
	msgs.push(
		toolResult(
			"md1",
			`bun test src/queue/
  ✓ enqueue adds item (5ms)
  ✗ FAILED: dequeue returns items in order
    Expected: ["a","b","c"]
    Received: ["a","c","b"]
  ✓ queue length tracks correctly (3ms)
2 of 3 tests failed`,
			true,
		),
	);

	// Reads (turns 2–6)
	msgs.push(assistantTool("read", "md2", { file_path: "src/queue/queue.ts" }));
	msgs.push(toolResult("md2", syntheticFile("src/queue/queue.ts", 600)));

	msgs.push(assistantTool("read", "md3", { file_path: "src/queue/queue.test.ts" }));
	msgs.push(
		toolResult(
			"md3",
			`it('dequeue returns items in order', async () => {
  const q = new Queue();
  await q.enqueue('a'); await q.enqueue('b'); await q.enqueue('c');
  const result = await Promise.all([q.dequeue(), q.dequeue(), q.dequeue()]);
  expect(result).toEqual(['a','b','c']);
});`,
		),
	);

	msgs.push(assistantTool("read", "md4", { file_path: "src/queue/worker.ts" }));
	msgs.push(toolResult("md4", syntheticFile("src/queue/worker.ts", 450)));

	msgs.push(
		assistantText(
			"The test uses Promise.all for three concurrent dequeues. The queue implementation doesn't serialize concurrent reads. I need to add a mutex/lock.",
		),
	);
	msgs.push(userAck());

	// Fix (turns 6–14)
	msgs.push(
		assistantTool("write", "md6", {
			file_path: "src/queue/mutex.ts",
			content: `export class Mutex {
  private queue: Array<() => void> = [];
  private locked = false;
  async acquire(): Promise<void> {
    if (!this.locked) { this.locked = true; return; }
    return new Promise(resolve => this.queue.push(resolve));
  }
  release(): void {
    const next = this.queue.shift();
    if (next) { next(); } else { this.locked = false; }
  }
}`,
		}),
	);
	msgs.push(toolResult("md6", "File written: src/queue/mutex.ts"));

	msgs.push(
		assistantTool("edit", "md7", {
			file_path: "src/queue/queue.ts",
			old_string: "import { Worker } from './worker.ts';",
			new_string: "import { Worker } from './worker.ts';\nimport { Mutex } from './mutex.ts';",
		}),
	);
	msgs.push(toolResult("md7", "Edit applied."));

	// More fixes and tests (turns 8–29)
	for (let i = 8; i <= 23; i++) {
		const id = `mdf${i}`;
		if (i % 4 === 0) {
			msgs.push(assistantTool("bash", id, { command: "bun test src/queue/" }));
			msgs.push(toolResult(id, syntheticTestOutput(3, "src/queue/")));
		} else if (i % 4 === 1) {
			msgs.push(assistantTool("read", id, { file_path: "src/queue/queue.ts" }));
			msgs.push(toolResult(id, syntheticFile("src/queue/queue.ts", 300)));
		} else if (i % 4 === 2) {
			msgs.push(assistantTool("grep", id, { pattern: "mutex", glob: "src/queue/**/*.ts" }));
			msgs.push(toolResult(id, "src/queue/queue.ts:3: import { Mutex }"));
		} else {
			msgs.push(assistantTool("bash", id, { command: "bun run typecheck" }));
			msgs.push(toolResult(id, "✓ No TypeScript errors"));
		}
	}

	msgs.push(assistantTool("bash", "mdfinal1", { command: "bun test && bun run lint" }));
	msgs.push(toolResult("mdfinal1", "✓ 15 tests passed\n✓ No lint errors"));

	msgs.push(assistantTool("bash", "mdfinal2", { command: "bun run typecheck" }));
	msgs.push(toolResult("mdfinal2", "✓ No TypeScript errors"));

	// Turn 30: summary
	msgs.push(
		assistantText(
			"Fixed concurrent dequeue race condition by adding a Mutex. Created src/queue/mutex.ts and wired it into the Queue class. All 15 tests pass, typecheck and lint clean.",
		),
	);

	return msgs;
}

// ─── LONG Scenario 2: 100 turns — build comprehensive test suite ──────────────

function buildLongTestMessages(): Message[] {
	const msgs: Message[] = [];

	// Phase 1: Exploration (turns 1–5)
	msgs.push(assistantTool("glob", "lt1", { pattern: "src/**/*.ts" }));
	msgs.push(
		toolResult(
			"lt1",
			Array.from({ length: 15 }, (_, i) => `src/service${i + 1}.ts`).join("\n") +
				"\nsrc/index.ts\nsrc/types.ts",
		),
	);

	msgs.push(assistantTool("glob", "lt2", { pattern: "src/**/*.test.ts" }));
	msgs.push(toolResult("lt2", "(no matches)"));

	msgs.push(assistantTool("read", "lt3", { file_path: "src/types.ts" }));
	msgs.push(toolResult("lt3", syntheticFile("src/types.ts", 500)));

	msgs.push(assistantTool("read", "lt4", { file_path: "src/index.ts" }));
	msgs.push(toolResult("lt4", syntheticFile("src/index.ts", 400)));

	// Turn 5: plan
	msgs.push(
		assistantText(
			"15 services, no tests. Plan: read each service, write a test file for each, run in batches.",
		),
	);
	msgs.push(userAck());

	// Phase 2: Read all 15 services (turns 6–20)
	for (let i = 0; i < 15; i++) {
		const file = `src/service${i + 1}.ts`;
		msgs.push(assistantTool("read", `ltr${i}`, { file_path: file }));
		msgs.push(toolResult(`ltr${i}`, syntheticFile(file, 600)));
	}

	// Turn 21: checkpoint
	msgs.push(
		assistantText("Read all 15 services. Each exports 2-3 async functions. Writing tests now."),
	);
	msgs.push(userAck());

	// Phase 3: Write test files (turns 22–36)
	for (let i = 0; i < 15; i++) {
		const file = `src/service${i + 1}.test.ts`;
		msgs.push(
			assistantTool("write", `ltw${i}`, {
				file_path: file,
				content: `import { describe, expect, it } from "bun:test";\nimport * as svc from './service${i + 1}.ts';\ndescribe('service${i + 1}', () => {\n  it('fn${i}a', async () => expect(await svc.fn${i}a(${i})).toBeDefined());\n  it('fn${i}b', async () => expect(await svc.fn${i}b(${i})).toBeDefined());\n});`,
			}),
		);
		msgs.push(toolResult(`ltw${i}`, `File written: ${file}`));
	}

	// Phase 4: Run tests in batches (turns 37–51)
	for (let batch = 0; batch < 5; batch++) {
		const start = batch * 3 + 1;
		const end = Math.min(start + 2, 15);
		const files = Array.from(
			{ length: end - start + 1 },
			(_, i) => `src/service${start + i}.test.ts`,
		).join(" ");
		msgs.push(assistantTool("bash", `ltb${batch}`, { command: `bun test ${files}` }));
		msgs.push(toolResult(`ltb${batch}`, syntheticTestOutput((end - start + 1) * 2, files)));
	}

	// Phase 5: Fix a test failure (turns 52–58)
	msgs.push(assistantTool("bash", "ltf1", { command: "bun test src/service8.test.ts" }));
	msgs.push(toolResult("ltf1", "✗ FAILED: fn7b\n  TypeError: fn7b is not a function", true));

	msgs.push(assistantTool("read", "ltf2", { file_path: "src/service8.ts" }));
	msgs.push(
		toolResult(
			"ltf2",
			`export async function fn7a(x: number): Promise<number> { return x * 8; }\nexport async function fn7c(x: number): Promise<number> { return x + 8; }`,
		),
	);

	msgs.push(
		assistantTool("edit", "ltf3", {
			file_path: "src/service8.test.ts",
			old_string: "svc.fn7b",
			new_string: "svc.fn7c",
		}),
	);
	msgs.push(toolResult("ltf3", "Edit applied."));

	msgs.push(assistantTool("bash", "ltf4", { command: "bun test src/service8.test.ts" }));
	msgs.push(toolResult("ltf4", syntheticTestOutput(2, "src/service8.test.ts")));

	// Phase 6: Full suite + quality gates (turns 59–72)
	msgs.push(assistantTool("bash", "ltq1", { command: "bun test" }));
	msgs.push(toolResult("ltq1", syntheticTestOutput(30, "all files")));

	msgs.push(assistantTool("bash", "ltq2", { command: "bun run typecheck" }));
	msgs.push(toolResult("ltq2", "✓ No TypeScript errors"));

	msgs.push(assistantTool("bash", "ltq3", { command: "bun run lint" }));
	msgs.push(toolResult("ltq3", "✓ No lint errors"));

	// Phase 7: Coverage verification sweep (turns 63–99)
	for (let i = 1; i <= 15; i++) {
		msgs.push(
			assistantTool("grep", `ltcov${i}`, {
				pattern: `service${i}`,
				glob: "src/**/*.test.ts",
			}),
		);
		msgs.push(
			toolResult(`ltcov${i}`, `src/service${i}.test.ts:1: import * as svc from './service${i}.ts'`),
		);
	}

	// Spot-check additional assertions for services 1–5
	for (let i = 1; i <= 6; i++) {
		msgs.push(
			assistantTool("bash", `ltcheck${i}`, { command: `bun test src/service${i}.test.ts` }),
		);
		msgs.push(toolResult(`ltcheck${i}`, syntheticTestOutput(2, `src/service${i}.test.ts`)));
	}

	// Turn 100: final summary
	msgs.push(
		assistantText(
			`Test suite complete. Created 15 test files:\n- src/service1.test.ts – src/service15.test.ts\n- 30 tests total (2 per service)\n- Fixed service8.test.ts: fn7b → fn7c\n- All 30 tests pass, typecheck and lint clean.`,
		),
	);

	return msgs;
}

// ─── LONG Scenario 3: 100 turns — add multi-file feature ─────────────────────

function buildLongFeatureMessages(): Message[] {
	const msgs: Message[] = [];

	// Phase 1: Exploration (turns 1–4)
	msgs.push(assistantTool("glob", "lf1", { pattern: "src/**/*.ts" }));
	msgs.push(
		toolResult(
			"lf1",
			"src/core.ts\nsrc/store.ts\nsrc/query.ts\nsrc/types.ts\nsrc/index.ts\n" +
				Array.from({ length: 12 }, (_, i) => `src/plugins/plugin${i + 1}.ts`).join("\n"),
		),
	);

	msgs.push(assistantTool("read", "lf2", { file_path: "src/types.ts" }));
	msgs.push(toolResult("lf2", syntheticFile("src/types.ts", 700)));

	msgs.push(assistantTool("read", "lf3", { file_path: "src/core.ts" }));
	msgs.push(toolResult("lf3", syntheticFile("src/core.ts", 800)));

	// Turn 4: plan
	msgs.push(
		assistantText(
			"Adding a plugin caching layer. Plan: (1) extend types, (2) implement cache.ts, (3) integrate with core.ts, (4) update each plugin, (5) tests.",
		),
	);
	msgs.push(userAck());

	// Phase 2: Extend types (turns 5–6)
	msgs.push(
		assistantTool("edit", "lf5", {
			file_path: "src/types.ts",
			old_string: "// plugin types",
			new_string:
				"// plugin types\nexport interface PluginCache { get(key: string): unknown; set(key: string, val: unknown): void; }",
		}),
	);
	msgs.push(toolResult("lf5", "Edit applied."));

	// Phase 3: Implement cache.ts (turn 6)
	msgs.push(
		assistantTool("write", "lf6", {
			file_path: "src/cache.ts",
			content: `import type { PluginCache } from './types.ts';\nexport class PluginCacheImpl implements PluginCache {\n  private store = new Map<string, unknown>();\n  get(key: string): unknown { return this.store.get(key); }\n  set(key: string, val: unknown): void { this.store.set(key, val); }\n  has(key: string): boolean { return this.store.has(key); }\n  clear(): void { this.store.clear(); }\n}`,
		}),
	);
	msgs.push(toolResult("lf6", "File written: src/cache.ts"));

	// Phase 4: Read and update each plugin (turns 7–42, 12 plugins × 3 ops each)
	for (let i = 0; i < 12; i++) {
		const file = `src/plugins/plugin${i + 1}.ts`;
		msgs.push(assistantTool("read", `lfr${i}`, { file_path: file }));
		msgs.push(toolResult(`lfr${i}`, syntheticFile(file, 500)));

		msgs.push(
			assistantTool("edit", `lfe${i}`, {
				file_path: file,
				old_string: `export function plugin${i + 1}`,
				new_string: `import type { PluginCache } from '../types.ts';\nexport function plugin${i + 1}`,
			}),
		);
		msgs.push(toolResult(`lfe${i}`, "Edit applied."));

		msgs.push(assistantTool("bash", `lfb${i}`, { command: `bun run typecheck ${file}` }));
		msgs.push(toolResult(`lfb${i}`, "✓ No TypeScript errors"));
	}

	// Phase 5: Update core.ts integration (turns 43–48)
	msgs.push(assistantTool("read", "lfci1", { file_path: "src/core.ts" }));
	msgs.push(toolResult("lfci1", syntheticFile("src/core.ts", 400)));

	msgs.push(
		assistantTool("edit", "lfci2", {
			file_path: "src/core.ts",
			old_string: "// plugin registry",
			new_string:
				"import { PluginCacheImpl } from './cache.ts';\n// plugin registry\nconst cache = new PluginCacheImpl();",
		}),
	);
	msgs.push(toolResult("lfci2", "Edit applied."));

	msgs.push(assistantTool("bash", "lfci3", { command: "bun run typecheck" }));
	msgs.push(toolResult("lfci3", "✓ No TypeScript errors"));

	// Phase 6: Write and run tests (turns 49–60)
	msgs.push(
		assistantTool("write", "lft1", {
			file_path: "src/cache.test.ts",
			content: `import { describe, expect, it } from "bun:test";\nimport { PluginCacheImpl } from './cache.ts';\ndescribe('PluginCacheImpl', () => {\n  it('stores and retrieves', () => {\n    const c = new PluginCacheImpl();\n    c.set('k', 42);\n    expect(c.get('k')).toBe(42);\n  });\n  it('has() returns false for missing', () => {\n    expect(new PluginCacheImpl().has('x')).toBe(false);\n  });\n  it('clear() empties cache', () => {\n    const c = new PluginCacheImpl();\n    c.set('k', 1);\n    c.clear();\n    expect(c.has('k')).toBe(false);\n  });\n});`,
		}),
	);
	msgs.push(toolResult("lft1", "File written: src/cache.test.ts"));

	msgs.push(assistantTool("bash", "lft2", { command: "bun test src/cache.test.ts" }));
	msgs.push(toolResult("lft2", syntheticTestOutput(3, "src/cache.test.ts")));

	msgs.push(assistantTool("bash", "lft3", { command: "bun test" }));
	msgs.push(toolResult("lft3", syntheticTestOutput(40, "all files")));

	msgs.push(assistantTool("bash", "lft4", { command: "bun run lint" }));
	msgs.push(toolResult("lft4", "✓ No lint errors"));

	// Phase 7: Verification sweep (turns 61–99)
	for (let i = 1; i <= 12; i++) {
		msgs.push(
			assistantTool("grep", `lfv${i}`, {
				pattern: "PluginCache",
				glob: `src/plugins/plugin${i}.ts`,
			}),
		);
		msgs.push(
			toolResult(
				`lfv${i}`,
				`src/plugins/plugin${i}.ts:1: import type { PluginCache } from '../types.ts'`,
			),
		);
	}

	for (let i = 1; i <= 6; i++) {
		msgs.push(assistantTool("bash", `lfcheck${i}`, { command: "bun run typecheck" }));
		msgs.push(toolResult(`lfcheck${i}`, "✓ No TypeScript errors"));

		msgs.push(assistantTool("bash", `lftest${i}`, { command: "bun test" }));
		msgs.push(toolResult(`lftest${i}`, syntheticTestOutput(40, "all files")));
	}

	msgs.push(
		assistantTool("bash", "lffinal", { command: "bun test && bun run typecheck && bun run lint" }),
	);
	msgs.push(toolResult("lffinal", "✓ 40 tests passed\n✓ No TypeScript errors\n✓ No lint errors"));

	// Turn 100: summary
	msgs.push(
		assistantText(
			"Added plugin caching layer:\n- src/types.ts: PluginCache interface\n- src/cache.ts: PluginCacheImpl with get/set/has/clear\n- src/cache.test.ts: 3 tests\n- All 12 plugins updated to import PluginCache\n- src/core.ts integrated with PluginCacheImpl\n- 40 total tests pass, typecheck and lint clean.",
		),
	);

	return msgs;
}

// ─── LONG Scenario 4: 100 turns — large-scale cleanup / dead code removal ─────

function buildLongCleanupMessages(): Message[] {
	const msgs: Message[] = [];

	// Phase 1: Discovery (turns 1–5)
	msgs.push(assistantTool("glob", "lc1", { pattern: "src/**/*.ts" }));
	msgs.push(
		toolResult(
			"lc1",
			Array.from({ length: 18 }, (_, i) => `src/legacy/mod${i + 1}.ts`).join("\n") +
				"\nsrc/index.ts\nsrc/types.ts",
		),
	);

	msgs.push(
		assistantTool("grep", "lc2", { pattern: "export function", glob: "src/legacy/**/*.ts" }),
	);
	msgs.push(
		toolResult(
			"lc2",
			Array.from(
				{ length: 18 },
				(_, i) => `src/legacy/mod${i + 1}.ts:1: export function legacyFn${i + 1}`,
			).join("\n"),
		),
	);

	msgs.push(assistantTool("grep", "lc3", { pattern: "legacyFn", glob: "src/**/*.ts" }));
	msgs.push(
		toolResult(
			"lc3",
			"src/index.ts:5: import { legacyFn1 } from './legacy/mod1.ts'\n(only legacyFn1 is used)",
		),
	);

	msgs.push(assistantTool("read", "lc4", { file_path: "src/index.ts" }));
	msgs.push(toolResult("lc4", syntheticFile("src/index.ts", 400)));

	// Turn 5: plan
	msgs.push(
		assistantText(
			"17 legacy functions are unused. Only legacyFn1 is still in use. I'll delete mods 2–18, update imports, run tests.",
		),
	);
	msgs.push(userAck());

	// Phase 2: Read each legacy module (turns 6–23)
	for (let i = 1; i <= 18; i++) {
		msgs.push(assistantTool("read", `lcr${i}`, { file_path: `src/legacy/mod${i}.ts` }));
		msgs.push(toolResult(`lcr${i}`, syntheticFile(`src/legacy/mod${i}.ts`, 300)));
	}

	// Phase 3: Delete unused modules 2–18 (turns 24–40)
	for (let i = 2; i <= 18; i++) {
		msgs.push(
			assistantTool("bash", `lcdel${i}`, {
				command: `rm src/legacy/mod${i}.ts`,
			}),
		);
		msgs.push(toolResult(`lcdel${i}`, `Deleted src/legacy/mod${i}.ts`));
	}

	// Phase 4: Update index.ts (turns 41–45)
	msgs.push(
		assistantTool("grep", "lcgi1", {
			pattern: "import.*legacy",
			glob: "src/**/*.ts",
		}),
	);
	msgs.push(toolResult("lcgi1", "src/index.ts:5: import { legacyFn1 } from './legacy/mod1.ts'"));

	msgs.push(assistantTool("bash", "lcq1", { command: "bun run typecheck" }));
	msgs.push(toolResult("lcq1", "✓ No TypeScript errors"));

	msgs.push(assistantTool("bash", "lcq2", { command: "bun test" }));
	msgs.push(toolResult("lcq2", syntheticTestOutput(25, "all files")));

	msgs.push(assistantTool("bash", "lcq3", { command: "bun run lint" }));
	msgs.push(toolResult("lcq3", "✓ No lint errors"));

	// Phase 5: Verification sweep (turns 46–99)
	// Verify no references to deleted modules remain
	for (let i = 2; i <= 18; i++) {
		msgs.push(
			assistantTool("grep", `lcv${i}`, {
				pattern: `mod${i}`,
				glob: "src/**/*.ts",
			}),
		);
		msgs.push(toolResult(`lcv${i}`, "(no matches)"));
	}

	// Additional quality passes
	for (let i = 1; i <= 10; i++) {
		msgs.push(assistantTool("bash", `lce${i}`, { command: "bun run typecheck" }));
		msgs.push(toolResult(`lce${i}`, "✓ No TypeScript errors"));
	}

	msgs.push(
		assistantTool("bash", "lcfinal", {
			command: "bun test && bun run typecheck && bun run lint",
		}),
	);
	msgs.push(toolResult("lcfinal", "✓ 25 tests passed\n✓ No TypeScript errors\n✓ No lint errors"));

	// Turn 100: summary
	msgs.push(
		assistantText(
			"Deleted 17 unused legacy modules (mod2–mod18). Kept mod1 (legacyFn1 is still in use). All 25 tests pass, typecheck and lint clean.",
		),
	);

	return msgs;
}

// ─── MEDIUM Scenario 6: 30 turns — config system refactor ────────────────────

function buildMediumConfigMessages(): Message[] {
	const msgs: Message[] = [];

	// Exploration (turns 1–6)
	msgs.push(assistantTool("glob", "mc1", { pattern: "src/config/**/*.ts" }));
	msgs.push(
		toolResult(
			"mc1",
			"src/config/defaults.ts\nsrc/config/loader.ts\nsrc/config/validator.ts\nsrc/config/types.ts",
		),
	);

	msgs.push(assistantTool("read", "mc2", { file_path: "src/config/types.ts" }));
	msgs.push(toolResult("mc2", syntheticFile("src/config/types.ts", 400)));

	msgs.push(assistantTool("read", "mc3", { file_path: "src/config/loader.ts" }));
	msgs.push(toolResult("mc3", syntheticFile("src/config/loader.ts", 600)));

	msgs.push(assistantTool("read", "mc4", { file_path: "src/config/defaults.ts" }));
	msgs.push(toolResult("mc4", syntheticFile("src/config/defaults.ts", 350)));

	msgs.push(assistantTool("read", "mc5", { file_path: "src/config/validator.ts" }));
	msgs.push(toolResult("mc5", syntheticFile("src/config/validator.ts", 450)));

	// Plan (turn 6)
	msgs.push(
		assistantText(
			"Refactoring config loader to be async and use a validated schema. Extending types first, then updating loader and validator.",
		),
	);
	msgs.push(userAck());

	// Refactor (turns 7–20)
	msgs.push(
		assistantTool("edit", "mc7", {
			file_path: "src/config/types.ts",
			old_string: "export interface Config {",
			new_string:
				"export interface ConfigSchema {\n  version: string;\n}\nexport interface Config extends ConfigSchema {",
		}),
	);
	msgs.push(toolResult("mc7", "Edit applied."));

	msgs.push(
		assistantTool("edit", "mc8", {
			file_path: "src/config/loader.ts",
			old_string: "export function loadConfig(",
			new_string: "export async function loadConfig(",
		}),
	);
	msgs.push(toolResult("mc8", "Edit applied."));

	for (let i = 9; i <= 20; i++) {
		const id = `mcc${i}`;
		if (i % 3 === 0) {
			msgs.push(assistantTool("bash", id, { command: "bun run typecheck" }));
			msgs.push(toolResult(id, "✓ No TypeScript errors"));
		} else if (i % 3 === 1) {
			msgs.push(assistantTool("bash", id, { command: "bun test src/config/" }));
			msgs.push(toolResult(id, syntheticTestOutput(8, "src/config/")));
		} else {
			msgs.push(assistantTool("grep", id, { pattern: "loadConfig", glob: "src/**/*.ts" }));
			msgs.push(toolResult(id, "src/index.ts:3: await loadConfig()"));
		}
	}

	// Update callers (turns 21–27)
	msgs.push(assistantTool("read", "mc21", { file_path: "src/index.ts" }));
	msgs.push(toolResult("mc21", syntheticFile("src/index.ts", 350)));

	msgs.push(
		assistantTool("edit", "mc22", {
			file_path: "src/index.ts",
			old_string: "const config = loadConfig(path);",
			new_string: "const config = await loadConfig(path);",
		}),
	);
	msgs.push(toolResult("mc22", "Edit applied."));

	msgs.push(assistantTool("bash", "mc23", { command: "bun run typecheck" }));
	msgs.push(toolResult("mc23", "✓ No TypeScript errors"));

	msgs.push(assistantTool("bash", "mc24", { command: "bun run lint" }));
	msgs.push(toolResult("mc24", "✓ No lint errors"));

	msgs.push(assistantTool("bash", "mc25", { command: "bun test" }));
	msgs.push(toolResult("mc25", syntheticTestOutput(20, "all files")));

	msgs.push(assistantTool("bash", "mc26", { command: "bun run typecheck" }));
	msgs.push(toolResult("mc26", "✓ No TypeScript errors"));

	msgs.push(assistantTool("bash", "mc27", { command: "bun test && bun run lint" }));
	msgs.push(toolResult("mc27", "✓ 20 tests passed\n✓ No lint errors"));

	// Turn 30: summary
	msgs.push(
		assistantText(
			"Config system refactored: loadConfig() is now async, types extended with ConfigSchema. Updated index.ts caller. All 20 tests pass, typecheck and lint clean.",
		),
	);

	return msgs;
}

// ─── LONG Scenario 5: 100 turns — API v2 migration ───────────────────────────

function buildLongMigrationMessages(): Message[] {
	const msgs: Message[] = [];

	// Phase 1: Discovery (turns 1–4)
	msgs.push(assistantTool("glob", "lm1", { pattern: "src/api/v1/**/*.ts" }));
	msgs.push(
		toolResult(
			"lm1",
			Array.from({ length: 10 }, (_, i) => `src/api/v1/route${i + 1}.ts`).join("\n") +
				"\nsrc/api/v1/router.ts\nsrc/api/v1/types.ts",
		),
	);

	msgs.push(assistantTool("read", "lm2", { file_path: "src/api/v1/types.ts" }));
	msgs.push(toolResult("lm2", syntheticFile("src/api/v1/types.ts", 600)));

	msgs.push(assistantTool("read", "lm3", { file_path: "src/api/v1/router.ts" }));
	msgs.push(toolResult("lm3", syntheticFile("src/api/v1/router.ts", 700)));

	// Turn 4: plan
	msgs.push(
		assistantText(
			"Migrating 10 v1 routes to v2. Plan: (1) create v2 type definitions, (2) migrate each route, (3) update the router, (4) run tests.",
		),
	);
	msgs.push(userAck());

	// Phase 2: Create v2 types (turns 5–6)
	msgs.push(
		assistantTool("write", "lm5", {
			file_path: "src/api/v2/types.ts",
			content: `export interface V2Request { version: 2; body: Record<string, unknown>; }\nexport interface V2Response { version: 2; data: unknown; error?: string; }`,
		}),
	);
	msgs.push(toolResult("lm5", "File written: src/api/v2/types.ts"));

	// Phase 3: Read and migrate each v1 route (turns 6–45, 10 routes × 4 ops each)
	for (let i = 0; i < 10; i++) {
		const v1File = `src/api/v1/route${i + 1}.ts`;
		const v2File = `src/api/v2/route${i + 1}.ts`;

		msgs.push(assistantTool("read", `lmr${i}`, { file_path: v1File }));
		msgs.push(toolResult(`lmr${i}`, syntheticFile(v1File, 500)));

		msgs.push(
			assistantTool("write", `lmw${i}`, {
				file_path: v2File,
				content: `import type { V2Request, V2Response } from './types.ts';\nexport async function route${i + 1}(req: V2Request): Promise<V2Response> {\n  return { version: 2, data: { id: req.body.id, handler: 'route${i + 1}' } };\n}`,
			}),
		);
		msgs.push(toolResult(`lmw${i}`, `File written: ${v2File}`));

		msgs.push(assistantTool("bash", `lmtc${i}`, { command: `bun run typecheck ${v2File}` }));
		msgs.push(toolResult(`lmtc${i}`, "✓ No TypeScript errors"));

		msgs.push(
			assistantTool("bash", `lmtest${i}`, {
				command: `bun test src/api/v2/route${i + 1}.test.ts`,
			}),
		);
		// Create a synthetic test passing response for every other route, failure for one
		if (i === 5) {
			msgs.push(
				toolResult(
					`lmtest${i}`,
					"✗ FAILED: route6 returns version 2\n  Expected: 2, Received: undefined",
					true,
				),
			);
		} else {
			msgs.push(
				toolResult(`lmtest${i}`, syntheticTestOutput(2, `src/api/v2/route${i + 1}.test.ts`)),
			);
		}
	}

	// Phase 4: Fix the failing route (turns 46–50)
	msgs.push(assistantTool("read", "lmfix1", { file_path: "src/api/v2/route6.ts" }));
	msgs.push(
		toolResult(
			"lmfix1",
			`import type { V2Request, V2Response } from './types.ts';\nexport async function route6(req: V2Request): Promise<V2Response> {\n  return { version: 2 as const, data: { id: req.body.id } };\n}`,
		),
	);

	msgs.push(
		assistantTool("edit", "lmfix2", {
			file_path: "src/api/v2/route6.ts",
			old_string: "return { version: 2 as const",
			new_string: "return { version: 2",
		}),
	);
	msgs.push(toolResult("lmfix2", "Edit applied."));

	msgs.push(assistantTool("bash", "lmfix3", { command: "bun test src/api/v2/route6.test.ts" }));
	msgs.push(toolResult("lmfix3", syntheticTestOutput(2, "src/api/v2/route6.test.ts")));

	// Phase 5: Create v2 router and update integration (turns 51–56)
	msgs.push(
		assistantTool("write", "lmrouter", {
			file_path: "src/api/v2/router.ts",
			content:
				Array.from(
					{ length: 10 },
					(_, i) => `import { route${i + 1} } from './route${i + 1}.ts';`,
				).join("\n") +
				"\nexport const v2Routes = [" +
				Array.from({ length: 10 }, (_, i) => `route${i + 1}`).join(", ") +
				"];",
		}),
	);
	msgs.push(toolResult("lmrouter", "File written: src/api/v2/router.ts"));

	msgs.push(assistantTool("bash", "lmtc_router", { command: "bun run typecheck" }));
	msgs.push(toolResult("lmtc_router", "✓ No TypeScript errors"));

	msgs.push(assistantTool("bash", "lmtest_all", { command: "bun test src/api/v2/" }));
	msgs.push(toolResult("lmtest_all", syntheticTestOutput(20, "src/api/v2/")));

	msgs.push(assistantTool("bash", "lmlint", { command: "bun run lint" }));
	msgs.push(toolResult("lmlint", "✓ No lint errors"));

	// Phase 6: Verification sweep (turns 57–99)
	for (let i = 1; i <= 10; i++) {
		msgs.push(
			assistantTool("grep", `lmv${i}`, {
				pattern: "V2Request",
				glob: `src/api/v2/route${i}.ts`,
			}),
		);
		msgs.push(
			toolResult(`lmv${i}`, `src/api/v2/route${i}.ts:1: import type { V2Request, V2Response }`),
		);
	}

	for (let i = 1; i <= 10; i++) {
		msgs.push(
			assistantTool("bash", `lmcheck${i}`, { command: `bun test src/api/v2/route${i}.test.ts` }),
		);
		msgs.push(toolResult(`lmcheck${i}`, syntheticTestOutput(2, `src/api/v2/route${i}.test.ts`)));
	}

	msgs.push(
		assistantTool("bash", "lmfinal", {
			command: "bun test && bun run typecheck && bun run lint",
		}),
	);
	msgs.push(toolResult("lmfinal", "✓ 20 tests passed\n✓ No TypeScript errors\n✓ No lint errors"));

	// Turn 100: summary
	msgs.push(
		assistantText(
			"API v2 migration complete:\n- src/api/v2/types.ts: V2Request/V2Response interfaces\n- src/api/v2/route1.ts – route10.ts: migrated handlers\n- src/api/v2/router.ts: v2Routes registry\n- Fixed route6 type assertion bug\n- All 20 v2 tests pass, typecheck and lint clean.",
		),
	);

	return msgs;
}

// ─── Scenario Instances ───────────────────────────────────────────────────────

export const SHORT_SCENARIO: BenchmarkScenario = {
	id: "short-debug",
	name: "Short: debug failing test (10 turns)",
	description:
		"Agent reads a file, runs tests, finds a bug, fixes the regex validator, re-runs tests. 10 turns.",
	taskPrompt:
		"The test src/utils/validator.test.ts is failing. Find and fix the bug in the validator.",
	messages: buildShortMessages(),
	expectedReductionMin: 0.0, // short: no reduction expected
};

export const SHORT_GREP_SCENARIO: BenchmarkScenario = {
	id: "short-grep",
	name: "Short: grep-driven type fix (10 turns)",
	description:
		"Agent greps for parseConfig usage sites, reads 3 files, updates the type signature, runs typecheck and lint. 10 turns.",
	taskPrompt:
		"The parseConfig function in src/config/parser.ts needs a stricter input type. Update it and fix any callers.",
	messages: buildShortGrepMessages(),
	expectedReductionMin: 0.0,
};

export const SHORT_WRITE_SCENARIO: BenchmarkScenario = {
	id: "short-write",
	name: "Short: write new utility function (10 turns)",
	description:
		"Agent globs structure, reads index.ts, writes a slugify utility, adds it to the export, writes tests. 10 turns.",
	taskPrompt:
		"Add a slugify(text: string): string utility to src/utils/ that converts text to URL-friendly slugs.",
	messages: buildShortWriteMessages(),
	expectedReductionMin: 0.0,
};

export const MEDIUM_SCENARIO: BenchmarkScenario = {
	id: "medium-endpoint",
	name: "Medium: add API endpoint (30 turns)",
	description:
		"Agent explores the API codebase, adds a GET /api/tags endpoint, fixes a test issue, runs quality gates. 30 turns.",
	taskPrompt:
		"Add a GET /api/tags endpoint to src/api/ that returns all unique post tags sorted alphabetically. Include tests.",
	messages: buildMediumMessages(),
	expectedReductionMin: 0.05, // medium: modest reduction
};

export const MEDIUM_TYPES_SCENARIO: BenchmarkScenario = {
	id: "medium-types",
	name: "Medium: fix strict null checks (30 turns)",
	description:
		"Agent fixes 2 typecheck errors from strict null checks across src/api.ts and src/db.ts. 30 turns.",
	taskPrompt:
		"The project has 2 TypeScript strict null check errors. Find and fix them across src/api.ts and src/db.ts.",
	messages: buildMediumTypesMessages(),
	expectedReductionMin: 0.05,
};

export const MEDIUM_TEST_SCENARIO: BenchmarkScenario = {
	id: "medium-test",
	name: "Medium: add test suite (30 turns)",
	description:
		"Agent reads 4 untested modules and writes test files for each with bun:test. 30 turns.",
	taskPrompt:
		"The src/ directory has no tests. Add test files for auth.ts, token.ts, session.ts, and middleware.ts.",
	messages: buildMediumTestMessages(),
	expectedReductionMin: 0.05,
};

export const MEDIUM_LINT_SCENARIO: BenchmarkScenario = {
	id: "medium-lint",
	name: "Medium: fix lint errors (30 turns)",
	description:
		"Agent finds and fixes 5 noExplicitAny lint errors across 3 files, runs quality gates. 30 turns.",
	taskPrompt:
		"Fix all noExplicitAny lint errors in src/. Replace any with proper types or unknown with narrowing.",
	messages: buildMediumLintMessages(),
	expectedReductionMin: 0.05,
};

export const MEDIUM_DEBUG_SCENARIO: BenchmarkScenario = {
	id: "medium-debug",
	name: "Medium: debug async race condition (30 turns)",
	description:
		"Agent debugs a concurrent dequeue race condition in a queue implementation, adds a Mutex. 30 turns.",
	taskPrompt:
		"The queue test 'dequeue returns items in order' fails intermittently. Debug and fix the race condition.",
	messages: buildMediumDebugMessages(),
	expectedReductionMin: 0.05,
};

export const LONG_SCENARIO: BenchmarkScenario = {
	id: "long-refactor",
	name: "Long: refactor 20 modules (100 turns)",
	description:
		"Agent reads 20 module files, converts all functions to extend a shared BaseModule class, runs tests after each batch. Large file reads create pruning pressure. 100 turns.",
	taskPrompt:
		"Refactor all modules in src/ to extend a new BaseModule abstract class instead of exporting standalone functions.",
	messages: buildLongMessages(),
	expectedReductionMin: 0.3, // long: 30%+ reduction expected
};

export const LONG_TEST_SCENARIO: BenchmarkScenario = {
	id: "long-test",
	name: "Long: build test suite for 15 services (100 turns)",
	description:
		"Agent reads 15 service files, writes a test file for each, runs in batches, fixes one failure. 100 turns.",
	taskPrompt:
		"Write tests for all services in src/. Each service should have at least 2 test cases.",
	messages: buildLongTestMessages(),
	expectedReductionMin: 0.3,
};

export const LONG_FEATURE_SCENARIO: BenchmarkScenario = {
	id: "long-feature",
	name: "Long: add plugin caching layer (100 turns)",
	description:
		"Agent adds a PluginCache interface, implements PluginCacheImpl, updates 12 plugins, integrates with core.ts. 100 turns.",
	taskPrompt:
		"Add a plugin caching layer. Create src/cache.ts with PluginCacheImpl, update all plugins in src/plugins/ to import the PluginCache type, and integrate with src/core.ts.",
	messages: buildLongFeatureMessages(),
	expectedReductionMin: 0.3,
};

export const LONG_CLEANUP_SCENARIO: BenchmarkScenario = {
	id: "long-cleanup",
	name: "Long: remove 17 dead legacy modules (100 turns)",
	description:
		"Agent discovers 17 unused legacy modules via grep, deletes them, verifies no remaining references. 100 turns.",
	taskPrompt:
		"Remove all unused legacy modules from src/legacy/. Keep only those still referenced from src/index.ts.",
	messages: buildLongCleanupMessages(),
	expectedReductionMin: 0.3,
};

export const MEDIUM_CONFIG_SCENARIO: BenchmarkScenario = {
	id: "medium-config",
	name: "Medium: async config system refactor (30 turns)",
	description:
		"Agent refactors the config loader to be async, extends types with ConfigSchema, updates callers. 30 turns.",
	taskPrompt:
		"Refactor src/config/loader.ts to export an async loadConfig() function. Update types and all callers.",
	messages: buildMediumConfigMessages(),
	expectedReductionMin: 0.05,
};

export const LONG_MIGRATION_SCENARIO: BenchmarkScenario = {
	id: "long-migration",
	name: "Long: migrate API v1 → v2 (100 turns)",
	description:
		"Agent creates v2 type definitions, migrates 10 route handlers to the new API, creates v2 router. 100 turns.",
	taskPrompt:
		"Migrate all routes in src/api/v1/ to a new src/api/v2/ using V2Request/V2Response types.",
	messages: buildLongMigrationMessages(),
	expectedReductionMin: 0.3,
};

// ─── Registry ─────────────────────────────────────────────────────────────────

export const ALL_SCENARIOS: BenchmarkScenario[] = [
	SHORT_SCENARIO,
	SHORT_GREP_SCENARIO,
	SHORT_WRITE_SCENARIO,
	MEDIUM_SCENARIO,
	MEDIUM_TYPES_SCENARIO,
	MEDIUM_TEST_SCENARIO,
	MEDIUM_LINT_SCENARIO,
	MEDIUM_DEBUG_SCENARIO,
	LONG_SCENARIO,
	LONG_TEST_SCENARIO,
	LONG_FEATURE_SCENARIO,
	LONG_CLEANUP_SCENARIO,
	MEDIUM_CONFIG_SCENARIO,
	LONG_MIGRATION_SCENARIO,
];

export function getScenario(id: string): BenchmarkScenario | undefined {
	return ALL_SCENARIOS.find((s) => s.id === id);
}
