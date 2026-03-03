import { describe, expect, test } from "bun:test";

async function runCompletions(
	shell: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const CLI = new URL("../index.ts", import.meta.url).pathname;
	const proc = Bun.spawn(["bun", "run", CLI, "completions", shell], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

describe("completions command", () => {
	test("bash completion contains sp function", async () => {
		const { stdout, exitCode } = await runCompletions("bash");
		expect(exitCode).toBe(0);
		expect(stdout).toContain("_sp_completions");
		expect(stdout).toContain("complete -F _sp_completions sp");
	});

	test("zsh completion contains compdef sp", async () => {
		const { stdout, exitCode } = await runCompletions("zsh");
		expect(exitCode).toBe(0);
		expect(stdout).toContain("#compdef sp");
		expect(stdout).toContain("_sp()");
	});

	test("fish completion contains complete -c sp", async () => {
		const { stdout, exitCode } = await runCompletions("fish");
		expect(exitCode).toBe(0);
		expect(stdout).toContain("complete -c sp -f");
	});

	test("unknown shell exits with error", async () => {
		const { stderr, exitCode } = await runCompletions("powershell");
		expect(exitCode).toBe(1);
		expect(stderr).toContain("Unknown shell: powershell");
	});
});
