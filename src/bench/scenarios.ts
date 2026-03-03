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

// ─── Registry ─────────────────────────────────────────────────────────────────

export const ALL_SCENARIOS: BenchmarkScenario[] = [SHORT_SCENARIO, MEDIUM_SCENARIO, LONG_SCENARIO];

export function getScenario(id: string): BenchmarkScenario | undefined {
	return ALL_SCENARIOS.find((s) => s.id === id);
}
