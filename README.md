# Sapling

[![npm](https://img.shields.io/npm/v/@os-eco/sapling-cli)](https://www.npmjs.com/package/@os-eco/sapling-cli)
[![CI](https://github.com/jayminwest/sapling/actions/workflows/ci.yml/badge.svg)](https://github.com/jayminwest/sapling/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Headless coding agent with proactive context management.

Sapling is a coding agent where context management is a first-class concern, not an afterthought. Between every LLM call, Sapling evaluates, prunes, and reshapes what the model sees — so it operates at maximum capacity for the entire task, not just the first 20 turns.

## Install

```bash
bun install -g @os-eco/sapling-cli
```

Requires [Bun](https://bun.sh) >= 1.0.

## Quick Start

```bash
# Run a task using Claude Code subscription billing
sp run "Add input validation to the login function in src/auth.ts"

# Use the Anthropic SDK backend (API billing)
sp run "Fix the failing test in src/utils.test.ts" --backend sdk

# Specify model and working directory
sp run "Refactor the auth module" --model claude-sonnet-4-6 --cwd /path/to/project

# Verbose mode (log context manager decisions)
sp run "Implement the caching layer" --verbose

# NDJSON event output
sp run "Add error handling" --json
```

## CLI Reference

```
sapling run <prompt>            Execute a task
  --model <name>                  Model to use (default: claude-sonnet-4-6)
  --cwd <path>                    Working directory (default: .)
  --backend <cc|pi|sdk>           LLM backend (default: cc)
  --system-prompt-file <path>     Custom system prompt
  --max-turns <n>                 Max turns (default: 200)
  --verbose                       Log context manager decisions
  --json                          NDJSON event output on stdout
  --timing                        Show elapsed time on stderr
  --quiet, -q                     Suppress non-essential output

sapling version                 Print version
  --json                          Output as JSON envelope

sapling completions <shell>     Generate shell completions (bash, zsh, fish)
sapling upgrade                 Upgrade to the latest version
  --check                         Check for updates without installing
sapling doctor                  Run environment health checks
```

## How It Works

### The Problem

Existing coding agents (Claude Code, Pi, Codex) treat context management as an afterthought. They run until ~90% of the context window is full, then panic-compact. By that point, the model has been reading through increasingly bloated context for dozens of turns, degrading quality and wasting tokens.

### The Solution

Sapling manages context continuously, like garbage collection in a managed runtime. After every turn:

1. **Measure** — Count tokens per category. Are we over budget?
2. **Score** — Rate each message's relevance to the current subtask
3. **Prune** — Truncate large results, summarize old turns, drop stale reads
4. **Archive** — Move pruned content to a compact working memory
5. **Reshape** — Rebuild the message array: task + archive + recent turns

The LLM never sees a bloated context. Every piece of information has earned its place.

### Architecture

```
sapling/
  src/
    index.ts              CLI entry point (Commander)
    cli.ts                Run command handler — wires client + tools + context → loop
    loop.ts               Agent turn loop (call → dispatch → prune → repeat)
    types.ts              Canonical types and interfaces
    errors.ts             Error hierarchy: SaplingError → ClientError, ToolError, ContextError, ConfigError
    config.ts             Config loader + env var support + validation
    json.ts               JSON parsing utilities
    test-helpers.ts       Shared test utilities (temp dirs, mock factories)
    commands/
      completions.ts      Shell completion script generator (bash, zsh, fish)
      upgrade.ts          Self-upgrade from npm
      doctor.ts           Environment health checks
      typo.ts             Levenshtein-based command suggestions
      version.ts          Shared version utilities
    client/
      cc.ts               Claude Code subprocess backend
      pi.ts               Pi multi-provider subprocess backend
      anthropic.ts        Anthropic SDK backend (optional dep, dynamic import)
      index.ts            Client factory
    tools/
      bash.ts             Shell command execution
      read.ts             File reading with line numbers
      write.ts            File creation/overwrite
      edit.ts             Exact string replacement
      grep.ts             Regex content search (ripgrep-style)
      glob.ts             File pattern matching
      index.ts            Tool registry + createDefaultRegistry()
    context/
      manager.ts          Pipeline orchestrator (SaplingContextManager)
      measure.ts          Token budget tracking (4 chars/token heuristic)
      score.ts            Relevance scoring (recency, file overlap, error, decision, size)
      prune.ts            Message truncation + summarization strategies
      archive.ts          Rolling work summary + file modification tracking
      reshape.ts          Message array reconstruction
    logging/              Structured JSON logging + color control
    bench/
      harness.ts          Deterministic context pipeline benchmarking
      scenarios.ts        14 predefined agent workload scenarios
  agents/
    builder.md            Builder persona — writes code, runs quality gates
    reviewer.md           Reviewer persona — reviews code, no edits
    scout.md              Scout persona — explores code, no edits
```

### LLM Backends

| Backend | Billing | Method |
|---------|---------|--------|
| `cc` (default) | Claude Code subscription | `claude -p` subprocess |
| `pi` | Provider-dependent | `pi` subprocess (JSONL events) |
| `sdk` | Anthropic API per-token | `@anthropic-ai/sdk` direct calls |

The SDK backend auto-detects when running inside a Claude Code session. The CC subprocess backend uses Claude Code as a structured-output endpoint — Sapling owns the agent loop, tools, and context management. CC just handles auth and billing. The Pi backend communicates via JSONL events with a `pi` subprocess, enabling multi-provider model access.

## Part of os-eco

Sapling is part of the [os-eco](https://github.com/jayminwest/os-eco) AI agent tooling ecosystem:

| Tool | Purpose |
|------|---------|
| [Mulch](https://github.com/jayminwest/mulch) | Structured expertise management |
| [Seeds](https://github.com/jayminwest/seeds) | Git-native issue tracking |
| [Canopy](https://github.com/jayminwest/canopy) | Prompt management & composition |
| [Overstory](https://github.com/jayminwest/overstory) | Multi-agent orchestration |
| **Sapling** | Headless coding agent |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SAPLING_MODEL` | `claude-sonnet-4-6` | Model to use |
| `SAPLING_BACKEND` | `cc` | LLM backend (`cc`, `pi`, or `sdk`) |
| `SAPLING_MAX_TURNS` | `200` | Maximum agent turns |
| `SAPLING_CONTEXT_WINDOW` | `200000` | Context window size in tokens |

## Development

```bash
git clone https://github.com/jayminwest/sapling.git
cd sapling
bun install
bun test                  # 354 tests across 26 files (1076 expect() calls)
bun run lint              # Biome linting
bun run typecheck         # TypeScript strict check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines.

## License

[MIT](LICENSE)
