# atomic-agent — engineering guide for agents

This is the source-of-truth for automated contributors (LLM agents, codegen, etc.). Human-facing docs live in `README.md`.

## Mission

`atomic-agent` is a lightweight local operator agent runtime that:

- Embeds as a **sidecar** in Tauri desktop apps (stdin/stdout NDJSON).
- Ships a **CLI** (`atomic-agent`) for local debugging.
- Connects to an **external** `llama-server` (llama.cpp) over HTTP — the LLM runtime, model weights, and binaries are **not** part of this project.
- Keeps every LLM step under ~2.5k tokens by externalising session state, summarising results, and keeping the stable prompt prefix small.

## Architectural invariants

1. **Project ≠ Prompt.** Session state, compressed tool results, and world snapshots live outside the model; the prompt is always a small slice.
2. **Stable prefix.** The prompt template has the shape `[system] [tools] [capabilities] [skills] [session] [world] [conversation]`. Everything above `session` must stay byte-stable within a session — this is what `cache_prompt + slot_id` on `llama-server` relies on.
3. **One step per inference.** No reasoning loops inside a single LLM call. The runtime drives the loop.
4. **Grammar-constrained tool calls.** The sidecar sends a GBNF grammar with every completion request that must produce a tool call.
5. **No global singletons.** Dependencies are passed explicitly. `getConfig()` is the only exception.
6. **Session is multi-turn chat only.** A session is a long-lived chat: `user message → 0..N tool steps → reply` is a macro-turn, multiple turns share one `SessionState.turns[]`. Two terminals exist — `reply` ends the turn, `finish` ends the whole session. All three frontends (CLI `run`, TUI, sidecar) go through `runtime.runTurn` only; there is no one-shot goal mode.

## Layout rules (enforced)

- Feature-based folders under `src/`. Max 2 levels of nesting.
- Each folder has an explicit `index.ts` with **named** exports (no `export *`).
- One responsibility per file. File name describes it exactly. No `utils.ts`, `helpers.ts`, `misc.ts`, `common.ts`.
- Max 300 lines per file. If you cross that, split before adding new code.
- File naming: `kebab-case`, verb-noun for actions (`build-prompt.ts`, `apply-patch.ts`).
- Function naming: `camelCase`, verb-first (`buildPrompt`, `applyPatch`).
- Tests are colocated with source: `build-prompt.test.ts` next to `build-prompt.ts`.
- Config lives in `src/config/` — read it before touching env vars.

## Module map

| Folder | Responsibility |
|---|---|
| `src/config/` | User config file (`<stateDir>/config.json`) + env-based bootstrap, single `getConfig()` |
| `src/sidecar/` | NDJSON protocol + router + typed event schema |
| `src/cli/` | `run`, `index`, `repl`, `tui`, `serve` commands |
| `src/http/` | OpenAI-compatible HTTP API + atomic admin routes for `atomic-agent serve` |
| `src/llm/` | HTTP client for external llama-server + GBNF grammar |
| `src/prompt/` | Prompt builder, stable prefix, token budget |
| `src/session/` | Session state + sqlite persistence |
| `src/agent/` | Agent loop + plan generator + step executor |
| `src/tools/` | Tool registry + individual tools. OS tools: `shell.run`, `fs.read` (w/ `offset`/`limit`/`lineNumbers`), `fs.write`, `fs.list`, `fs.glob`, `fs.grep` (bundled ripgrep), `fs.edit` (atomic string replace), `fs.read_document` (PDF/DOCX/XLSX/RTF/ODT/PPTX/legacy .doc → plain text via pure-JS), `fs.archive.list` / `fs.archive.read_entry` / `fs.archive.extract` (zip/tar/tar.gz/gz via pure-JS; zip-slip + bomb guards), `fs.hash` (md5/sha1/sha256/sha512 streaming), `fs.diff` (unified diff, jsdiff), `fs.patch` (dry-run default, all-or-nothing apply), `fs.watch` (chokidar one-shot, timeout-capped), `git.status` / `git.log` / `git.diff` / `git.show` / `git.blame` / `git.branch` (read-only shell-out with structured parse), `proc.list` / `proc.kill` (ps/tasklist + approval), `http.request` (curl + host allowlist + `config.http.approvalMode`), `clipboard.*`, `window.*`, `notify`. |
| `src/compressor/` | Result compressor, log summariser |
| `src/sandbox/` | git worktree + sandboxed command runner |
| `src/approval/` | Approval gate and event wiring |
| `src/telemetry/` | Structured logger + metrics + trace recorder (`src/telemetry/trace/`) |
| `src/replay/` | Trace-based replay: drift detection + optional LLM re-inference |
| `src/memory/` | Memory fabric: ProfileStore (key/value facts, pinned + contextual) + MemoryStore (FTS5 freeform notes) + async end-of-turn reflection that writes into both. See [MEMORY.md](MEMORY.md). |

## Build & test

```bash
npm install
npm run lint    # tsc noEmit
npm test        # vitest run
npm run build   # compile to dist/
```

The CLI entry is `src/cli/index.ts`; the sidecar entry is `src/sidecar/main.ts`.

## External llama-server

`atomic-agent` never starts a `llama-server`. It assumes the server is reachable at `ATOMIC_AGENT_LLAMA_URL` (default `http://127.0.0.1:8080`). When the server is unreachable, the sidecar emits an `llm_unavailable` event and the runtime remains available for session management, skills, and non-LLM host operations.

## Current memory model

Today the runtime persists session-scoped state only:

- `SessionState.turns[]` for the full multi-turn transcript
- `knownFacts[]` for compact session facts
- `loadedSkills[]` for skill bodies loaded via `skill.view`
- `worldSnapshot` for compressed browser state

`SessionState.turns[]` stores the full history in memory and in the sessions DB unchanged. Prompt-time compression happens only at the `buildPrompt` boundary via `packConversation`: older turns get folded into a single deterministic `summary: N older turns dropped (...)` line so the variable tail of the prompt stays bounded without losing traceability. The visible tail always includes the latest `user` turn.

Prompt-section caps live in the config:

- `agent.tokenBudget` — compact ceiling for the upper prompt (stable prefix + session facts/skills).
- `agent.conversationMaxTokens` (default 32000) — safety-net cap for the `### conversation` section; typical sessions stay well under it.
- `agent.worldSnapshotMaxTokens` (default 8000) — safety-net cap for the `### world` section; the snapshot is already compressed by `aria-compressor`, so this only clips pathological cases with a `[truncated]` marker.

At bootstrap `LlamaServerClient.fetchProps()` reads the model's physical `n_ctx` (from `default_generation_settings.n_ctx`, with a root `n_ctx` fallback) and stores it on `ModelProfile.contextWindow`. `buildPrompt` then clamps the effective conversation cap to the actual available room so the prompt cannot overflow llama-server regardless of how large the user-configured cap is. If llama-server is restarted with a different `n_ctx`, restart the runtime.

There is currently no dedicated workspace-memory, retrieval, embeddings, or resource-summary subsystem in `src/`. Do not describe those modules as implemented unless they are added to the codebase first.

## Memory fabric

A three-channel cross-session memory subsystem lives in [src/memory/](src/memory/) and exposes itself to the agent via six tools in [src/tools/memory/](src/tools/memory/). The full description is in [MEMORY.md](MEMORY.md); this section is the engineering summary.

The three channels share one SQLite file `<stateDir>/memory.sqlite` (separate from `sessions.sqlite`):

| Channel        | Storage table          | Read path (auto)                 | Write path                          |
| -------------- | ---------------------- | -------------------------------- | ----------------------------------- |
| `ProfileStore` | `profile_facts`        | `### profile` (gated)            | `memory.profile.set` + reflection   |
| `MemoryStore`  | `memories` + FTS5      | `### recalled` + `### memory-index` | `memory.notes.store` + reflection|
| Reflection     | n/a — it writes to both| n/a                              | end-of-turn fire-and-forget LLM call|

`MEMORY_SCHEMA_VERSION = 3`; idempotent migrations in [src/memory/memory-schema.ts](src/memory/memory-schema.ts).

### ProfileStore (durable facts, in the prompt tail)

- **Shape.** `profile_facts (key TEXT PK, value TEXT, pinned INTEGER, keywords TEXT, updated_at INTEGER)`. CRUD in [src/memory/profile-store.ts](src/memory/profile-store.ts).
- **Pinned vs contextual.** `pinned=true` (default) facts are always rendered; `pinned=false` facts are rendered only when at least one of their `keywords` hits the current `userMessage` (case-insensitive substring match). Filter applied by [src/memory/profile-renderer.ts](src/memory/profile-renderer.ts), gated by `memory.profile.contextualKeywordGate` (default `true`).
- **Prompt placement.** Rendered as `### profile` in the **variable tail** (between `### session` and `### recalled`). Never the stable prefix. `build-prompt.test.ts` pins the invariant by hashing the stable prefix across profile edits.
- **Budgeting.** `truncateToTokens(content, memory.profile.maxTokens)` (default `512`) with `[truncated]` marker; tokens subtracted from the effective conversation cap in [src/prompt/token-budget.ts](src/prompt/token-budget.ts).
- **Live snapshot.** `AgentLoop` reads `profileStore.list()` once per step via the optional `profileFactsProvider` and threads it into `StepContext.profileFacts` → `buildPrompt`.
- **Tools.** `memory.profile.set { key, value, pinned?, keywords? }`, `memory.profile.remove { key }`, `memory.profile.list {}`.

### MemoryStore (FTS5 freeform notes)

- **Shape.** `memories (id INTEGER PK, content, tags, source, scope, working_dir, created_at, updated_at)` + `memories_fts` virtual table (`porter unicode61`). CRUD in [src/memory/memory-store.ts](src/memory/memory-store.ts). Hard cap `memory.notes.maxEntries` (default `1000`); FIFO eviction by `(updated_at ASC, id ASC)` on overflow.
- **Auto-injection.** Two new tail sections (rendered by [src/memory/notes-renderer.ts](src/memory/notes-renderer.ts)):
  - `### recalled` — top-K BM25 hits against the current `userMessage`. Driven by `memory.recallInjection.{enabled, k, previewChars, maxTokens}` (defaults `k=3`, `previewChars=160`, `maxTokens=400`).
  - `### memory-index` — compact `#id [tags] preview` pointer rows. Driven by `memory.index.{enabled, limit, previewChars, maxTokens}` (defaults `limit=20`, `previewChars=60`, `maxTokens=300`).
  - The two sections are **deduplicated by id** — anything in `### recalled` is filtered out of `### memory-index`.
- **Pre-fetch.** Done once per turn by [src/memory/memory-context-provider.ts](src/memory/memory-context-provider.ts), invoked from `agent-loop.runTurn` before the per-step loop starts. Results land in ephemeral `SessionState.recalledNotes` / `SessionState.memoryIndex`. `stripEphemeral` in [src/session/session-store.ts](src/session/session-store.ts) removes them before snapshot persistence — they are recomputed every turn.
- **Tools.** `memory.notes.store { content, tags?, scope?, workingDir? }`, `memory.notes.recall { query? | id?, scope?, workingDir?, k? }` (`{ id }` is direct lookup for `#42` pointers from `### memory-index`), `memory.notes.forget { id }`. The bulk corpus is **never** dumped wholesale into the prompt.

### Reflection (async end-of-turn memory formation)

- **When.** Fired at the end of every `AgentLoop.runTurn` after `assistant_reply` is emitted. **Fire-and-forget**, never awaited. `abortPending()` runs at the start of the next `runTurn` so at most one reflection is in flight per session.
- **What.** A micro-prompt with its own small stable prefix asks the model to extract durable facts from the last `USER`/`ASSISTANT` exchange. Output is GBNF-constrained to either `NONE` or a bounded list of two flavours:
  - `SET key=value` (pinned fact) or `SET key=value [pinned=false; keywords=a,b,c]` (contextual fact). Caps at `memory.reflection.maxFactsPerCall` (default `3`).
  - `NOTE freeform observation [tag1, tag2]` → into `MemoryStore` with implicit `reflection` tag. Master switch `memory.reflection.autoStoreNotes` (default `true`); cap at `memory.reflection.maxNotesPerCall` (default `2`, set to `0` to disable).
- **KV-cache invariant.** Reflection runs on a **dedicated llama-server slot** reserved at bootstrap via `slotManager.reserveReflectionSlot()`. The main agent slot is never touched. When only one slot is available, reflection falls back to `slotId: -1` (no cache reuse).
- **Writes.** Parsed entries flow through the same validators as the explicit tools (`ProfileStore.set`, `MemoryStore.store`); invalid entries are logged and skipped without failing the whole call.
- **Observability.** `agent.memory.reflection` counter tagged by `outcome` (`ok | none | failed | aborted | timeout`) plus `agent.memory.reflection.latency_ms` histogram. Logs: `reflection.fired`, `reflection.ok`, `reflection.none`, `reflection.aborted`, `reflection.timeout`, `reflection.failed`.
- **Code.** [src/memory/reflection/](src/memory/reflection/) — `reflection-prompt`, `reflection-grammar`, `reflection-parser`, `reflection-runner`.

### Configuration

All keys under `memory.*` in the user config and [src/config/config-schema.ts](src/config/config-schema.ts). Full table in [MEMORY.md §8](MEMORY.md). The most relevant for tuning:

- `memory.profile.{enabled, maxTokens, contextualKeywordGate}`
- `memory.reflection.{enabled, timeoutMs, maxFactsPerCall, autoStoreNotes, maxNotesPerCall}`
- `memory.notes.{enabled, maxEntries, maxContentChars, recallDefaultK}`
- `memory.recallInjection.{enabled, k, previewChars, maxTokens}`
- `memory.index.{enabled, limit, previewChars, maxTokens}`
- `paths.memoryDbFile` — resolved to `<stateDir>/memory.sqlite`.

### Invariants

1. **Stable prefix is untouched by memory writes.** All three memory-aware sections (`### profile`, `### recalled`, `### memory-index`) live strictly in the variable tail. Pinned by `build-prompt.test.ts`.
2. **Reflection never blocks or crashes the loop.** `ReflectionRunner.reflect()` is fire-safe — errors are logged and counted; the agent-visible reply is already returned before reflection starts. Pinned by `slot-manager.test.ts` (slot isolation) and `reflection-runner.test.ts` (error swallowing).
3. **Notes corpus is never dumped wholesale.** Only top-K (`### recalled`) and pointer-only (`### memory-index`) rows go into the prompt; full bodies require an explicit `memory.notes.recall { id }`.
4. **Bounded growth.** Per-call write caps (`maxFactsPerCall` / `maxNotesPerCall`) + storage cap (`maxEntries` + FIFO) + tail caps (`maxTokens` per section) + contextual gating for profile facts ⇒ both the SQLite file and the rendered tail are bounded under all input distributions.
5. **Single validator path per writer.** All `ProfileStore` writes (tool or reflection) go through `ProfileStore.set` validators; all `MemoryStore` writes go through `MemoryStore.store` validators. There is no second back door.
6. **Ephemeral session fields are not persisted.** `SessionState.recalledNotes` / `memoryIndex` are stripped by `stripEphemeral` before `SessionStore` writes the snapshot — they are recomputed each turn against the current user message.

### Explicit out-of-scope

Episodic summaries, `topic`/`expires_at` columns, embeddings / semantic search, importance scoring, content-based deduplication of notes, and secret redaction are deliberately deferred. See [MEMORY.md §10](MEMORY.md) for the known-limitations list.

## LLM reliability policy

Two narrow retry layers sit between the agent loop and `llama-server`. Both are deliberately bounded and never replay already-executed tool calls:

1. **Parser retry (step-executor).** If the first `parseToolCall` on a completion throws, the executor calls the unary `llmComplete` exactly once more with the same prompt/slot and re-parses. A `parse_retry` event is emitted for observability. If the second attempt also fails, the original error (with a raw-output preview) is thrown. The streaming path always falls back to unary for the retry so partial SSE deltas are not double-emitted.
2. **Transport retry (LlamaServerClient).** `complete()` and the initial pre-body fetch of `completeStream()` are wrapped in a bounded retry governed by `llama.completionRetries` (default 3) and `llama.completionRetryBackoffMs` (default 150ms, exponential with ±20% jitter). Retries fire **only** for network errors (`LlamaServerError.status === null`) and HTTP 5xx. Grammar/validation 4xx and abort signals short-circuit immediately. Once the SSE body starts streaming, no further retries happen — the conversation state on the server is considered indeterminate.

### Failure taxonomy

Every terminal failure the agent loop surfaces is normalised into a canonical `LlmFailureCategory` before `step_error` / `loop_failed` fire. The classes live in [src/llm/reliability/](src/llm/reliability/) and carry specialised fields for postmortem use.

| Category    | Class                | When it fires                                                                                         | Invariants                                                                                       |
| ----------- | -------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `transport` | `TransportError`     | `LlamaServerError` with `status === null` or `status >= 500` (after the bounded retry is exhausted).  | Carries `status` and `url`. Transport retries already fired; runtime does not retry again here.  |
| `grammar`   | `GrammarError`       | `LlamaServerError` 4xx, or `ToolCallParseError` that survives the one-shot parser retry.              | Carries `rawPreview` of the completion body so postmortems can diagnose without replaying SSE.   |
| `model`     | `ModelError`         | `detectModelFailure` returns `truncated` / `empty` / `no_stop` on the initial or retry completion.    | **Never retried in-place** — the same prompt would reproduce the same wall. Parser retry skipped. |
| `tool`      | `ToolExecutionError` | Tool missing from the registry, or any unexpected error escaping the tool dispatch path.              | Carries `tool` name. Runtime tool failures from `registry.invoke` are folded into `CompressedToolResult { status: "error" }` and do **not** reach this category. |
| `cancelled` | `CancelledError`     | `ctx.signal.aborted` is true, or the caught error is an `AbortError` / message mentions `aborted`.    | The agent loop closes the turn with `reason: cancelled` and status `cancelled`, not `failed`.    |

`classifyFailure(err)` is the single source of truth for mapping raw thrown values into the taxonomy; `LlmFailure` instances short-circuit the classifier. `step-executor` wraps every escape with the correct subclass before the `step_error` event fires, and `agent-loop` classifies at the outer catch so `loop_failed` always carries `category` even for legacy errors.

### Observability propagation

`category` is plumbed through every observability surface:

- **Events.** `step_error.category` and `loop_failed.category` are mandatory fields on the `AgentLoopEvent` union.
- **Traces.** `TraceError.category` on the append-only NDJSON stream (see [src/telemetry/trace/trace-event.ts](src/telemetry/trace/trace-event.ts)).
- **Metrics.** `AgentMetrics.recordLlmFailure({ sessionId, category })` increments `agent.llm.failure` tagged by category — fired exactly once per failed turn from the agent-loop outer catch.
- **TUI.** `agent-event-reducer` renders `! [${category}] ${message}` in the step feed and `failed [${category}]: ${message}` in the run-status line.
- **Sidecar protocol.** `session_failed.category` and `error.code = step_error:<category>` for the Tauri host.
- **OpenAI SSE.** Atomic-extension clients receive `{ error, category }`; OpenAI-compatible clients receive `error.type = agent.<category>` (the `type` field is a loose string in the OpenAI error envelope).

## Traceability and replay

Every run produces an append-only NDJSON trace at `<stateDir>/traces/<sessionId>.ndjson` — one event per line. Tracing is on by default for `atomic-agent run` / TUI / `atomic-agent serve`, and off by default in sidecar mode so the Tauri host decides whether to opt in.

Emitted `TraceEvent` types (see [src/telemetry/trace/trace-event.ts](src/telemetry/trace/trace-event.ts)):

- `session_started` — carries `workingDir` and optional `metadata`.
- `turn_started` / `turn_finished` — per macro-turn, with `reason` / `stepCount` / `durationMs`.
- `step_started` / `step_finished` — per inference step.
- `prompt_captured` — `{ stablePrefixHash, tail, tokens: { total, stablePrefix, tail }, slotId, cacheReused }`. The stable prefix is stored only as its salted hash (via `hashPrefix` from [src/llm/slot-manager.ts](src/llm/slot-manager.ts)) so trace files stay compact across steps; the variable tail is stored verbatim.
- `llm_completion` — full completion `content` + `reasoningContent` + `timing`, with `attempt: 1 | 2` (attempt 2 == parse retry).
- `tool_invocation` — executed tool call with args, status, summary, and optional details.
- `parse_retry`, `loop_detected`, `error`, `trace_truncated` — diagnostics.

Invariants:

- **Append-only.** Sinks never rewrite past lines. `trace_truncated` is a synthetic final marker when the per-session cap (`telemetry.trace.maxBytesPerSession`, default 10 MiB) is hit; further events are dropped silently.
- **Per-session file.** One NDJSON per `sessionId`; no cross-session mixing.
- **Monotonic `seq`.** Every event carries a monotonic in-session sequence starting at `0`.
- **No redaction yet.** Secret redaction is an explicit NON-goal of this milestone; treat trace files as sensitive local artefacts.

CLI:

- `atomic-agent trace list [--limit N]` — most recent trace files in `<stateDir>/traces/`.
- `atomic-agent trace show <sessionId> [--step N] [--raw]` — pretty-print the chronology. `--raw` includes the full prompt tail and completion content; otherwise they are summarised.
- `atomic-agent trace export <sessionId> [--format ndjson|json]` — dump the file as-is (ndjson) or as a JSON array.
- `atomic-agent trace replay <sessionId> [--step N]` — rebuild the stable prefix from the current runtime (tools / capabilities / skills / persona) and compare its hash to the recorded `stablePrefixHash`. Drift means the upper prompt changed since recording — useful for postmortem when cache hits dropped.

Replay lives in [src/replay/](src/replay/). It is a **prompt-drift postmortem**, not a simulator: it does not reproduce LLM non-determinism or external world state (browser, filesystem). `replayInference` (programmatic, not wired to the CLI yet) can optionally rerun `LlamaServerClient` with the recorded prompts for regression tests across llama-server upgrades.
