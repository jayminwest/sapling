# Spike: pi SDK in-process embedding (sapling-bec1)

Step 1 of plan pl-2dbb (sapling-on-pi engine swap). This spike embeds the pi
SDK in-process and proves per-turn message-array control — the load-bearing
assumption of the whole plan, since the v1 context pipeline will be injected
at pi's `context` hook (sapling-d066).

Pinned SDK: `@earendil-works/pi-coding-agent@0.83.0` (exact version in
`package.json`; drift tripwires in `src/pi/spike.test.ts`).

## What was proven

Runnable proofs live in `src/pi/spike.ts` (harness) and
`src/pi/spike.test.ts` (assertions). Live proofs run under
`SAPLING_INTEGRATION_TESTS=1` with `ANTHROPIC_API_KEY` set; the tripwire
suite runs unconditionally. All seven tests pass against pi 0.83.0 with
`anthropic/claude-haiku-4-5`.

1. **In-process embedding works without subprocess or global state.**
   `createAgentSession()` + `SessionManager.inMemory(cwd)` +
   `SettingsManager.inMemory(...)` + a temp `agentDir` +
   `ModelRuntime.create({ authPath, modelsPath })` gives a fully isolated
   session. Nothing touches `~/.pi/agent`.
2. **The `context` extension hook fires before every LLM call and may
   replace the message array.** The hook receives a mutable copy of
   `AgentMessage[]`; returning `{ messages }` substitutes the array the
   provider sees. Verified end-to-end: with a hook that rewrites the array
   to a single sentinel user message, the serialized provider payload
   observed via `before_provider_request` contained exactly one message with
   the sentinel and none of the original prompt.
3. **The hook is non-destructive.** After the run, `session.messages` still
   contained the original user prompt and assistant replies; the rewrite
   only affected the outgoing payload.
4. **The hook fires per LLM call across turns.** Two sequential `prompt()`
   calls produced two `context` firings and two `before_provider_request`
   firings, with the second observing grown history.
5. **System prompt control works via `systemPromptOverride`.** A
   `DefaultResourceLoader` override reached the provider payload (with pi's
   own trailer appended — see findings below).
6. **Usage is readable from `turn_end`** (`event.message.usage`), per plan
   constraint (d).
7. **Hard provider errors do not throw.** With an invalid API key and
   retries disabled, `session.prompt()` resolved normally and the final
   assistant message had `stopReason: "error"` plus a populated
   `errorMessage`. Failure classification must read stopReason, per plan
   constraint (e) — confirmed in-process, matching burrow's subprocess
   experience.

## SDK surface pinned (0.83.0)

- Factory: `createAgentSession(options)` → `{ session, extensionsResult, modelFallbackMessage? }`.
- Isolation: `SessionManager.inMemory(cwd?)`, `SettingsManager.inMemory(partialSettings)`,
  `ModelRuntime.create({ authPath, modelsPath })`.
- Runtime auth: `await modelRuntime.setRuntimeApiKey(provider, key)` — a
  non-persisted override, ideal for injecting `OPENROUTER_API_KEY`/etc.
  without touching `auth.json`.
- Model resolution: `modelRuntime.getModel("anthropic", "claude-haiku-4-5")`
  (the built-in catalogue includes haiku/opus/sonnet 4.x/5 ids).
- Tool suppression: `noTools: "all"` on `createAgentSession` options.
- Hooks: registered through an `InlineExtension` passed to
  `DefaultResourceLoader({ extensionFactories })` — no files on disk needed.
  Used events: `context` (mutate messages), `before_provider_request`
  (observe/replace serialized payload), `turn_end` (usage), `message_end`.
- Message types: `AgentMessage`/`UserMessage`/`AssistantMessage`/
  `ToolResultMessage` come from `@earendil-works/pi-agent-core` /
  `@earendil-works/pi-ai`, not from the coding-agent package. Pipeline code
  (src/context/) stays pi-free; the adapter layer (sapling-a075) will own
  all of these imports.
- Settings shape: `{ compaction: { enabled: boolean }, retry: { enabled, maxRetries, baseDelayMs, provider } }`.

## Findings that bite (record for the design doc, sapling-f198)

1. **Anthropic `system` payload is an array of blocks, not a string**:
   `[{ type: "text", text: "...", cache_control: { type: "ephemeral" } }]`.
   Any payload-level system-prompt work (`before_provider_request`) must
   handle both shapes, and must preserve/consider the cache_control block.
2. **pi appends to the overridden system prompt.** With
   `systemPromptOverride`, the payload's system text was
   `<override>\nCurrent working directory: <cwd>`. Sapling's prompt is not
   byte-for-byte sovereign via the override alone; `before_provider_request`
   is the hook for exact control (matches the plan's assumption).
3. **`retry: { enabled: false }` disables pi's auto-retry.** Essential for
   tests and for deterministic failure classification; sapling should decide
   its own retry posture explicitly rather than inherit pi defaults.
4. **Usage is per-request, not cumulative.** In a two-turn run, both
   `message_end` and `turn_end` reported identical per-request usage
   (`input` grows each turn because history is re-sent). The warren/burrow
   double-count warning applies to rpc-mode aggregation; in-process,
   `turn_end` remains the single correct read point (plan constraint d).
5. **`prompt()` resolves after the full run including retries** and never
   throws for provider errors — error classification is entirely a
   stopReason read on the final assistant message.
6. **API-key isolation works as documented**: a temp `agentDir` plus
   runtime key override meant the spike never read or wrote `~/.pi/agent`.
7. **Extension factories need `await loader.reload()`** before
   `createAgentSession` or the hooks silently never register.

## Non-findings / deferrals

- Tool dispatch, guards (`tool_call` blocking), and event re-emission were
  not exercised here; they are steps sapling-1324 and sapling-2371 and will
  be pinned there.
- `steer`/`followUp`/abort semantics (needed by sapling-47b4) exist on
  `AgentSession` per the SDK docs but were not spike-proven.
- OPENROUTER reachability is acceptance criterion 8 for the plan but belongs
  to the config-migration step (sapling-bfe1); `setRuntimeApiKey` is the
  mechanism this spike validated for it.

## How to re-run

```bash
bun test src/pi/spike.test.ts                                  # tripwires only
SAPLING_INTEGRATION_TESTS=1 bun test src/pi/spike.test.ts      # + live proofs
```
