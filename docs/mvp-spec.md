# Sapling MVP Specification

> A headless coding agent with proactive context management.

**Status:** Draft — awaiting review
**Scope:** MVP (minimal viable product for integration with overstory)
**CLI:** `sapling` / `sp`
**npm:** `@os-eco/sapling-cli`
**Sub-repo:** `sapling/`
**Core innovation:** Inter-turn context management — the LLM never sees bloated context

---

## The One-Sentence Pitch

Sapling is a coding agent where context management is a first-class concern,
not an afterthought. Between every LLM call, Sapling evaluates, prunes, and
reshapes what the model sees — so it operates at maximum capacity for the
entire task, not just the first 20 turns.

---

## Tech Stack

Identical to the rest of os-eco. No exceptions.

- **Runtime:** Bun (runs TypeScript directly, no build step)
- **Language:** TypeScript with strict mode (`noUncheckedIndexedAccess`, no `any`)
- **Linting:** Biome (formatter + linter in one tool)
- **CLI framework:** Commander.js (typed options, subcommands, auto-generated help)
- **Runtime dependencies:** `chalk` (v5, ESM-only color output), `commander` (CLI framework)
- **Dev dependencies:** `@types/bun`, `typescript`, `@biomejs/biome`
- **Testing:** `bun test` (built-in, Jest-compatible API)
- **File I/O:** Bun built-in APIs (`Bun.file`, `Bun.write`, `Bun.spawn`, `Bun.glob`)
- **External CLIs:** `claude` (for CC backend), `rg` (ripgrep, for grep tool) — invoked via `Bun.spawn`, never as npm imports

---

## MVP Scope

Four components. Nothing else.

| # | Component | Lines (est.) | Purpose |
|---|-----------|-------------|---------|
| 1 | Agent Loop | ~300 | The turn cycle: LLM call → tool dispatch → context management → repeat |
| 2 | Tool System | ~800 | read, write, edit, bash, grep, glob — Sapling's own implementations |
| 3 | LLM Client | ~400 | Provider-agnostic interface. CC subprocess is the first backend. |
| 4 | Context Manager | ~800 | The novel part. Inter-turn evaluation, pruning, and reshaping. |

**Total estimate:** ~2,300 lines

### What MVP excludes

- JSON-RPC protocol (overstory spawns Sapling as a subprocess; control protocol is post-MVP)
- Mail integration (`.overstory/mail.db` reads)
- Mulch/Seeds/Canopy ecosystem integration
- Guard system (overstory guards come post-MVP)
- Multi-provider support beyond CC + Anthropic SDK (interface is extensible)
- Observability beyond stdout/stderr logging
- TUI or interactive mode

---

## Architecture

```
sapling/
  src/
    index.ts              CLI entry point (Commander.js program, VERSION constant)
    loop.ts               Agent turn loop
    types.ts              ALL shared types and interfaces
    errors.ts             Custom error types (extend SaplingError)
    config.ts             Config loader + defaults + validation
    json.ts               Standardized JSON envelope helpers (jsonOutput/jsonError)

    client/
      types.ts            LlmClient interface + LlmRequest/LlmResponse
      cc.ts               Claude Code subprocess backend (primary)
      anthropic.ts         Raw Anthropic SDK backend (secondary)

    tools/
      index.ts            Tool registry + dispatch
      types.ts            Tool interface + ToolDefinition
      bash.ts             Shell execution (Bun.spawn)
      read.ts             File read (Bun.file)
      write.ts            File write (Bun.write, atomic)
      edit.ts             In-place edit (exact match replacement)
      grep.ts             Content search (ripgrep wrapper via Bun.spawn)
      glob.ts             File discovery (Bun.glob)

    context/
      manager.ts          Orchestrates the context pipeline
      measure.ts          Token counting + budget tracking
      score.ts            Relevance scoring per message
      prune.ts            Pruning strategies (truncate, summarize, drop)
      archive.ts          Working memory / long-term store
      reshape.ts          Rebuild messages array for next turn

    logging/
      logger.ts           Structured logging (human + NDJSON)
      color.ts            Central color control (NO_COLOR, --quiet)

  agents/                 Agent definition files (the HOW)
    builder.md            # Mirrors overstory/agents/ but tailored for Sapling
    scout.md
    reviewer.md

  # Tests colocated: src/loop.test.ts, src/tools/bash.test.ts, etc.
  # Test helpers: src/test-helpers.ts

  package.json
  tsconfig.json
  biome.json
  CLAUDE.md
  CONTRIBUTING.md
  README.md
  LICENSE
  CHANGELOG.md
  SECURITY.md
```

---

## Coding Conventions

### Formatting

- **Tab indentation** (enforced by Biome)
- **100 character line width** (enforced by Biome)
- Biome handles import organization automatically

### TypeScript

- Strict mode with `noUncheckedIndexedAccess` — always handle possible `undefined` from indexing
- `noExplicitAny` is an error — use `unknown` and narrow, or define proper types
- `useConst` is enforced — use `const` unless reassignment is needed
- `noNonNullAssertion` is a warning — avoid `!` postfix, check for null/undefined instead
- All shared types and interfaces go in `src/types.ts`
- All error types go in `src/errors.ts` and must extend `SaplingError` base class

### Error Handling

```typescript
// src/errors.ts
export class SaplingError extends Error {
  readonly code: string;

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SaplingError";
    this.code = code;
  }
}

export class ClientError extends SaplingError { ... }
export class ToolError extends SaplingError { ... }
export class ContextError extends SaplingError { ... }
export class ConfigError extends SaplingError { ... }
```

### JSON Output

All `--json` outputs use standardized envelope format via `src/json.ts`:

```typescript
// Success envelope
{ "name": "@os-eco/sapling-cli", "version": "0.1.0", ... }

// Error envelope
{ "error": { "code": "TOOL_FAILED", "message": "...", "details": {...} } }
```

### Subprocess Execution

All external commands run through `Bun.spawn`. Capture stdout/stderr, check
exit codes, throw typed errors on failure:

```typescript
const proc = Bun.spawn(["rg", "--json", pattern, path], {
  cwd: workingDir,
  stdout: "pipe",
  stderr: "pipe",
});
const exitCode = await proc.exited;
if (exitCode !== 0) {
  const stderr = await new Response(proc.stderr).text();
  throw new ToolError(`grep failed: ${stderr}`, "GREP_FAILED");
}
```

### Dependencies

- **Minimal runtime dependencies.** Only `chalk` (color output) and `commander` (CLI framework) are allowed as runtime deps.
- Use Bun built-in APIs: `Bun.spawn` for subprocesses, `Bun.file` for file reads, `Bun.write` for writes, `Bun.glob` for file discovery
- External tools (`claude`, `rg`) are invoked as subprocesses via `Bun.spawn`, never as npm imports
- `@anthropic-ai/sdk` is an optional peer dependency (for the SDK backend only)
- Dev dependencies are limited to types and tooling

### File Organization

- Each subsystem gets its own directory under `src/` (client, tools, context, logging)
- Agent definitions (`.md` files) live in `agents/` at the repo root
- Tests are colocated with source files (e.g., `src/tools/bash.test.ts`)
- Shared test utilities live in `src/test-helpers.ts`

---

## Component 1: Agent Loop

### The Turn Cycle

```
start(task, systemPrompt, tools, model)
  │
  ▼
┌─────────────────────────────────────────────┐
│ TURN LOOP                                   │
│                                             │
│  1. Build LLM request from managed context  │
│  2. Call LLM via client interface           │
│  3. Record token usage from response        │
│  4. Parse response for tool_use blocks      │
│  5. If no tool calls → task complete, exit  │
│  6. Execute tools, collect results          │
│  7. ┌─────────────────────────────┐         │
│     │ CONTEXT MANAGER             │         │
│     │  measure → score → prune    │         │
│     │  → archive → reshape        │         │
│     └─────────────────────────────┘         │
│  8. Messages array is now right-sized       │
│  9. Go to 1                                 │
│                                             │
└─────────────────────────────────────────────┘
```

### Key Design Decisions

**Parallel tool execution.** When the LLM returns multiple tool_use blocks,
execute them in parallel via `Promise.all`. This matches CC/Pi behavior.

**Stop conditions:**
- No tool calls in response → agent believes task is done
- Max turns reached → forced stop (configurable, default: 200)
- Context manager signals unrecoverable state → abort with error

**Error handling:**
- Tool execution errors are returned to the LLM as error results (not thrown)
- LLM client errors (API failures, timeouts) use exponential backoff (3 retries)
- Unrecoverable errors (auth failure, model not found) abort immediately

### Interface

```typescript
interface LoopOptions {
  task: string;               // The task description / prompt
  systemPrompt: string;       // Full system prompt (agent def + task + context)
  model: string;              // Model identifier
  maxTurns?: number;          // Default: 200
  cwd: string;                // Working directory for tools
}

interface LoopResult {
  exitReason: "task_complete" | "max_turns" | "error" | "aborted";
  totalTurns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  error?: string;
}

async function runLoop(
  client: LlmClient,
  tools: ToolRegistry,
  contextManager: ContextManager,
  options: LoopOptions,
): Promise<LoopResult>;
```

---

## Component 2: Tool System

### Tool Interface

```typescript
interface Tool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  execute(input: Record<string, unknown>, cwd: string): Promise<ToolResult>;
}

interface ToolResult {
  content: string;            // Text result returned to LLM
  isError?: boolean;          // Whether this is an error result
  metadata?: {
    tokensEstimate?: number;  // Estimated token count of content (for budget tracking)
    filePath?: string;        // File involved (for relevance scoring)
    truncated?: boolean;      // Whether output was truncated
  };
}
```

### Tool Specifications

**bash** — Shell command execution
- Runs via `Bun.spawn` with configurable timeout (default: 120s)
- Captures stdout + stderr
- Truncates output beyond limit (default: 50,000 chars → ~12,500 tokens)
- Returns exit code in result
- **No streaming for MVP** — capture full output, truncate, return

**read** — File reading
- Uses `Bun.file` for file reads
- Supports `offset` (line number) and `limit` (line count)
- Returns content with line numbers (like `cat -n`)
- Truncates files beyond limit (default: 2,000 lines)
- Returns file size metadata for budget tracking

**write** — File creation/overwrite
- Uses `Bun.write` for atomic writes
- Creates parent directories if needed
- Returns confirmation with file path and size

**edit** — In-place text replacement
- Exact string match: `oldText` → `newText`
- Fails if `oldText` not found or not unique
- Returns confirmation with line range affected

**grep** — Content search
- Wraps `rg` (ripgrep) via `Bun.spawn`
- Supports: pattern, path, glob filter, context lines
- Three output modes: `files_with_matches`, `content`, `count`
- Truncates results beyond limit (default: 100 matches)

**glob** — File discovery
- Uses `Bun.glob` or equivalent
- Returns matching file paths sorted by modification time
- Truncates beyond limit (default: 500 files)

### Tool Definitions for LLM

Each tool provides a `toDefinition()` method that returns an Anthropic-format
tool definition:

```typescript
{
  name: "read",
  description: "Read a file from the filesystem...",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to file" },
      offset: { type: "number", description: "Line to start from" },
      limit: { type: "number", description: "Number of lines" },
    },
    required: ["file_path"],
  },
}
```

---

## Component 3: LLM Client

### Design Constraint

Sapling's core innovation (inter-turn context management) **requires owning
the agent loop**. The LLM client is therefore a thin transport layer — it
sends a prompt and gets a response. It does NOT run its own agent loop.

Two backends are first-class, in priority order:

1. **CC subprocess** — Uses Claude Code subscription billing. CC is invoked
   as a structured-output endpoint with its own tools disabled.
2. **Raw Anthropic SDK** — Uses standard API billing. Direct SDK calls with
   native tool_use support.

Both implement the same `LlmClient` interface. The agent loop, tools, and
context manager are identical regardless of backend.

### Interface

```typescript
interface LlmClient {
  /** Unique backend identifier (e.g., "cc", "anthropic-sdk"). */
  readonly id: string;

  /** Make a single LLM call. Returns structured response. */
  call(request: LlmRequest): Promise<LlmResponse>;

  /** Estimate token count for a string. Used for budget tracking. */
  estimateTokens(text: string): number;
}

interface LlmRequest {
  systemPrompt: string;
  messages: Message[];
  tools: ToolDefinition[];
  model?: string;              // Override default model
  maxTokens?: number;          // Max output tokens (default: 8192)
}

interface LlmResponse {
  content: ContentBlock[];     // text + tool_use blocks
  usage: TokenUsage;
  model: string;
  stopReason: "end_turn" | "tool_use" | "max_tokens";
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

type Message =
  | { role: "user"; content: string | ContentBlock[] }
  | { role: "assistant"; content: ContentBlock[] };
```

### Backend 1: CC Subprocess (Primary — subscription billing)

Uses Claude Code as a structured-output endpoint. CC handles auth and billing
(subscription pricing). Sapling owns everything else.

**Invocation:**
```bash
claude -p "$(cat managed-context.json)" \
  --system-prompt-file sapling-system.md \
  --tools "" \                    # Disable CC's built-in tools
  --max-turns 1 \                 # Single API call, no CC loop
  --output-format json \          # Structured response
  --json-schema tool-response.json  # Force structured tool call format
```

**How it works:**
1. `--system-prompt-file` replaces CC's default system prompt with Sapling's
2. `--tools ""` disables ALL of CC's built-in tools (read, write, bash, etc.)
3. `--max-turns 1` ensures CC makes exactly one API call and returns
4. `--json-schema` constrains the response to Sapling's tool call format
5. CC handles auth (ANTHROPIC_API_KEY, Bedrock, Vertex credentials)
6. Response includes token usage for budget tracking

**Subprocess pattern follows os-eco convention:**
```typescript
const proc = Bun.spawn(["claude", "-p", prompt, ...flags], {
  cwd: workingDir,
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env },
});
const exitCode = await proc.exited;
if (exitCode !== 0) {
  const stderr = await new Response(proc.stderr).text();
  throw new ClientError(`CC subprocess failed: ${stderr}`, "CC_FAILED");
}
const stdout = await new Response(proc.stdout).text();
const response = JSON.parse(stdout);
```

**Structured output schema:**
```json
{
  "type": "object",
  "properties": {
    "thinking": {
      "type": "string",
      "description": "Reasoning about what to do next"
    },
    "tool_calls": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "input": { "type": "object" }
        },
        "required": ["name", "input"]
      }
    },
    "text_response": {
      "type": "string",
      "description": "Final text when no more tools needed"
    }
  },
  "required": ["thinking"]
}
```

**Message serialization:** The full conversation history (managed by the
context manager) is serialized into the prompt. The system prompt goes via
`--system-prompt-file` (written to a temp file via `Bun.write`). Each CC
subprocess call gets the full managed context.

**Trade-offs:**
- ~1-2 seconds subprocess overhead per LLM call
- No streaming within a turn
- Tool calls are JSON-schema-structured, not native API tool_use blocks
- CC subscription pricing (the whole point)

**Token estimation:** Character-based estimation (4 chars ≈ 1 token) for
pre-call budgeting. Actual counts from response `usage` field.

### Backend 2: Raw Anthropic SDK (Secondary — API billing)

Direct `@anthropic-ai/sdk` calls with native tool_use support.

```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();  // Reads ANTHROPIC_API_KEY from env

const response = await client.messages.create({
  model: request.model ?? "claude-sonnet-4-6",
  system: request.systemPrompt,
  messages: request.messages,
  tools: request.tools,
  max_tokens: request.maxTokens ?? 8192,
});
```

**Advantages over CC subprocess:**
- Zero subprocess overhead
- Native tool_use content blocks (no JSON schema parsing)
- Streaming support (future)
- Prompt caching headers (future)

**Trade-off:** Standard API pricing ($3/$15 per MTok for Sonnet).

### Billing Reality (Research Confirmed)

| Method | Max Subscription? | Billing |
|---|---|---|
| `claude -p` (CLI) | Yes | Flat subscription rate |
| Agent SDK (`@anthropic-ai/claude-agent-sdk`) | **No** | API per-token |
| Raw SDK (`@anthropic-ai/sdk`) | No | API per-token |
| Bedrock (`CLAUDE_CODE_USE_BEDROCK=1`) | N/A | AWS account billing |
| Vertex (`CLAUDE_CODE_USE_VERTEX=1`) | N/A | GCP account billing |

The OAuth workaround for Agent SDK + Max subscription was shut down in
Feb 2026. For Max subscribers, `claude -p` is the ONLY path to subscription
pricing. This validates the CC subprocess as the primary backend.

For enterprise users, Bedrock and Vertex provide alternative billing paths
that work with both the CLI and SDK approaches.

### Why NOT the Claude Agent SDK (for MVP)

The Agent SDK (`@anthropic-ai/claude-agent-sdk`) is remarkably capable:
- Custom MCP tools + `allowedTools` whitelist = full tool ownership
- Streaming input mode = inject messages between turns
- V2 `send()`/`stream()` = clean multi-turn control
- `canUseTool` + hooks = intercept/modify/block every tool call

**But it's incompatible with Sapling's core innovation.** The Agent SDK owns
the conversation history internally. Sapling cannot prune, reshape, or manage
the messages that CC sends to the LLM. Inter-turn context management — the
thing that makes Sapling worth building — doesn't work when CC controls the
message array.

Post-MVP, the Agent SDK may serve as a "compatibility mode" backend where
users who don't need Sapling's context management can use CC's battle-tested
loop with Sapling's tools. But this is not MVP scope.

### Future Backends

The `LlmClient` interface supports additional backends:

- `BedrockClient` — AWS Bedrock billing (uses CC's `CLAUDE_CODE_USE_BEDROCK=1`)
- `VertexClient` — Google Vertex billing (uses CC's `CLAUDE_CODE_USE_VERTEX=1`)
- `OpenRouterClient` — Gateway provider support
- `OllamaClient` — Local models for testing/development
- `AgentSdkClient` — Claude Agent SDK with MCP tools (CC loop, Sapling tools)

Each implements the same interface. Configuration determines which is active.

---

## Component 4: Context Manager

This is the core innovation. Every other section is commodity engineering.
This section is where Sapling either works or doesn't.

### Design Principles

1. **The LLM should never see a bloated context.** By the time the model
   receives its next prompt, every piece of context has earned its place.

2. **Context management happens BETWEEN turns, not when you hit the wall.**
   CC and Pi wait until ~90% capacity and then panic-compact. Sapling manages
   context continuously, like memory management in a garbage-collected runtime.

3. **The system prompt and task spec are sacred.** They never get pruned.
   Everything else is fair game.

4. **Pruning is lossy and that's OK.** The goal isn't perfect recall — it's
   keeping the agent focused on what matters NOW. A 3-line summary of 15 old
   turns is better than 15 turns of stale context pushing out room for the
   current problem.

5. **Measure twice, cut once.** Token counting happens before and after
   pruning. The manager knows exactly how much space it has and how much
   each piece of context costs.

### The Pipeline

```
After each turn:

  ┌──────────┐
  │ MEASURE  │  Count tokens per category.
  │          │  Are we over budget anywhere?
  └────┬─────┘
       │
  ┌────▼─────┐
  │  SCORE   │  Rate each message's relevance to the current subtask.
  │          │  Recent? References active files? Error context?
  └────┬─────┘
       │
  ┌────▼─────┐
  │  PRUNE   │  Apply strategies based on category + score:
  │          │    - Truncate large tool results
  │          │    - Summarize old conversation turns
  │          │    - Drop stale file reads
  │          │    - Collapse redundant operations
  └────┬─────┘
       │
  ┌────▼─────┐
  │ ARCHIVE  │  Move pruned content to long-term store.
  │          │  Summaries of past work, key decisions, file snapshots.
  └────┬─────┘
       │
  ┌────▼─────┐
  │ RESHAPE  │  Rebuild the messages array:
  │          │    [task] + [archive summary] + [recent turns] + [current]
  │          │  This is what the LLM sees next turn.
  └──────────┘
```

### Token Budgets

The context window is divided into budgets. These are soft limits — the
manager aims to keep each category within its budget but can flex if needed.

```typescript
interface ContextBudget {
  /** Model's total context window in tokens. */
  windowSize: number;

  /** Budget allocations as fractions of windowSize. Must sum to ≤ 1.0. */
  allocations: {
    systemPrompt: number;    // ~0.15 — anchored, never pruned
    archiveSummary: number;  // ~0.10 — compact summary of past work
    recentHistory: number;   // ~0.40 — recent turns, verbatim
    currentTurn: number;     // ~0.15 — latest tool results
    headroom: number;        // ~0.20 — reserved for LLM response
  };
}
```

Default allocations for a 200K-token window:

| Category | % | Tokens | Purpose |
|----------|---|--------|---------|
| System prompt | 15% | 30K | Agent def + task spec (anchored) |
| Archive summary | 10% | 20K | Compacted history of past work |
| Recent history | 40% | 80K | Last N turns, verbatim |
| Current turn | 15% | 30K | Latest tool results |
| Headroom | 20% | 40K | Reserved for LLM output |

### Relevance Scoring

Each message in the conversation gets a relevance score (0.0 → 1.0):

```typescript
interface ScoredMessage {
  message: Message;
  score: number;           // 0.0 (irrelevant) → 1.0 (critical)
  category: MessageCategory;
  tokenCount: number;
  age: number;             // Turns since this message was added
  metadata: {
    filesReferenced: string[];
    isErrorContext: boolean;
    hasUnresolvedQuestion: boolean;
  };
}
```

**Scoring heuristics (MVP):**

| Signal | Weight | Rationale |
|--------|--------|-----------|
| Recency | 0.30 | Recent turns are more relevant |
| File overlap | 0.25 | Messages about files the agent is currently editing |
| Error context | 0.20 | Error messages and surrounding context |
| Decision content | 0.15 | Messages where the agent made explicit decisions |
| Size penalty | 0.10 | Larger messages get penalized (they cost more budget) |

**Recency curve:** Score decays exponentially with age. Messages from the
last 3 turns score 1.0; messages from 10+ turns ago score < 0.3.

**File overlap:** If the agent's most recent edit/write was to `src/foo.ts`,
messages that reference `src/foo.ts` get a relevance boost.

**Error context:** If the last tool result was an error, the preceding
3 messages (the context that led to the error) get boosted.

### Pruning Strategies

Different content types get different pruning strategies:

**Tool results (the biggest source of bloat):**

| Situation | Strategy |
|-----------|----------|
| File read → file subsequently edited | Replace read content with "Read file X (N lines), then edited it" |
| Grep with 100+ matches | Summarize: "Found N matches across M files: [file list]" |
| Bash output > 5K tokens | Keep first 50 + last 20 lines, truncate middle |
| Stale read (>10 turns, not referenced) | Drop entirely |
| Duplicate reads of same file | Keep most recent, drop earlier versions |

**Assistant messages:**

| Situation | Strategy |
|-----------|----------|
| Recent (last 5 turns) | Keep verbatim |
| Older, high relevance score | Keep verbatim |
| Older, low relevance score | Summarize to 1-2 sentences |
| Very old (>20 turns) | Merge into archive summary |

**Summarization (MVP approach):**

For MVP, summarization uses a simple template-based approach (no LLM call):

```
Turn {N}: {tool_name}({key_args}) → {outcome}
```

Example:
```
Turn 3: read(src/auth.ts) → 142 lines, contains login() and logout()
Turn 4: edit(src/auth.ts) → replaced password check logic
Turn 5: bash(bun test) → 3 tests passed, 1 failed (test_logout)
```

Post-MVP: Use a small/fast model (haiku) for richer summarization.

### Archive (Working Memory)

The archive stores compacted information from pruned turns:

```typescript
interface ContextArchive {
  /** Rolling summary of all work done so far. */
  workSummary: string;

  /** Key decisions the agent has made (extracted from reasoning). */
  decisions: string[];

  /** Files the agent has modified, with brief descriptions. */
  modifiedFiles: Map<string, string>;

  /** Last known content hash of important files (for staleness detection). */
  fileHashes: Map<string, string>;

  /** Errors encountered and their resolutions. */
  resolvedErrors: string[];
}
```

**Archive update rules:**
- When turns are pruned, their summaries are appended to `workSummary`
- When the agent edits a file, `modifiedFiles` is updated
- When an error is resolved (error → successful retry), add to `resolvedErrors`
- `workSummary` itself is capped at the archive budget; oldest entries drop first

**Archive injection:** The archive is rendered into a single message inserted
after the task assignment:

```markdown
## Work So Far
[workSummary]

## Files Modified
- src/foo.ts: Added login validation
- src/bar.ts: Fixed null pointer in parse()

## Key Decisions
- Using bcrypt for password hashing (not argon2, because...)
- Skipping integration tests per task spec

## Resolved Issues
- Fixed import path error by using relative paths
```

### Context Manager Interface

```typescript
interface ContextManager {
  /**
   * Process the context after a turn.
   * Called between every LLM call.
   *
   * @param messages - Current full message array
   * @param lastUsage - Token usage from the most recent LLM call
   * @param currentFiles - Files the agent is actively working on
   * @returns Managed message array, ready for next LLM call
   */
  process(
    messages: Message[],
    lastUsage: TokenUsage,
    currentFiles: string[],
  ): Message[];

  /** Get current budget utilization. */
  getUtilization(): BudgetUtilization;

  /** Get the archive for inspection/debugging. */
  getArchive(): ContextArchive;
}

interface BudgetUtilization {
  systemPrompt: { used: number; budget: number };
  archiveSummary: { used: number; budget: number };
  recentHistory: { used: number; budget: number };
  currentTurn: { used: number; budget: number };
  headroom: { used: number; budget: number };
  total: { used: number; budget: number };
}
```

### Context Manager Tuning

The context manager's effectiveness depends on tuning. MVP ships with
conservative defaults and logs metrics for analysis:

**Metrics logged per turn:**
- Token utilization per category (before and after pruning)
- Number of messages pruned / summarized / dropped
- Relevance score distribution
- Archive size growth

**Success criteria:**
- Total token usage on equivalent tasks is 30-50% less than CC/Pi
- Agent never hits context limit unexpectedly
- Agent coherence doesn't degrade after pruning (measured by task completion rate)

---

## CLI Interface (MVP)

Minimal CLI for testing. Not the primary interface (overstory is).

```
sapling run <prompt>            Execute a task
  --model <name>                  Model to use (default: sonnet)
  --cwd <path>                    Working directory (default: .)
  --backend <cc|sdk>              LLM backend (default: cc)
  --system-prompt-file <path>     Custom system prompt
  --max-turns <n>                 Max turns (default: 200)
  --verbose                       Log context manager decisions
  --json                          NDJSON event output on stdout
  --quiet, -q                     Suppress non-essential output

sapling version                 Print version
```

**Example:**
```bash
sp run "Add input validation to the login function in src/auth.ts" \
  --cwd /path/to/project \
  --verbose
```

---

## Testing Strategy

### Philosophy: Never mock what you can use for real

Prefer real implementations over mocks. Mocks are a last resort, not a default.

**Use real implementations for:**
- **Filesystem:** Use temp directories (`mkdtemp`) for file I/O tests
- **Git:** Use real git repos in temp directories for integration tests
- **Tool system:** Test each tool against real filesystem operations

**Only mock when the real thing has unacceptable side effects:**
- **LLM client:** Real API calls have real costs and latency
- **CC subprocess:** Spawning `claude` has side effects and costs
- When mocking is necessary, document WHY in a comment at the top of the test file

### Test Helpers

Shared test utilities live in `src/test-helpers.ts`:
- `createTempDir()` — Create an isolated temp directory
- `cleanupTempDir()` — Remove temp directories
- `createTempGitRepo()` — Initialize a real git repo in a temp dir
- `createMockClient()` — Returns a predictable LlmClient for loop testing

### Unit Tests

**Tools:** Test each tool against real filesystem in temp directories.

```typescript
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, it, expect } from "bun:test";

describe("read tool", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "sapling-test-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true });
  });

  it("reads a file with line numbers", async () => {
    await Bun.write(join(testDir, "test.ts"), "const x = 1;\nconst y = 2;\n");
    const result = await readTool.execute({ file_path: join(testDir, "test.ts") }, testDir);
    expect(result.content).toContain("const x = 1;");
    expect(result.isError).toBeFalsy();
  });
});
```

**Context Manager:** Test each pipeline stage independently:
- `src/context/measure.test.ts` — Token counting accuracy
- `src/context/score.test.ts` — Relevance scoring with known inputs
- `src/context/prune.test.ts` — Pruning strategies produce expected output
- `src/context/reshape.test.ts` — Message array reconstruction
- `src/context/manager.test.ts` — Full pipeline integration

**LLM Client:** Mock the CC subprocess (real subprocess has cost/side effects).
Document the mock rationale at top of test file:

```typescript
// WHY MOCK: CC subprocess calls have real API costs and require
// a valid ANTHROPIC_API_KEY. We mock the subprocess output to test
// response parsing and error handling without API calls.
```

### Integration Tests

**End-to-end:** Run Sapling on a real coding task in a temp git repo.
Verify task completion + context management metrics.
Requires `SAPLING_INTEGRATION_TESTS=1` env var to run.

### Running Tests

```bash
bun test                              # All unit tests
bun test src/tools/bash.test.ts       # Single test file
SAPLING_INTEGRATION_TESTS=1 bun test  # Include integration tests
```

---

## Quality Gates

Run all three before committing:

```bash
bun test                              # Tests pass
biome check .                         # Linting + formatting clean
tsc --noEmit                          # Type checking passes
```

Or use the package.json scripts:

```bash
bun run test                          # bun test
bun run lint                          # biome check .
bun run typecheck                     # tsc --noEmit
```

---

## Project Configuration Files

### package.json

```json
{
  "name": "@os-eco/sapling-cli",
  "version": "0.1.0",
  "description": "Headless coding agent with proactive context management",
  "author": "Jaymin West",
  "license": "MIT",
  "type": "module",
  "repository": {
    "type": "git",
    "url": "https://github.com/jayminwest/sapling.git"
  },
  "homepage": "https://github.com/jayminwest/sapling",
  "keywords": ["ai", "agents", "cli", "developer-tools", "coding-agent", "context-management"],
  "bin": {
    "sp": "./src/index.ts",
    "sapling": "./src/index.ts"
  },
  "main": "src/index.ts",
  "files": ["src", "agents"],
  "publishConfig": {
    "access": "public"
  },
  "engines": {
    "bun": ">=1.0"
  },
  "scripts": {
    "test": "bun test",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "typecheck": "tsc --noEmit",
    "version:bump": "bun scripts/version-bump.ts"
  },
  "dependencies": {
    "chalk": "^5.6.2",
    "commander": "^14.0.3"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.3.15",
    "@types/bun": "latest",
    "typescript": "^5.9.0"
  },
  "optionalDependencies": {
    "@anthropic-ai/sdk": "^0.39.0"
  }
}
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noFallthroughCasesInSwitch": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src/**/*.ts"]
}
```

### biome.json

```json
{
  "$schema": "https://biomejs.dev/schemas/2.3.15/schema.json",
  "files": {
    "includes": ["**", "!**/.seeds", "!**/.claude", "!**/.overstory", "!**/.pi", "!**/node_modules"]
  },
  "assist": { "actions": { "source": { "organizeImports": "on" } } },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "correctness": {
        "noUnusedVariables": "error",
        "noUnusedImports": "error"
      },
      "suspicious": {
        "noExplicitAny": "error"
      },
      "style": {
        "noNonNullAssertion": "warn",
        "useConst": "error"
      }
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "tab",
    "lineWidth": 100
  }
}
```

---

## Integration with Overstory (Post-MVP)

After MVP proves the core loop + context manager, integration follows:

### Phase 1: Basic Runtime Adapter
- `src/runtimes/sapling.ts` in overstory
- Implements `AgentRuntime` interface (same as Claude, Pi, Codex adapters)
- Spawns Sapling as a subprocess via `Bun.spawn`
- Passes task + system prompt via CLI flags
- Reads NDJSON events from stdout
- Checks process liveness via `kill(pid, 0)` (no tmux)
- Session store uses `pid` instead of `tmux_session`

### Phase 2: JSON-RPC Protocol
- Sapling listens on stdin for JSON-RPC commands
- Supports: `start`, `steer`, `followUp`, `abort`
- Implements `RuntimeConnection` interface
- Enables mid-task mail injection, course correction

### Phase 3: Ecosystem Integration
- Direct `bun:sqlite` access to `mail.db` (between-turn mail check)
- `mulch prime` on startup for domain expertise
- `sd update` as work progresses
- Real-time metrics writes to `metrics.db` (WAL mode, 5s busy timeout)

### Phase 4: Guard System
- TypeScript guard functions (not shell scripts)
- Path boundary enforcement
- Capability-based tool restrictions
- Bash command filtering

---

## Implementation Order

Build and test each component independently, then integrate:

1. **Project scaffold** — package.json, tsconfig, biome.json, src/index.ts
   with VERSION constant, src/types.ts, src/errors.ts. Verify quality gates
   pass on empty project.

2. **Tool system** — Most mechanical, easiest to test. Build and verify
   all 6 tools work correctly in isolation. Colocated tests with real
   filesystem operations.

3. **LLM client** — CC subprocess backend first. Verify it can make a single
   LLM call and parse the structured response. SDK backend second.

4. **Agent loop** — Wire tools + client together. Verify the basic
   prompt → tools → result cycle works on a trivial task.

5. **Context manager** — Build the pipeline stages one at a time:
   a. `measure` — Token counting
   b. `score` — Relevance scoring
   c. `prune` — Pruning strategies
   d. `archive` — Working memory
   e. `reshape` — Message reconstruction
   f. Integration — Wire into the agent loop

6. **CLI** — Minimal CLI wrapping the loop via Commander.js. Test on real tasks.

7. **Benchmarking** — Compare token usage vs CC/Pi on equivalent tasks.

---

## Open Questions

1. **CC structured output fidelity:** Does `--json-schema` reliably produce
   well-formed tool call JSON across all models? Edge cases with complex
   tool inputs (nested objects, arrays) need testing.
   → Build it, test it, iterate.

2. **CC subprocess latency at scale:** Each CC invocation is a cold start.
   Sapling serializes the full managed context into every call. At 80K tokens,
   how does this affect subprocess latency? Is there a ceiling?
   → Benchmark early. If unacceptable, switch to SDK backend for heavy tasks.

3. **Summarization quality:** Template-based summarization may lose too much
   information for complex tasks. When do we upgrade to LLM-based summaries?
   → Measure first. Upgrade when we see coherence degradation.

4. **Budget tuning:** The default 15/10/40/15/20 split is a starting guess.
   Real-world tuning will adjust these based on task profiles.
   → Ship with defaults, expose as config, tune with data.

5. **Agent definitions:** Should Sapling use overstory's existing agent
   definitions (`agents/builder.md`) or create its own?
   → Start with overstory's. Fork when Sapling-specific needs diverge.

6. **Claude Agent SDK as post-MVP backend:** RESOLVED — Agent SDK does NOT
   get Max subscription billing (OAuth workaround shut down Feb 2026). It
   does support custom MCP tools, streaming input, and tool interception,
   making it viable as a "compatibility mode" backend post-MVP where CC
   owns the loop but Sapling provides tools. Not compatible with inter-turn
   context management (CC owns the message history).

7. **Bedrock/Vertex billing paths:** The CC CLI supports
   `CLAUDE_CODE_USE_BEDROCK=1` and `CLAUDE_CODE_USE_VERTEX=1` for routing
   through cloud provider billing. These work with `claude -p` and could
   provide enterprise-friendly billing. Worth supporting post-MVP.
