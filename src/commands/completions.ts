/**
 * Shell completions command for sapling CLI.
 * Generates completion scripts for bash, zsh, and fish.
 */

import type { Command } from "commander";

const SUPPORTED_SHELLS = ["bash", "zsh", "fish"] as const;
type Shell = (typeof SUPPORTED_SHELLS)[number];

interface CmdInfo {
	name: string;
	description: string;
	options: { flags: string; description: string }[];
}

function collectCommands(program: Command): CmdInfo[] {
	const result: CmdInfo[] = [];
	for (const cmd of program.commands) {
		result.push({
			name: cmd.name(),
			description: cmd.description(),
			options: cmd.options.map((o) => ({
				flags: o.long ?? o.short ?? o.flags,
				description: o.description,
			})),
		});
	}
	return result;
}

function generateBash(program: Command): string {
	const cmds = collectCommands(program);
	const cmdNames = cmds.map((c) => c.name).join(" ");

	const subcaseBranches: string[] = [];
	for (const cmd of cmds) {
		if (cmd.options.length > 0) {
			const optFlags = cmd.options.map((o) => o.flags).join(" ");
			subcaseBranches.push(
				`        ${cmd.name})\n            COMPREPLY=( $(compgen -W "${optFlags}" -- "$cur") )\n            return 0\n            ;;`,
			);
		}
	}

	const caseBlock =
		subcaseBranches.length > 0
			? `    case "\${COMP_WORDS[1]}" in\n${subcaseBranches.join("\n")}\n    esac`
			: "";

	return `# bash completion for sp
_sp_completions() {
    local cur prev
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"

    if [[ \${COMP_CWORD} -eq 1 ]]; then
        COMPREPLY=( $(compgen -W "${cmdNames}" -- "$cur") )
        return 0
    fi

${caseBlock}
}

complete -F _sp_completions sp
complete -F _sp_completions sapling
`;
}

function generateZsh(program: Command): string {
	const cmds = collectCommands(program);

	const cmdDescLines = cmds.map(
		(c) => `        '${c.name}:${c.description.replace(/'/g, "'\\''")}'`,
	);

	const subcmdFunctions: string[] = [];
	for (const cmd of cmds) {
		const parts: string[] = [];
		for (const o of cmd.options) {
			parts.push(
				`        '${o.flags}[${o.description.replace(/'/g, "'\\''").replace(/\[/g, "\\[").replace(/\]/g, "\\]")}]'`,
			);
		}
		if (parts.length > 0) {
			subcmdFunctions.push(
				`    ${cmd.name})\n        _arguments -s \\\n${parts.join(" \\\n")}\n        ;;`,
			);
		}
	}

	const subcmdCase =
		subcmdFunctions.length > 0
			? `    case "$words[1]" in\n${subcmdFunctions.join("\n")}\n    esac`
			: "";

	return `#compdef sp sapling

_sp() {
    local -a commands
    commands=(
${cmdDescLines.join("\n")}
    )

    _arguments -s \\
        '1:command:_describe "command" commands' \\
        '*::arg:->args'

    case "$state" in
    args)
${subcmdCase}
        ;;
    esac
}

_sp "$@"
`;
}

function generateFish(program: Command): string {
	const cmds = collectCommands(program);
	const lines: string[] = ["# fish completions for sp / sapling"];

	lines.push("complete -c sp -f");
	lines.push("complete -c sapling -f");
	lines.push("");

	const cmdNames = cmds.map((c) => c.name);
	const noSubcmdCond = cmdNames.map((n) => `__fish_seen_subcommand_from ${n}`).join("; or ");

	for (const cmd of cmds) {
		const desc = cmd.description.replace(/'/g, "\\'");
		lines.push(`complete -c sp -n "not ${noSubcmdCond}" -a ${cmd.name} -d '${desc}'`);
		lines.push(`complete -c sapling -n "not ${noSubcmdCond}" -a ${cmd.name} -d '${desc}'`);
	}

	lines.push("");

	for (const cmd of cmds) {
		for (const o of cmd.options) {
			const flagStr = o.flags.replace(/^--?/, "");
			const longFlag = o.flags.startsWith("--") ? `-l ${flagStr}` : `-s ${flagStr}`;
			const desc = o.description.replace(/'/g, "\\'");
			lines.push(
				`complete -c sp -n "__fish_seen_subcommand_from ${cmd.name}" ${longFlag} -d '${desc}'`,
			);
			lines.push(
				`complete -c sapling -n "__fish_seen_subcommand_from ${cmd.name}" ${longFlag} -d '${desc}'`,
			);
		}
	}

	lines.push("");
	return lines.join("\n");
}

export function registerCompletionsCommand(program: Command): void {
	program
		.command("completions")
		.argument("<shell>", `Shell type (${SUPPORTED_SHELLS.join(", ")})`)
		.description("Output shell completion script")
		.action((shell: string) => {
			if (!SUPPORTED_SHELLS.includes(shell as Shell)) {
				process.stderr.write(
					`Unknown shell: ${shell}. Supported: ${SUPPORTED_SHELLS.join(", ")}\n`,
				);
				process.exitCode = 1;
				return;
			}
			switch (shell as Shell) {
				case "bash":
					process.stdout.write(generateBash(program));
					break;
				case "zsh":
					process.stdout.write(generateZsh(program));
					break;
				case "fish":
					process.stdout.write(generateFish(program));
					break;
			}
		});
}
