/**
 * Doctor command for sapling CLI.
 * Runs health checks on the sapling setup and environment.
 */

import type { Command } from "commander";
import { loadConfig } from "../config.ts";
import { printJson } from "../json.ts";
import { colors } from "../logging/color.ts";
import { compareSemver, getCurrentVersion, getLatestVersion } from "./version.ts";

interface DoctorCheck {
	name: string;
	status: "pass" | "warn" | "fail";
	message: string;
}

function checkConfig(): DoctorCheck {
	try {
		loadConfig();
		return { name: "config", status: "pass", message: "Configuration is valid" };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { name: "config", status: "fail", message: `Config error: ${msg}` };
	}
}

function checkBackendCc(): DoctorCheck {
	const result = Bun.spawnSync(["which", "claude"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode === 0) {
		return { name: "backend-cc", status: "pass", message: "'claude' CLI is available on PATH" };
	}
	return {
		name: "backend-cc",
		status: "warn",
		message: "'claude' CLI not found on PATH — cc backend unavailable",
	};
}

function checkVersion(): DoctorCheck {
	const current = getCurrentVersion();
	const latest = getLatestVersion();
	if (latest === null) {
		return {
			name: "version",
			status: "warn",
			message: `Version check skipped — unable to reach npm registry (current: v${current})`,
		};
	}
	const cmp = compareSemver(current, latest);
	if (cmp >= 0) {
		return {
			name: "version",
			status: "pass",
			message: `sapling is up to date (v${current})`,
		};
	}
	return {
		name: "version",
		status: "warn",
		message: `Update available: v${current} → v${latest}. Run 'sp upgrade' to install.`,
	};
}

function printHuman(checks: DoctorCheck[], verbose: boolean): void {
	process.stdout.write(`\n${colors.bold("Sapling Doctor")}\n\n`);
	for (const check of checks) {
		if (check.status === "pass" && !verbose) continue;
		const icon =
			check.status === "pass"
				? colors.green("✓")
				: check.status === "warn"
					? colors.yellow("!")
					: colors.red("✗");
		process.stdout.write(`  ${icon} ${check.message}\n`);
	}

	const pass = checks.filter((c) => c.status === "pass").length;
	const warn = checks.filter((c) => c.status === "warn").length;
	const fail = checks.filter((c) => c.status === "fail").length;
	process.stdout.write(
		`\n${colors.dim(`${String(pass)} passed, ${String(warn)} warning(s), ${String(fail)} failure(s)`)}\n`,
	);
}

export function registerDoctorCommand(program: Command): void {
	program
		.command("doctor")
		.description("Run health checks on sapling setup")
		.option("--fix", "Attempt to auto-fix issues")
		.option("--json", "Output as JSON")
		.option("--verbose", "Show all checks including passing ones")
		.action((opts: { fix?: boolean; json?: boolean; verbose?: boolean }) => {
			const jsonMode = opts.json ?? false;
			const verbose = opts.verbose ?? false;

			const checks: DoctorCheck[] = [checkConfig(), checkBackendCc(), checkVersion()];

			const hasFailures = checks.some((c) => c.status === "fail");

			if (jsonMode) {
				const pass = checks.filter((c) => c.status === "pass").length;
				const warn = checks.filter((c) => c.status === "warn").length;
				const fail = checks.filter((c) => c.status === "fail").length;
				printJson("doctor", { checks, summary: { pass, warn, fail } });
			} else {
				printHuman(checks, verbose);
			}

			if (hasFailures) {
				process.exitCode = 1;
			}
		});
}
