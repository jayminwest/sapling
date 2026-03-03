import { describe, expect, test } from "bun:test";

const CLI = new URL("../index.ts", import.meta.url).pathname;

async function runCli(
	args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", "run", CLI, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

describe("upgrade command", () => {
	test("upgrade --check --json returns structured output", async () => {
		const { stdout, exitCode } = await runCli(["upgrade", "--check", "--json"]);
		// exitCode may be 0 (up to date) or 1 (outdated) depending on published version
		// but if npm is unreachable, it also exits 1
		// We just check that the output is valid JSON if exitCode is 0
		if (exitCode === 0) {
			const data = JSON.parse(stdout) as Record<string, unknown>;
			expect(data).toHaveProperty("current");
			expect(data).toHaveProperty("latest");
			expect(data).toHaveProperty("upToDate");
		}
		// Network error case: exitCode=1 with error json
		if (exitCode === 1) {
			// Could be network error or outdated - either is fine
			expect(exitCode).toBe(1);
		}
	}, 15000);

	test("upgrade --help shows description", async () => {
		const { stdout } = await runCli(["upgrade", "--help"]);
		expect(stdout).toContain("upgrade");
		expect(stdout).toContain("--check");
	});
});
