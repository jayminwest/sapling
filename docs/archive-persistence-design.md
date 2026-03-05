# Archive Persistence Design

**Issue:** sapling-2da7
**Status:** Proposed
**Date:** 2026-03-04

## Problem

The context pipeline (`SaplingPipelineV1`) is purely in-memory. When a swarm agent is restarted by overstory — due to a crash, a context-window overflow, or a deliberate spawn of a continuation agent — the operation registry and all archived summaries are lost. The replacement agent starts with a blank slate, forfeiting the accumulated working memory that the pipeline built over many turns.

This document specifies `.sapling/archive.json`: a lightweight persistence layer that lets a restarted agent reload its working memory without replaying the full conversation.

---

## Goals

1. A restarted agent can reconstruct the pipeline's operation registry and archived summaries from disk.
2. Writes are safe under concurrent agents sharing the same `.sapling/` directory.
3. The file format is human-readable, diffable, and append-friendly.
4. Persistence is opt-in at the pipeline level; the existing in-memory path is unchanged.
5. No new required dependencies.

## Non-Goals

- Storing raw message content (the conversation history lives in the LLM context window or session.jsonl).
- Replicating the full `Turn` object graph (raw turns are large; summaries suffice for reloads).
- Cross-machine sync or remote storage.
- Automatic compaction/rotation of archive.json (out of scope for v1).

---

## What to Persist

The pipeline's durable state consists of two layers:

### 1. Archived operation summaries

Operations with `status === "archived"` have already been summarized by the compact stage. Their raw turns are gone from the active message array; only the summary survives. This is the most valuable data to persist: it represents the agent's long-term working memory.

Fields to persist per archived operation:

| Field | Rationale |
|-------|-----------|
| `id` | Stable identifier; preserves `dependsOn` links |
| `type` | Operation classification (explore/mutate/verify/investigate/mixed) |
| `status` | Always `"archived"` for persisted entries |
| `outcome` | Success/failure/partial — affects re-evaluation on reload |
| `artifacts` | File paths produced — enables file-overlap scoring on restart |
| `files` | All files touched — same reason |
| `dependsOn` | Dependency graph — preserved for causal scoring |
| `summary` | The compacted text summary — the core of working memory |
| `startTurn` | Temporal ordering reference |
| `endTurn` | Temporal ordering reference |
| `score` | Last known relevance score (advisory; will be re-evaluated) |

Fields to **omit**: `turns` (raw message objects — too large, not needed for reload), `tools` (derivable from type).

### 2. Active/completed operation stubs

Operations with `status === "active"`, `"completed"`, or `"compacted"` may be mid-flight when a restart occurs. Their full turns cannot be persisted cheaply, but a lightweight stub preserves enough for the pipeline to:

- Avoid re-using their IDs.
- Maintain the dependency graph.
- Provide approximate file-overlap context.

Persisted stub fields: `id`, `type`, `status`, `outcome`, `artifacts`, `files`, `dependsOn`, `startTurn`, `endTurn`, `score`, `summary` (null for non-compacted).

### 3. Registry metadata

| Field | Value |
|-------|-------|
| `nextOperationId` | The next monotonic ID to assign — prevents ID reuse |
| `activeOperationId` | Which operation was active at shutdown |
| `schemaVersion` | Format version for forward compatibility |
| `writtenAt` | ISO timestamp |
| `agentId` | The writing agent's identifier (from `$OVERSTORY_AGENT_NAME`) |

---

## File Format

**Path:** `.sapling/archive.json`

**Format:** Single JSON object (not JSONL). Operations are an array sorted by `id`.

```json
{
  "schemaVersion": 1,
  "writtenAt": "2026-03-04T23:57:59.498Z",
  "agentId": "builder-abc1",
  "nextOperationId": 42,
  "activeOperationId": 41,
  "operations": [
    {
      "id": 1,
      "type": "explore",
      "status": "archived",
      "outcome": "success",
      "artifacts": ["src/context/v1/types.ts"],
      "files": ["src/context/v1/types.ts", "src/types.ts"],
      "dependsOn": [],
      "summary": "Explored the context pipeline types. Key findings: Operation interface uses Set<string> for files and tools; status lifecycle is active→completed→compacted→archived.",
      "startTurn": 0,
      "endTurn": 5,
      "score": 0.82
    }
  ]
}
```

**Why a single JSON object, not JSONL?**

- The entire file is rewritten atomically on each write (via temp file + rename), so append-safety is handled at the OS level rather than the format level.
- A single object is easier to read, diff, and inspect.
- Operation counts stay small (tens to low hundreds over a typical session).

---

## When to Write

**Write after every turn** where operations change, using an atomic write:

```
write → .sapling/archive.json.tmp → rename → .sapling/archive.json
```

Atomic rename is O(1) on POSIX filesystems and prevents readers from seeing a partial file.

**Alternative considered: write on graceful shutdown only.**
Rejected: overstory-managed restarts are often ungraceful (SIGKILL, OOM, context overflow). Writing only at shutdown would lose all state for the most common restart scenario.

**Alternative considered: write every N turns.**
Rejected: the write is cheap (small JSON, atomic rename), and skipping turns creates a gap that is hard to reason about. Write every turn.

---

## Conflict Handling for Concurrent Agents

Multiple agents may share a `.sapling/` directory (e.g., a swarm where each agent works in a separate worktree but shares the project root).

### Locking strategy: write-side file lock

Before writing, acquire an exclusive lock on `.sapling/archive.json.lock`:

1. `open(".sapling/archive.json.lock", O_CREAT | O_EXCL)` — create the lock file exclusively.
2. Write `.sapling/archive.json.tmp`.
3. Rename `.sapling/archive.json.tmp` → `.sapling/archive.json`.
4. Delete the lock file.

On lock contention (lock file exists), retry with exponential backoff (10ms, 20ms, 40ms, up to 320ms) before giving up and skipping the write (log a warning).

**Stale lock handling:** If the lock file is older than 5 seconds, assume the writer crashed and remove it before proceeding.

### Merge strategy on concurrent writes

Because each agent has its own operation ID namespace (seeded from `nextOperationId` at load time), ID collisions between agents are not expected. On reload, a new agent reads the file and sets `nextOperationId` to `max(file.nextOperationId, highestIdSeen) + 1`.

If two agents write concurrently and one overwrites the other's changes, the losing agent's operations are lost from the file. This is acceptable for v1: archived summaries are supplementary working memory, not authoritative records. The session.jsonl and the LLM conversation history remain the ground truth.

For v2, consider a JSONL append log with periodic compaction, where each agent appends its own operations without reading the full file.

---

## API Design

New module: `src/context/v1/persist.ts`

```typescript
export interface ArchiveRecord {
  schemaVersion: number;
  writtenAt: string;
  agentId: string;
  nextOperationId: number;
  activeOperationId: number | null;
  operations: PersistedOperation[];
}

export interface PersistedOperation {
  id: number;
  type: OperationType;
  status: OperationStatus;
  outcome: Operation["outcome"];
  artifacts: string[];
  files: string[];        // serialized from Set<string>
  dependsOn: number[];
  summary: string | null;
  startTurn: number;
  endTurn: number;
  score: number;
}

/** Load archive state from disk. Returns null if file does not exist or is unreadable. */
export function loadArchive(saplingDir: string): ArchiveRecord | null;

/** Persist current pipeline state to disk. Silently no-ops if saplingDir is absent. */
export function saveArchive(
  saplingDir: string,
  operations: Operation[],
  activeOperationId: number | null,
  nextOperationId: number,
  agentId: string,
): void;

/** Convert a PersistedOperation back to a partial Operation for pipeline reload. */
export function hydrateOperation(p: PersistedOperation): Operation;
```

### Integration with SaplingPipelineV1

`PipelineOptions` gains two optional fields:

```typescript
export interface PipelineOptions {
  windowSize: number;
  verbose?: boolean;
  registry?: StageRegistry;
  /** Absolute path to the .sapling/ directory. Enables archive persistence when set. */
  saplingDir?: string;
  /** Agent identifier for archive attribution. Defaults to process.env.OVERSTORY_AGENT_NAME. */
  agentId?: string;
}
```

On construction, if `saplingDir` is set, `SaplingPipelineV1` calls `loadArchive()` and initializes `this.operations` and `this.nextOperationId` from the result.

After each `process()` call, `saveArchive()` is called asynchronously (fire-and-forget via `setImmediate`) to avoid adding latency to the pipeline hot path.

### Integration with cli.ts / runCommand()

`runCommand()` in `src/cli.ts` already resolves the `.sapling/` directory for session tracking. It passes `saplingDir` into `PipelineOptions` when constructing `SaplingPipelineV1`.

---

## Reload Behavior

When a restarted agent constructs `SaplingPipelineV1` with a `saplingDir` pointing to an existing archive:

1. `loadArchive()` reads `.sapling/archive.json`.
2. Archived and compacted operations are hydrated into `Operation` objects with empty `turns` arrays (their raw messages are gone, but their metadata and summaries are intact).
3. `nextOperationId` is set to the persisted value.
4. `activeOperationId` is set to the persisted value. On the first `process()` call, the ingest stage may close this operation if its continuation is not present in the new conversation.
5. The render stage emits archived summaries into the system prompt's working memory section as it normally would — the agent sees a continuity of context.

Active/completed operations from before the restart contribute their file and dependency metadata to scoring but do not contribute turns to the rendered message array (they have none).

---

## Security Considerations

- `archive.json` is written to the project's `.sapling/` directory. It may contain file paths and operation summaries generated from tool outputs.
- It should be added to `.gitignore` by `sp init` to avoid accidentally committing potentially sensitive content.
- No credentials, API keys, or raw LLM responses are persisted.

---

## Implementation Plan

| Step | Description | File |
|------|-------------|------|
| 1 | Define `PersistedOperation` and `ArchiveRecord` types | `src/context/v1/types.ts` |
| 2 | Implement `loadArchive()`, `saveArchive()`, `hydrateOperation()` | `src/context/v1/persist.ts` |
| 3 | Wire `saplingDir` and `agentId` into `PipelineOptions` and `SaplingPipelineV1` | `src/context/v1/pipeline.ts` |
| 4 | Pass `saplingDir` from `runCommand()` | `src/cli.ts` |
| 5 | Add `.sapling/archive.json` to `sp init` gitignore scaffolding | `src/commands/init.ts` |
| 6 | Unit tests for persist.ts (load/save round-trip, stale lock, missing dir) | `src/context/v1/persist.test.ts` |
| 7 | Integration test: construct pipeline, save, reconstruct, verify operation count | `src/integration.test.ts` |

---

## Open Questions

1. **Should `archive.json` be scoped per-agent?** Using `.sapling/archive-<agentId>.json` avoids all merge conflicts but fragments working memory. For a single-agent session, the shared file is simpler.

2. **Should the render stage emit a "reloaded from archive" notice?** A brief system prompt annotation like `(Resumed from archive: 7 operations, 3 archived)` could help the agent self-orient after a restart. This seems low-cost and useful.

3. **Max file size / rotation?** A session with 200 turns and 50 operations will produce an archive.json of roughly 50–200 KB — negligible. No rotation needed for v1.

4. **Should `saveArchive()` be synchronous or async?** Synchronous is simpler and avoids partial-write races. The pipeline already runs synchronously; the write is a small JSON file. Start with synchronous and optimize only if profiling shows it matters.
