/**
 * Upgrade command for sapling CLI.
 * Checks for and installs the latest version from npm.
 */

import type { Command } from "commander";
import { printJson, printJsonError } from "../json.ts";
import { colors } from "../logging/color.ts";
import { compareSemver, getCurrentVersion, getLatestVersion } from "./version.ts";

const PACKAGE_NAME = "@os-eco/sapling-cli";

export function registerUpgradeCommand(program: Command): void {
	program
		.command("upgrade")
		.description("Upgrade sapling to the latest version from npm")
		.option("--check", "Check for updates without installing")
		.option("--json", "Output as JSON")
		.action(async (opts: { check?: boolean; json?: boolean }) => {
			const jsonMode = opts.json ?? false;
			const checkOnly = opts.check ?? false;

			const latest = getLatestVersion();
			if (latest === null) {
				const msg = "Unable to reach npm registry. Check your internet connection.";
				if (jsonMode) {
					printJsonError("upgrade", msg);
				} else {
					process.stderr.write(`${colors.red("Error:")} ${msg}\n`);
				}
				process.exitCode = 1;
				return;
			}

			const current = getCurrentVersion();
			const upToDate = compareSemver(current, latest) >= 0;

			if (upToDate) {
				if (jsonMode) {
					printJson("upgrade", { current, latest, upToDate: true, updated: false });
				} else {
					process.stdout.write(`${colors.green("✓")} sapling is up to date (v${current})\n`);
				}
				return;
			}

			if (checkOnly) {
				if (jsonMode) {
					printJson("upgrade", { current, latest, upToDate: false, updated: false });
				} else {
					process.stdout.write(
						`${colors.yellow("!")} Update available: v${current} → v${latest}\n`,
					);
				}
				process.exitCode = 1;
				return;
			}

			if (!jsonMode) {
				process.stdout.write(`Upgrading ${PACKAGE_NAME} from v${current} to v${latest}...\n`);
			}

			const result = Bun.spawnSync(["bun", "install", "-g", `${PACKAGE_NAME}@latest`], {
				stdout: jsonMode ? "pipe" : "inherit",
				stderr: jsonMode ? "pipe" : "inherit",
			});

			if (result.exitCode !== 0) {
				const msg = `bun install failed with exit code ${String(result.exitCode)}`;
				if (jsonMode) {
					printJsonError("upgrade", msg);
				} else {
					process.stderr.write(`${colors.red("Error:")} ${msg}\n`);
				}
				process.exitCode = 1;
				return;
			}

			if (jsonMode) {
				printJson("upgrade", { current, latest, upToDate: false, updated: true });
			} else {
				process.stdout.write(`${colors.green("✓")} Upgraded sapling v${current} → v${latest}\n`);
			}
		});
}
