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

describe("doctor command", () => {
	test("doctor --json returns structured output", async () => {
		const { stdout } = await runCli(["doctor", "--json"]);
		const data = JSON.parse(stdout) as Record<string, unknown>;
		expect(data).toHaveProperty("checks");
		expect(data).toHaveProperty("summary");
		const checks = data.checks as Array<{ name: string; status: string; message: string }>;
		expect(Array.isArray(checks)).toBe(true);
		const names = checks.map((c) => c.name);
		expect(names).toContain("config");
		expect(names).toContain("backend-cc");
		expect(names).toContain("version");
	}, 15000);

	test("doctor outputs human-readable results", async () => {
		const { stdout } = await runCli(["doctor", "--verbose"]);
		expect(stdout).toContain("Sapling Doctor");
	}, 15000);

	test("doctor --help shows description", async () => {
		const { stdout } = await runCli(["doctor", "--help"]);
		expect(stdout).toContain("doctor");
		expect(stdout).toContain("--fix");
	});
});
