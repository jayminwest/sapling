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
# Run a task
sp run "Add input validation to the login function in src/auth.ts"

# Use the SDK backend directly
sp run "Fix the failing test in src/utils.test.ts" --backend sdk

# Specify model and working directory
sp run "Refactor the auth module" --model MiniMax-M2.5 --cwd /path/to/project

# Verbose mode (log context manager decisions)
sp run "Implement the caching layer" --verbose

# NDJSON event output
sp run "Add error handling" --json
```

## CLI Reference

```
sapling run <prompt>            Execute a task
  --model <name>                  Model to use (default: MiniMax-M2.5)
  --cwd <path>                    Working directory (default: .)
  --backend <cc|pi|sdk>           LLM backend (default: sdk)
  --system-prompt-file <path>     Custom system prompt
  --max-turns <n>                 Max turns (default: 200)
  --verbose                       Log context manager decisions
  --json                          NDJSON event output on stdout
  --timing                        Show elapsed time on stderr
  --guards-file <path>            Path to guards config JSON file
  --mode <rpc>                    Execution mode: one-shot (default) or rpc
  --quiet, -q                     Suppress non-essential output

sapling auth set <provider>     Store API key for a provider (anthropic, minimax)
  --base-url <url>                Custom API base URL for the provider
sapling auth show               Show configured providers
sapling auth remove <provider>  Remove stored credentials

sapling init                   Scaffold .sapling/ project directory
sapling config get <key>       Get a config value
sapling config set <key> <val> Set a config value
sapling config list            List all config values
sapling config init            Create default config file

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

Sapling manages context continuously, like garbage collection in a managed runtime. The context pipeline processes every turn through five stages:

1. **Ingest** — Parse messages into paired Turn objects, extract metadata (files, errors, decisions)
2. **Evaluate** — Score each turn's relevance to the current subtask (0–1)
3. **Compact** — Summarize low-scoring turns, truncate large tool outputs
4. **Budget** — Allocate tokens across system/archive/history/current zones
5. **Render** — Assemble the final message array: task + archive + recent turns

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
    config.ts             Config loader (env vars + YAML cascade) + validation
    session.ts            Session history tracking (.sapling/session.jsonl)
    json.ts               JSON parsing utilities
    test-helpers.ts       Shared test utilities (temp dirs, mock factories)
    integration.test.ts   End-to-end tests (real API, gated behind SAPLING_INTEGRATION_TESTS=1)
    commands/
      auth.ts             API key management (set, show, remove providers)
      config.ts           Project/home YAML config management (get, set, list, init)
      init.ts             Scaffold .sapling/ project directory
      completions.ts      Shell completion script generator (bash, zsh, fish)
      upgrade.ts          Self-upgrade from npm
      doctor.ts           Environment health checks
      typo.ts             Levenshtein-based command suggestions
      version.ts          Shared version utilities
    client/
      cc.ts               Claude Code subprocess backend
      pi.ts               Pi multi-provider subprocess backend
      anthropic.ts        Anthropic SDK backend (optional dep, dynamic import, ANTHROPIC_BASE_URL support)
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
      v1/
        pipeline.ts       Pipeline orchestrator (SaplingPipelineV1)
        ingest.ts         Parse messages into paired Turn objects with metadata
        evaluate.ts       Score turns 0–1 with weighted signals
        compact.ts        Summarize low-scoring turns, truncate large outputs
        budget.ts         Token allocation across system/archive/history/current
        render.ts         Assemble final messages with archive + system prompt
        templates.ts      Template-based archive rendering
        types.ts          v1 type definitions (Turn, TurnMetadata, PipelineState)
    hooks/
      guards.ts           Guard evaluators (blockedTools, readOnly, pathBoundary, fileScope, blockedBashPatterns)
      manager.ts          HookManager — pre/post tool call guard hooks
      events.ts           NDJSON per-turn event emitter for --json mode
    rpc/
      channel.ts          JSON-RPC stdin line reader + dispatcher
      server.ts           RPC request handler (steer, followUp, abort)
      types.ts            RPC type definitions
      index.ts            Barrel export
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
| `sdk` (recommended) | Anthropic API per-token | `@anthropic-ai/sdk` direct calls |
| `cc` (deprecated) | Claude Code subscription | `claude -p` subprocess |
| `pi` (deprecated) | Provider-dependent | `pi` subprocess (JSONL events) |

The SDK backend is the recommended default and auto-detects when running inside a Claude Code session. Model aliases (`sonnet`, `opus`, `haiku`) resolve to full model IDs automatically. The CC and Pi subprocess backends are deprecated and emit warnings on use. Use `sp auth set anthropic` to store your API key persistently.

## Part of os-eco

Sapling is part of the [os-eco](https://github.com/jayminwest/os-eco) AI agent tooling ecosystem.

<p align="center">
  <img src="https://raw.githubusercontent.com/jayminwest/os-eco/main/branding/logo.png" alt="os-eco" width="444" />
</p>

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SAPLING_MODEL` | `MiniMax-M2.5` | Model to use |
| `SAPLING_BACKEND` | `sdk` | LLM backend (`cc`, `pi`, or `sdk`) |
| `SAPLING_MAX_TURNS` | `200` | Maximum agent turns |
| `SAPLING_CONTEXT_WINDOW` | `200000` | Context window size in tokens |
| `ANTHROPIC_BASE_URL` | — | Custom API base URL for compatible providers |
| `ANTHROPIC_AUTH_TOKEN` | — | Fallback for `ANTHROPIC_API_KEY` |

## Development

```bash
git clone https://github.com/jayminwest/sapling.git
cd sapling
bun install
bun test                  # 690 tests across 36 files (2619 expect() calls)
bun run lint              # Biome linting
bun run typecheck         # TypeScript strict check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines.

## License

[MIT](LICENSE)
