# AGENTS.md

This file is the canonical entry point for AI coding agents working in
sapling, following the [agents.md](https://agents.md) convention.

## Mission

sapling (`@os-eco/sapling-cli`, CLI: `sp` / `sapling`) is a headless coding
agent with proactive context management. Its core innovation is an
inter-turn context pipeline that evaluates, prunes, and reshapes what the
LLM sees between every turn, so long-horizon agent sessions stay inside the
model's effective context window without losing commitments or decisions.

sapling is part of the os-eco ecosystem (warren, burrow, plot, mulch, seeds,
canopy, trellis). It is the alternative single-agent runtime that warren can
dispatch alongside Claude Code. Long-form architecture notes live in
`CLAUDE.md`.

## Commands

All commands run from the repo root. Bun must be on PATH. There is no
build/compile step — TypeScript runs directly.

```bash
bun install                   # install dependencies
bun test                      # run all tests
bun test src/loop.test.ts     # run a single test file
bun run lint                  # biome check --error-on-warnings .
bun run typecheck             # tsc --noEmit
bun run check:all             # full quality-gate suite (see below)
bun run check:coverage        # tests + coverage-floor ratchet
bun run verify                # agent-facing alias for check:all
```

CLI entry points:

```bash
sapling --help                # CLI top-level help
sp run "task description"     # run the agent loop on a task
```

### Quality gates

`bun run check:all` is the canonical quiet runner (`scripts/check-all.ts`,
byte-identical fleet-wide — never edit it in place). It resolves its gate
manifest from `package.json` and runs, in order:

- `lint` — Biome lint + format, warnings fail
- `typecheck` — strict TypeScript (`tsconfig.json`)
- `check:agents` — `scripts/validate-agents-md.ts` (this file's references)
- `check:dups` — jscpd duplicate-code detector (`.jscpd.json`)
- `check:deps` — knip unused/undeclared dependencies (`knip.json`)
- `check:size` — `scripts/check-file-sizes.ts` (line-count ratchet)
- `check:debt` — `scripts/check-debt-markers.ts` (tracker-pinned TODOs)
- `check:coverage` — `scripts/check-coverage.ts` (coverage-floor ratchet)
- `check:ci-parity` — `scripts/check-ci-parity.ts` (CI ⇄ check:all parity)

Each ratchet reads a JSON budget co-located under `scripts/`
(`scripts/file-size-budgets.json`, `scripts/debt-markers-budget.json`,
`scripts/coverage-budgets.json`). Budgets ratchet in one direction only —
file-size and debt-markers tighten downward; coverage tightens upward. Do
not loosen a budget without filing a sapling-XXXX seeds issue and noting it
in the commit body.

## Architecture (orientation)

- `src/index.ts` (Commander CLI) → `src/cli.ts` → `src/loop.ts` (agent loop)
- `src/client/` — Anthropic SDK client (optional dependency, dynamic import)
- `src/context/v1/` — the inter-turn context pipeline
  (ingest → evaluate → compact → budget → render)
- `src/tools/` — the six built-in tools (bash, read, write, edit, grep, glob)
- `src/hooks/` — guards + NDJSON event emission
- `src/rpc/` — JSON-RPC stdin control channel + Unix socket state queries
- `agents/` — system-prompt personas emitted by Canopy (do not hand-edit)
- `docs/event-schema.md` — NDJSON event reference for orchestrators

## Conventions

### Filenames & identifiers

- Source files: kebab-case, tests co-located as `<name>.test.ts` next to
  the file under test.
- `camelCase` for functions and variables, `PascalCase` for types,
  `SCREAMING_SNAKE_CASE` for true module-level constants.

### TypeScript

- Strict mode with `noUncheckedIndexedAccess` — always handle possible
  `undefined` from indexing.
- No `any`; use `unknown` and narrow (Biome enforces `noExplicitAny`).
- All imports use `.ts` extensions.
- Tab indentation, 100-char line width (Biome enforces).
- Canonical types live in `src/types.ts`; sub-module type files re-export
  from there.

### Debt markers

Every `TODO` / `FIXME` / `HACK` / `XXX` on a source line must carry a
tracker reference on the same line. Accepted prefixes:

- sapling-XXXX — repo-local seeds tracker
- pl-XXXX / mx-XXXX — cross-repo plan and mission trackers
- #NNN — GitHub issue
- A URL (any http link) — external reference

`scripts/check-debt-markers.ts` fails CI on bare markers.

## Agent Workflow

1. **Prime context.** Read this file, `CLAUDE.md`, and run `ml prime`
   (Mulch) and `sd prime` (Seeds) if available.
2. **Find unblocked work.** `sd ready` lists unblocked seeds issues.
3. **Make focused changes.** One concern per commit. Preserve existing
   conventions — adapt, don't overwrite.
4. **Run gates locally.** `bun run check:all` must exit 0 before commit.
5. **Pin debt markers.** Any new `TODO` / `FIXME` must reference a tracker
   id created in the same change.
6. **Record insights.** `ml record` any convention discovered or failure
   encountered, then `ml sync`.

### Session completion protocol

1. File seeds issues for remaining work.
2. Run `bun run check:all`.
3. Close finished issues (`sd close <id>`) and `sd sync`.
4. Record session insights with Mulch.
5. Push only when the user requests it; otherwise leave commits local.

## Testing & Validation Guidance

After every code change (before commit):

```bash
bun run check:all
```

It must exit 0 — CI runs the same single entry point, so local greens are
the contract.

- `bun run check:coverage` enforces the floors in
  `scripts/coverage-budgets.json`. The ratchet only goes **up**; raising a
  floor when coverage improves is encouraged.
- Tests live next to the file under test in `src/` (and `scripts/` for the
  quality scripts). Tests use real temp directories — helpers in
  `src/test-helpers.ts`.
- `.github/workflows/ci.yml` runs `bun run check:all`. `check:ci-parity`
  fails if CI ever invokes a script that the check:all manifest cannot
  reach, so local and CI gates cannot drift.

## Further reading

- `CLAUDE.md` — long-form architecture and conventions
- `README.md` — user-facing pitch + install instructions
- `CHANGELOG.md` — release history
- `docs/event-schema.md` — NDJSON event payload reference
- `scripts/` — quality-gate scripts and their budgets
