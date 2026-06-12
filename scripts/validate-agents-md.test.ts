import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	extractBacktickedPaths,
	extractBunRunScripts,
	extractFencedBashBlocks,
	stripShellComments,
	validate,
} from "./validate-agents-md.ts";

const TOOLKIT_ROOT = resolve(import.meta.dir, "..");

function makeFixture(): { root: string; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "validate-agents-md-"));
	const cleanup = () => rmSync(root, { recursive: true, force: true });
	return { root, cleanup };
}

function writeFileTree(root: string, files: Record<string, string>): void {
	for (const [rel, content] of Object.entries(files)) {
		const full = join(root, rel);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
}

function writePackageJson(root: string, scripts: Record<string, string>): void {
	writeFileSync(join(root, "package.json"), JSON.stringify({ scripts }));
}

describe("extraction helpers", () => {
	test("extractFencedBashBlocks captures bash/sh/shell fences and ignores others", () => {
		const md = [
			"prose",
			"```bash",
			"bun test",
			"```",
			"```sh",
			"echo hi",
			"```",
			"```ts",
			"const x = 1;",
			"```",
		].join("\n");
		const blocks = extractFencedBashBlocks(md);
		expect(blocks).toHaveLength(2);
		expect(blocks[0]).toContain("bun test");
		expect(blocks[1]).toContain("echo hi");
	});

	test("stripShellComments removes inline # comments", () => {
		const stripped = stripShellComments("bun test  # also runs `bun run lint`");
		expect(stripped).toContain("bun test");
		expect(stripped).not.toContain("bun run lint");
	});

	test("extractBunRunScripts captures colon-namespaced and hyphenated names", () => {
		const scripts = extractBunRunScripts([
			"bun run lint && bun run check:all && bun run validate:agents-md",
		]);
		expect(scripts.has("lint")).toBe(true);
		expect(scripts.has("check:all")).toBe(true);
		expect(scripts.has("validate:agents-md")).toBe(true);
	});

	test("extractBacktickedPaths skips non-path tokens", () => {
		const md =
			"see `src/server/types.ts` and `package.json`, npm pkg `@os-eco/burrow`, " +
			"placeholder `src/runs/...`, URL `https://example.com/foo.md`, " +
			"bare ext `.ts`, glob `src/**/*.ts`, code `foo()`";
		const paths = extractBacktickedPaths(md);
		expect(paths).toContain("src/server/types.ts");
		expect(paths).toContain("package.json");
		expect(paths).not.toContain("@os-eco/burrow");
		expect(paths.some((p) => p.endsWith("..."))).toBe(false);
		expect(paths.some((p) => p.startsWith("http"))).toBe(false);
		expect(paths).not.toContain(".ts");
		expect(paths.some((p) => p.includes("*"))).toBe(false);
		expect(paths.some((p) => p.includes("("))).toBe(false);
	});
});

describe("validate — synthetic pass", () => {
	test("returns no failures when scripts and paths resolve", () => {
		const { root, cleanup } = makeFixture();
		try {
			writePackageJson(root, { lint: "biome check .", test: "bun test" });
			writeFileTree(root, {
				"src/index.ts": "export const x = 1;\n",
				"AGENTS.md": [
					"# AGENTS",
					"",
					"```bash",
					"bun run lint",
					"bun run test",
					"```",
					"",
					"see `src/index.ts` and `package.json`",
					"",
				].join("\n"),
			});
			const result = validate({ repoRoot: root });
			expect(result.failures).toEqual([]);
			expect(result.checkedScripts.has("lint")).toBe(true);
			expect(result.checkedScripts.has("test")).toBe(true);
			expect(result.checkedPaths).toContain("src/index.ts");
		} finally {
			cleanup();
		}
	});
});

describe("validate — synthetic violation", () => {
	test("flags a bun run reference to a script not in package.json", () => {
		const { root, cleanup } = makeFixture();
		try {
			writePackageJson(root, { lint: "biome check ." });
			writeFileTree(root, {
				"AGENTS.md": "```bash\nbun run does-not-exist\n```\n",
			});
			const result = validate({ repoRoot: root });
			expect(result.failures).toHaveLength(1);
			expect(result.failures[0]?.kind).toBe("missing-script");
			expect(result.failures[0]?.detail).toContain("does-not-exist");
		} finally {
			cleanup();
		}
	});

	test("flags a backticked path that does not exist on disk", () => {
		const { root, cleanup } = makeFixture();
		try {
			writePackageJson(root, {});
			writeFileTree(root, {
				"AGENTS.md": "see `src/gone.ts` for details\n",
			});
			const result = validate({ repoRoot: root });
			expect(result.failures).toHaveLength(1);
			expect(result.failures[0]?.kind).toBe("missing-path");
			expect(result.failures[0]?.detail).toContain("src/gone.ts");
		} finally {
			cleanup();
		}
	});

	test("known-missing allowlist silences a missing-path failure", () => {
		const { root, cleanup } = makeFixture();
		try {
			writePackageJson(root, {});
			writeFileTree(root, {
				"AGENTS.md": "see `dist/output.js` for the built artifact\n",
			});
			const result = validate({
				repoRoot: root,
				knownMissingPaths: new Set(["dist/output.js"]),
			});
			expect(result.failures).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test("flags a missing AGENTS.md target file", () => {
		const { root, cleanup } = makeFixture();
		try {
			writePackageJson(root, {});
			const result = validate({ repoRoot: root });
			expect(result.failures).toHaveLength(1);
			expect(result.failures[0]?.kind).toBe("missing-doc");
		} finally {
			cleanup();
		}
	});

	test("flags BOTH a broken script AND a broken path in a single run", () => {
		const { root, cleanup } = makeFixture();
		try {
			writePackageJson(root, { lint: "biome check ." });
			writeFileTree(root, {
				"AGENTS.md": [
					"```bash",
					"bun run nonexistent",
					"```",
					"",
					"refer to `src/missing.ts`",
					"",
				].join("\n"),
			});
			const result = validate({ repoRoot: root });
			expect(result.failures.map((f) => f.kind).sort()).toEqual(["missing-path", "missing-script"]);
		} finally {
			cleanup();
		}
	});
});

describe("CLI integration", () => {
	test("CLI exits 0 on a passing fixture", async () => {
		const { root, cleanup } = makeFixture();
		try {
			writePackageJson(root, { lint: "biome check ." });
			writeFileTree(root, {
				"src/index.ts": "export const x = 1;\n",
				"AGENTS.md": "```bash\nbun run lint\n```\n\nsee `src/index.ts`\n",
			});
			const proc = Bun.spawn(
				[
					"bun",
					"run",
					resolve(TOOLKIT_ROOT, "scripts/validate-agents-md.ts"),
					"--repo-root",
					root,
					"--target",
					"AGENTS.md",
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const exitCode = await proc.exited;
			expect(exitCode).toBe(0);
		} finally {
			cleanup();
		}
	});

	test("CLI exits 1 when a referenced script is missing", async () => {
		const { root, cleanup } = makeFixture();
		try {
			writePackageJson(root, {});
			writeFileTree(root, {
				"AGENTS.md": "```bash\nbun run nope\n```\n",
			});
			const proc = Bun.spawn(
				[
					"bun",
					"run",
					resolve(TOOLKIT_ROOT, "scripts/validate-agents-md.ts"),
					"--repo-root",
					root,
					"--target",
					"AGENTS.md",
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const exitCode = await proc.exited;
			expect(exitCode).toBe(1);
		} finally {
			cleanup();
		}
	});
});
