# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] - 2026-03-03

### Added

#### Pi Backend
- New `PiClient` (`src/client/pi.ts`) — multi-provider LLM backend that communicates via JSONL events with a `pi` subprocess
- `--backend pi` flag and `SAPLING_BACKEND=pi` env var support
- Full test coverage for PiClient (`src/client/pi.test.ts`)

#### New CLI Commands
- `sapling completions <bash|zsh|fish>` — generate shell completion scripts
- `sapling upgrade` — check for and install the latest version from npm (`--check` for dry run)
- `sapling doctor` — run health checks on the Sapling setup and environment
- Typo suggestions for unknown commands using Levenshtein distance

#### Branding & Color
- Brand color palette (forest green / amber / muted stone) in `src/logging/color.ts`
- Status icons (ecosystem Set D) and message helpers (`printSuccess`, `printError`, `printWarning`)
- Branded CLI help header with tool name and version

#### Output Improvements
- `--timing` flag on `run` command to display elapsed execution time on stderr
- `responseText` field added to `LoopResult` — final LLM text is now returned from the loop
- Final response text printed via stdout instead of logger, so `--quiet` doesn't suppress it
- JSON envelope redesigned: `{ success, command, ...data }` format replaces previous `{ name, version }` format

### Fixed

#### Tool Path Resolution
- `WriteTool`, `ReadTool`, and `EditTool` now resolve relative `file_path` against `cwd` instead of requiring absolute paths

#### Subprocess Reliability
- `BashTool` drains stdout/stderr concurrently with `proc.exited` to prevent pipe deadlocks
- `GrepTool` drains stdout/stderr concurrently to prevent pipe deadlocks
- `CcClient` subprocess timeout (120s default) prevents indefinite hangs on invalid model or stalled network

#### CC Backend
- Thinking text from CC backend suppressed from user-visible output (logged at debug level instead)
- `tool_result` blocks handled correctly in CC backend serializer
- `tool_result` blocks handled correctly in `estimateBlockTokens`

#### Config & Validation
- `NaN` and `Infinity` rejected for `maxTurns` and `contextWindow` in config validation
- Empty prompt, missing cwd, and missing system-prompt-file produce clean `SaplingError` messages instead of uncaught exceptions
- Env var overrides for config flags fixed

#### SDK Backend
- Client-side auth errors (missing API key) correctly classified as `SDK_AUTH_FAILED`

#### Other
- `version` command supports `--json` flag with standard JSON envelope
- `--version --json` flag combination handled before Commander parsing
- Fish completions fixed to use single `__fish_seen_subcommand_from` call

### Changed
- Test suite grown from 298 tests / 24 files / 959 expects to 354 tests / 26 files / 1076 expects
- `LlmBackend` type extended from `"cc" | "sdk"` to `"cc" | "pi" | "sdk"`
- JSON output envelope format changed from `{ name, version, ...data }` to `{ success, command, ...data }`
- Biome schema version updated for 2.4.5 compatibility

## [0.1.1] - 2026-03-02

### Added

#### Context Pipeline Enhancements
- File hash tracking (`fileHashes`) wired through the context manager for content-aware scoring
- Grep result summarization in the prune stage — large grep outputs are condensed instead of dropped
- Unresolved-question scoring signal — messages containing open questions score higher to stay in context

#### Benchmarking Harness
- New `src/bench/` module with deterministic context pipeline benchmarking
- Scenario-based test harness (`harness.ts`) with reproducible message sequences
- 14 predefined scenarios (`scenarios.ts`) covering common agent workloads
- Full test coverage for the harness itself (`harness.test.ts`)

#### SDK Backend Improvements
- SDK backend (`--backend sdk`) promoted to primary with auto-detection inside Claude Code sessions
- Error classification for Anthropic API errors (auth, rate-limit, overload, model-not-found)

#### Logging & Output
- `--json` flag now produces structured NDJSON envelope output on stdout
- All `console.*` calls routed through a structured logger (`src/logging/`)
- Logger initialization wired from CLI flags (`--verbose`, `--quiet`, `--json`)

### Fixed
- Context pruning no-op bug — history messages were not categorized as `history`, so the prune stage skipped them entirely
- Index misalignment in `pruneMessages` after dropped entries caused messages to shift incorrectly
- Consecutive user messages in `reshapeMessages` violated the Anthropic API's alternating-role requirement
- `findToolResult` type checks in `archive.ts` used wrong comparison, missing tool results
- CC client now reads the `structured_output` field from the `claude` CLI response (was silently ignoring it)
- CC client normalizes tool names to lowercase and strengthens the name directive in the system prompt
- Sapling tool definitions are now injected into the CC system prompt so the model knows its available tools

### Changed
- Test suite grown from 164 tests / 17 files / 377 expects to 298 tests / 24 files / 959 expects

## [0.1.0] - 2026-03-02

Initial release of Sapling — a headless coding agent with proactive context management.

### Added

#### Core Agent Loop
- Turn-based agent loop (`src/loop.ts`) with LLM call → tool dispatch → context management cycle
- Parallel tool execution via `Promise.all` for all tool calls in a single turn
- Exponential backoff retry (3 attempts) for transient LLM failures
- Immediate abort on unrecoverable errors (auth failures, model not found)
- Three stop conditions: task complete (no tool calls), max turns (200), unrecoverable error
- NDJSON event streaming (`--json`) and quiet mode (`--quiet`) output options

#### Context Pipeline
- Five-stage inter-turn context manager (`src/context/manager.ts`):
  - **Measure** — token budget tracking with 4-chars/token heuristic and 5-zone window split (15% system, 10% archive, 40% history, 15% current, 20% headroom)
  - **Score** — relevance scoring (0–1) per message using weighted signals: recency (0.30), file overlap (0.25), error context (0.20), decision content (0.15), size penalty (0.10)
  - **Prune** — truncate large bash output, replace stale file reads, summarize/drop low-score old messages
  - **Archive** — rolling work summary from dropped messages (template-based, no LLM call), with file modification tracking and resolved error detection
  - **Reshape** — rebuild message array: [task] → [archive] → [pruned history] → [current turn]

#### Tool System
- Six tools implementing the `Tool` interface (`src/tools/`): `bash`, `read`, `write`, `edit`, `grep`, `glob`
- Tool registry with `createDefaultRegistry()` for registration and dispatch
- Tool result metadata (token estimates, file paths, truncation flags)
- Error-safe execution: tool failures return error results rather than crashing the loop

#### LLM Backends
- **CcClient** (`src/client/cc.ts`) — spawns `claude` subprocess with `--max-turns 1`, parses structured JSON responses; uses Claude Code subscription billing
- **AnthropicClient** (`src/client/anthropic.ts`) — direct Anthropic SDK calls; `@anthropic-ai/sdk` is an optional dependency, dynamically imported

#### CLI
- `sapling run <prompt>` command with options: `--model`, `--cwd`, `--backend`, `--system-prompt-file`, `--max-turns`, `--verbose`, `--json`, `--quiet`
- `sapling version` command
- Dual binary names: `sp` (short) and `sapling` (full)
- Configuration via env vars: `SAPLING_MODEL`, `SAPLING_BACKEND`, `SAPLING_MAX_TURNS`, `SAPLING_CONTEXT_WINDOW`
- Config validation with typed error hierarchy

#### Agent Personas
- Three system prompt personas emitted by Canopy (`agents/`):
  - **Builder** — writes code, runs quality gates, follows existing patterns
  - **Reviewer** — reviews code without making edits
  - **Scout** — explores codebases without making edits

#### Project Infrastructure
- CI workflow (GitHub Actions): test, lint, typecheck on push/PR
- Publish workflow: npm publish on version tags
- Biome linting (tabs, 100-char width, `noExplicitAny: error`)
- TypeScript strict mode (`tsc --noEmit`)
- Contributing guidelines, security policy, issue/PR templates
- Mulch expertise management, Seeds issue tracking, Canopy prompt management integration

#### Testing
- 164 tests across 17 files with 377 `expect()` calls
- Colocated test files (`src/foo.test.ts` next to `src/foo.ts`)
- Real temp directory helpers (`src/test-helpers.ts`)
- Full coverage of: agent loop, context pipeline (all 5 stages), both LLM clients, all 6 tools, config validation, error hierarchy

[Unreleased]: https://github.com/jayminwest/sapling/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/jayminwest/sapling/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/jayminwest/sapling/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/jayminwest/sapling/releases/tag/v0.1.0
