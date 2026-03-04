# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Sapling

Sapling (`@os-eco/sapling-cli`, CLI: `sp` / `sapling`) is a headless coding agent with proactive context management. Its core innovation is an inter-turn context pipeline that evaluates, prunes, and reshapes what the LLM sees between every turn. Part of the os-eco ecosystem (Mulch, Seeds, Canopy, Overstory).

## Build & Test Commands

All commands use **Bun** as the runtime. There is no build/compile step — TypeScript runs directly.

```bash
bun test                  # Run all 690 tests (36 files, 2619 expect() calls)
bun test src/loop.test.ts # Run a single test file
bun run lint              # Lint (Biome)
bun run lint:fix          # Lint + auto-fix
bun run typecheck         # TypeScript strict check (tsc --noEmit)
```

Quality gate before finishing work: `bun test && bun run lint && bun run typecheck`

## Architecture

### Entry flow

`src/index.ts` (Commander CLI) → `src/cli.ts` (`runCommand()`) → `src/loop.ts` (`runLoop()`)

`runCommand()` wires together: system prompt → LLM client → tool registry → context manager → agent loop.

### Agent loop (`src/loop.ts`)

Each turn: call LLM → if no tool calls, stop → execute all tool calls in parallel (`Promise.all`) → append results → run v1 context pipeline on message array → next turn. Stops on: task complete (no tools), max turns (200), or unrecoverable error. LLM errors use exponential backoff (3 retries, immediate abort on auth/model errors).

### LLM clients (`src/client/`)

Three backends implementing `LlmClient` from `src/types.ts`:
- **CcClient** (`cc.ts`, deprecated) — spawns `claude` subprocess with `--output-format json` and `--json-schema`, parses structured JSON response
- **PiClient** (`pi.ts`, deprecated) — spawns `pi` subprocess, communicates via JSONL events; supports multi-provider models
- **AnthropicClient** (`anthropic.ts`, recommended) — calls Anthropic SDK directly; `@anthropic-ai/sdk` is an optional dep, dynamically imported; supports `ANTHROPIC_BASE_URL` and model alias resolution

### Context pipeline (`src/context/v1/`)

Turn-based pipeline with `SaplingPipelineV1.process()`:
1. **Ingest** (`ingest.ts`) — parses messages into paired `Turn` objects, extracts metadata (files, errors, decisions, questions)
2. **Evaluate** (`evaluate.ts`) — scores turns 0–1 using weighted signals (recency, file overlap, error context, decisions, questions, size)
3. **Compact** (`compact.ts`) — summarizes low-scoring turns, truncates large tool outputs
4. **Budget** (`budget.ts`) — token allocation and enforcement across system/archive/history/current zones
5. **Render** (`render.ts`) — assembles final message array with archive and composed system prompt; ensures orphaned tool_use/tool_result pairs are never emitted

Types in `types.ts`, archive templates in `templates.ts`.

### Benchmarking (`src/bench/`)

Deterministic context pipeline benchmarking: `harness.ts` runs scenarios through the pipeline, `scenarios.ts` defines 14 predefined message sequences covering common agent workloads (SHORT/10 turns, MEDIUM/30 turns, LONG/100 turns).

### Hooks (`src/hooks/`)

Guard system and event emission: `guards.ts` evaluates five guard types (blockedTools, readOnly, pathBoundary, fileScope, blockedBashPatterns) on tool calls. `manager.ts` (`HookManager`) applies pre/post tool call hooks using guard config loaded via `--guards-file`. `events.ts` (`EventEmitter`) emits structured NDJSON per-turn events in `--json` mode.

### RPC (`src/rpc/`)

JSON-RPC stdin control channel for programmatic agent steering (`--mode rpc`). `channel.ts` reads NDJSON lines from stdin and dispatches to `server.ts`. Three methods: `steer` (inject context), `followUp` (queue task), `abort` (stop loop). Types in `types.ts`.

### Logging (`src/logging/`)

Structured logger (`logger.ts`) with JSON output support and color control (`color.ts`). All console output routed through the logger for `--json`/`--quiet` mode compatibility.

### CLI commands (`src/commands/`)

Subcommands registered from `src/index.ts`: `auth` (API key management in `~/.sapling/auth.json`), `config` (get/set/list/init project and home YAML configuration), `init` (scaffold `.sapling/` project directory), `completions` (shell completion scripts for bash/zsh/fish), `upgrade` (check/install latest version), `doctor` (health checks), `version` (shared version utilities). `typo.ts` provides Levenshtein-based command suggestions for unknown commands.

### Other source files

- `src/json.ts` — JSON envelope utilities (`{ success, command, ...data }` format)
- `src/session.ts` — Session history tracking (appends records to `.sapling/session.jsonl`)
- `src/test-helpers.ts` — Shared test helpers (temp dirs, mock client/tool factories)

### Tools (`src/tools/`)

Six tools registered via `createDefaultRegistry()`: `bash`, `read`, `write`, `edit`, `grep`, `glob`. All implement the `Tool` interface from `src/types.ts`.

### Agent personas (`agents/`)

Three system prompt files emitted by Canopy: **builder** (writes code), **reviewer** (reviews, no edits), **scout** (explores, no edits).

## Key Conventions

- **Canonical types** live in `src/types.ts`. Sub-module `types.ts` files re-export from `../types.ts`.
- **All imports use `.ts` extensions** — e.g., `import { foo } from "./bar.ts"`.
- **No `any` types** — Biome enforces `noExplicitAny: error`. Use `unknown` with narrowing.
- **Tabs for indentation**, 100-char line width (Biome).
- **Tests are colocated** — `src/foo.test.ts` next to `src/foo.ts`. Tests use real temp directories (helpers in `src/test-helpers.ts`).
- **Error hierarchy** in `src/errors.ts`: `SaplingError` base → `ClientError`, `ToolError`, `ContextError`, `ConfigError`.
- **Config** (`src/config.ts`) three-layer cascade: env vars → project YAML (`.sapling/config.yaml`) → home YAML (`~/.sapling/config.yaml`) → defaults. Env vars: `SAPLING_MODEL`, `SAPLING_BACKEND`, `SAPLING_MAX_TURNS`, `SAPLING_CONTEXT_WINDOW`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`. Falls back to `~/.sapling/auth.json` credentials. Model alias resolution (e.g., `sonnet` → `claude-sonnet-4-6`). Default model: `MiniMax-M2.5` via MiniMax's Anthropic-compatible API.
- **Agent prompt files in `agents/`** are emitted by Canopy — do not manually edit them. Use `cn update <name>` then `cn emit`.
- **JSONL data files** (`.mulch/`, `.seeds/`, `.canopy/`) use `merge=union` git strategy (see `.gitattributes`).

<!-- mulch:start -->
## Project Expertise (Mulch)
<!-- mulch-onboard-v:1 -->

This project uses [Mulch](https://github.com/jayminwest/mulch) for structured expertise management.

**At the start of every session**, run:
```bash
mulch prime
```

This injects project-specific conventions, patterns, decisions, and other learnings into your context.
Use `mulch prime --files src/foo.ts` to load only records relevant to specific files.

**Before completing your task**, review your work for insights worth preserving — conventions discovered,
patterns applied, failures encountered, or decisions made — and record them:
```bash
mulch record <domain> --type <convention|pattern|failure|decision|reference|guide> --description "..."
```

Link evidence when available: `--evidence-commit <sha>`, `--evidence-bead <id>`

Run `mulch status` to check domain health and entry counts.
Run `mulch --help` for full usage.
Mulch write commands use file locking and atomic writes — multiple agents can safely record to the same domain concurrently.

### Before You Finish

1. Discover what to record:
   ```bash
   mulch learn
   ```
2. Store insights from this work session:
   ```bash
   mulch record <domain> --type <convention|pattern|failure|decision|reference|guide> --description "..."
   ```
3. Validate and commit:
   ```bash
   mulch sync
   ```
<!-- mulch:end -->

<!-- seeds:start -->
## Issue Tracking (Seeds)
<!-- seeds-onboard-v:1 -->

This project uses [Seeds](https://github.com/jayminwest/seeds) for git-native issue tracking.

**At the start of every session**, run:
```
sd prime
```

This injects session context: rules, command reference, and workflows.

**Quick reference:**
- `sd ready` — Find unblocked work
- `sd create --title "..." --type task --priority 2` — Create issue
- `sd update <id> --status in_progress` — Claim work
- `sd close <id>` — Complete work
- `sd dep add <id> <depends-on>` — Add dependency between issues
- `sd sync` — Sync with git (run before pushing)

### Before You Finish
1. Close completed issues: `sd close <id>`
2. File issues for remaining work: `sd create --title "..."`
3. Sync and push: `sd sync && git push`
<!-- seeds:end -->

<!-- canopy:start -->
## Prompt Management (Canopy)
<!-- canopy-onboard-v:1 -->

This project uses [Canopy](https://github.com/jayminwest/canopy) for git-native prompt management.

**At the start of every session**, run:
```
cn prime
```

This injects prompt workflow context: commands, conventions, and common workflows.

**Quick reference:**
- `cn list` — List all prompts
- `cn render <name>` — View rendered prompt (resolves inheritance)
- `cn emit --all` — Render prompts to files
- `cn update <name>` — Update a prompt (creates new version)
- `cn sync` — Stage and commit .canopy/ changes

**Do not manually edit emitted files.** Use `cn update` to modify prompts, then `cn emit` to regenerate.
<!-- canopy:end -->
