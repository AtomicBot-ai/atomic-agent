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
| `src/runtime/` | `bootstrap.ts` (assembles `AgentRuntime`) + `turn-controller.ts` (per-session FIFO queue + per-session event hook map; the **only** path into `AgentLoop.runTurn`). See §"Concurrency contract". |
| `src/tasks/` | Durable queue of deferred `runTurn` submissions: `TaskStore` (SQLite), `TaskRunner` (drain + retry/backoff), `task-backoff`, `task-schedule` (cron / interval / at resolver). See §"Durable tasks" and §"Background autonomy". |
| `src/scheduler/` | One-process `Scheduler` (single `setInterval`) that polls `TaskStore.listDue` via `TaskRunner.runDue`. The **only** periodic timer in the runtime. See §"Background autonomy". |
| `src/http/route-webhooks.ts` + `webhook-template.ts` + `webhook-session-store.ts` | Generic `POST /api/webhooks/:name` ingress. Always materialises into a `TaskRecord`, never calls `runTurn` directly. See §"Background autonomy". |
| `src/tools/tasks/` | Agent-facing self-scheduling tools (`tasks.schedule`, `tasks.cron`, `tasks.list`, `tasks.cancel`, `tasks.show`), gated by `tasks.agentToolsEnabled`. |

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

- **When.** Fired at the end of every `AgentLoop.runTurn` after `assistant_reply` is emitted. **Fire-and-forget**, never awaited. `abortPending({ sessionId: state.id })` runs at the start of the next `runTurn` so at most one reflection is in flight **per session**; reflections on other sessions are never aborted as a side effect (load-bearing for cross-session parallelism — see §"Concurrency contract").
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

## Concurrency contract

Every entry point into the runtime — CLI, TUI, HTTP, sidecar, scheduler, and webhook ingress — funnels through one primitive: `TurnController` in [src/runtime/turn-controller.ts](src/runtime/turn-controller.ts). It is the **only** path into `AgentLoop.runTurn`. The defunct `src/http/turn-hub.ts` is gone; its global serialization invariants are now enforced per session.

### Invariants (locked, pinned by [src/runtime/turn-controller.test.ts](src/runtime/turn-controller.test.ts))

1. **Per-session FIFO.** At most one `runTurn` is in flight per `sessionId`. Two concurrent `enqueue` calls on the same session run strictly in submission order.
2. **Cross-session parallelism.** Different `sessionId`s run concurrently — there is no global queue. This is the property Option 4 (cron / wakeups) was designed to consume.
3. **No preemption, no priorities.** Scheduler-origin submissions queue behind in-flight user submissions on the same session, and vice versa. All `TurnOrigin`s (`cli | tui | http | sidecar | scheduler`) are equal citizens.
4. **Per-session event hook.** `submission.eventHook` is installed before `run()` starts and cleared in `finally`. A hook on session A never sees events from session B. Routing is keyed by `sessionId` stored in an `AsyncLocalStorage` set in `bootstrap.ts` around every `executeTurn` call.
5. **Per-session recorder.** `currentRecorder` is no longer a global pointer; recorders are lazy-created per `sessionId` and dispatched via the same `AsyncLocalStorage`.
6. **Aborted submission rejects fast.** `submission.signal` races the queue wait — a cancelled submission rejects without ever calling `run()`.

### Ownership of shared resources

| Resource | Owner | Safe under cross-session parallelism? |
|---|---|---|
| `PlaywrightBackend` | The active turn on each session | **Yes per-session** — `TurnController` guarantees one turn touches the browser at a time within a session. **Cross-session sharing is an accepted product constraint:** there is one browser profile per process, so concurrent sessions see the same window. Cron-driven sessions must account for this. |
| `SlotManager` | Each `runTurn` (acquire-per-step) | **Yes** — `acquire` for a single session is sequential by `TurnController` invariant; different sessions have separate slot assignments and the round-robin pointer is integer-mutating. See doc-comment in [src/llm/slot-manager.ts](src/llm/slot-manager.ts). |
| `ApprovalGate` | Per-session pending request | **Yes** — at most one pending approval per session by design. |
| `ProfileStore` / `MemoryStore` / `SessionStore` | Anything holding a handle | **Yes** — all three use `better-sqlite3`, which is **synchronous**: there is no race window between read and write inside a single statement, so concurrent sessions are safe. **This is a load-bearing assumption.** Replacing the driver with an async one would require a redesign. |
| `ReflectionRunner.pending` | Per-session `Map<sessionId, AbortController>` | **Yes** — reflection on session A is never aborted by reflection on session B. `agent-loop.runTurn` calls `reflectionRunner.abortPending({ sessionId: state.id })` at the start of every turn so a stale reflection from the previous same-session turn cannot race the next one. `abortPending()` with no argument cancels every in-flight reflection (used at runtime shutdown). |
| Trace recorder | Per-session, dispatched via `AsyncLocalStorage` | **Yes** — no global pointer to mix traces across sessions. |

### What the scheduler / webhook paths may and may not assume

- **May** enqueue any session via `runtime.turnController.enqueue({ origin: "scheduler", … })` or `runtime.runTurn(session, msg, { origin: "scheduler" })`.
- **May** introspect via `turnController.isBusy(sessionId)` / `busySessionIds()` and decide between "enqueue and wait" or "skip this tick".
- **May not** preempt user turns or claim a separate priority queue — there is none.
- **May not** assume exclusive browser ownership across sessions; the browser is shared at process scope (see table).
- **Must not** hold a stale `SessionState` reference between `enqueue` and `run`. `executeTurn` writes its result to `sessionStore`; the correct pattern is to **re-read the latest session inside the queued callback** (see [src/sidecar/main.ts](src/sidecar/main.ts) `send_message` for the canonical example).

### Extension points

- `TurnController.isBusy(sessionId)` / `busySessionIds()` — observability hook for UI and scheduler.
- `TurnController.emit(sessionId, event)` — single dispatch path for `AgentLoopEvent` to the per-session hook.
- `runtime.executeTurn(session, msg, opts)` — bypasses the queue. Used by sidecar from inside an already-acquired `enqueue` callback so it does not deadlock against itself. CLI / TUI / HTTP go through the public `runtime.runTurn` instead.

### Risk (acknowledged)

The three existing callers (CLI / HTTP / sidecar) relied on subtle hook timing through `TurnHub` / inline `onAgentEvent`. The hook contract on `TurnController` matches the defunct `TurnHub.runExclusive` byte-for-byte (hook installed before `run()`, cleared in `finally`), so single-session callers are observably identical. New surface tests cover the cross-session and same-session-FIFO behaviour: [src/http/openai-chat-completions.test.ts](src/http/openai-chat-completions.test.ts), [src/sidecar/send-message-concurrency.test.ts](src/sidecar/send-message-concurrency.test.ts), [src/memory/reflection/reflection-runner.test.ts](src/memory/reflection/reflection-runner.test.ts).

## Durable tasks

A minimal durable queue of deferred `runTurn` submissions lives in [src/tasks/](src/tasks/). It is the **persistence layer** for any future scheduler / cron / agent-driven self-scheduling — but it ships **without** a background ticker on purpose: drains are always triggered explicitly (CLI `atomic-agent task run`, HTTP `POST /api/tasks/drain`) or implicitly right after `create()` when `tasks.runOnCreate=true` (the default).

A task is exactly one record:

```ts
TaskRecord = {
  id, sessionId, userMessage, maxSteps,
  status: "pending" | "running" | "completed" | "failed" | "blocked" | "cancelled",
  origin: "cli" | "tui" | "http" | "sidecar" | "scheduler" | "agent",
  attempts, maxAttempts, lastError, lastErrorCategory,
  createdAt, updatedAt, startedAt, completedAt,
}
```

Stored in a separate SQLite file `<stateDir>/tasks.sqlite` (no cross-file FKs to `sessions.sqlite` — `sessionId` validity is checked at runtime by `TaskRunner` and a missing session marks the task `blocked` with `session_not_found`). Schema version `1`, idempotent migrations in [src/tasks/task-schema.ts](src/tasks/task-schema.ts).

### Lifecycle

```
pending --(markRunning)--> running
running --(success)--> completed
running --(retryable, attempts < maxAttempts)--> pending   [retry loop]
running --(retryable, attempts == maxAttempts)--> failed
running --(grammar | tool failure)--> blocked              [permanent — same input, same wall]
running --(cancelled signal)--> cancelled
pending --(cancel())--> cancelled
```

Failure classification is delegated to `classifyFailure` from [src/llm/reliability/](src/llm/reliability/) (the LLM reliability policy below) so retry semantics never drift from the rest of the runtime.

### Drain semantics

`TaskRunner.drainPending(opts?)` is the one-shot drain primitive:

1. Pull every `pending` task (optionally `?session=`).
2. Group by `sessionId`.
3. For each group: drain sequentially. Each call into `runtime.runTurn(..., { origin: "scheduler" })` enters `TurnController` per-session FIFO and serialises against any user turn that lands mid-drain.
4. Across groups: `Promise.all` — different sessions drain in parallel, inheriting cross-session parallelism from the Concurrency contract above for free.

Inter-attempt sleep on retry uses `nextDelayMs(attempts, { initialMs, maxMs })` from [src/tasks/task-backoff.ts](src/tasks/task-backoff.ts) (`min(initialMs * 2^attempt, maxMs)`). Sleep happens **between attempts**, never blocking the per-session lock for longer than necessary.

### Locked invariants (pinned by tests)

1. **Tasks always run via `runtime.runTurn(..., { origin: "scheduler" })`.** Never via `executeTurn` (which bypasses the controller). Per-session FIFO + cross-session parallelism are inherited from §"Concurrency contract".
2. **Retries are turn-level only.** The same `userMessage` is replayed; partial-tool replay is out of scope. Step-level retries inside a single `runTurn` remain the LLM reliability layer's responsibility.
3. **`TaskRunner` never holds a `SessionState` reference between attempts.** It always re-reads via `sessionStore.load(sessionId)` inside the next attempt — same pattern as the sidecar `send_message` callback.
4. **`cancel(id)` is idempotent on terminal rows** — returns the existing record unchanged, so HTTP `DELETE` and CLI `cancel` are safe to retry.
5. **Stale recovery is one-shot.** `taskStore.recoverStale(staleAfterMs)` runs exactly once on bootstrap; there is **no background sweeper**. Process crash between `markRunning` and the terminal write leaves a `running` row that the next bootstrap flips back to `pending`.
6. **`tasks.enabled=false` ≠ `TaskStore` is absent.** The store is always constructed (it owns a SQLite handle that must be closed in `shutdown`), but `drainPending` is a no-op and HTTP routes return 404. Mirrors `memory.profile.enabled` from Memory fabric.

### Surfaces

| Surface | Path | Notes |
|---|---|---|
| HTTP | `POST/GET /api/tasks`, `GET/DELETE /api/tasks/:id`, `POST /api/tasks/:id/run`, `POST /api/tasks/drain` | [src/http/route-tasks.ts](src/http/route-tasks.ts). Returns 404 for every route when `tasks.enabled=false`. |
| CLI | `atomic-agent task list \| show \| create \| cancel \| run` | [src/cli/task-command.ts](src/cli/task-command.ts). All subcommands except `run` open `TaskStore` directly and exit fast; `run` boots the full `createAgentRuntime` and tears it down on the way out. |
| Telemetry | `agent.tasks.{created,started,completed,failed,blocked,cancelled,retried}` counters + `agent.tasks.{attempts,duration_ms}` histograms | Emitted from `TaskRunner` at status transitions. |

### Configuration

All under `tasks.*` in [src/config/config-schema.ts](src/config/config-schema.ts) — env-only (operational tuning, not user config file material):

- `tasks.enabled` (default `true`) — master switch.
- `tasks.maxAttempts` (default `3`) — retry budget per task.
- `tasks.backoffInitialMs` (default `1000`) / `tasks.backoffMaxMs` (default `60000`) — exponential capped backoff.
- `tasks.runOnCreate` (default `true`) — auto-drain immediately after `create()`. Detached, fire-and-forget.
- `tasks.staleAfterMs` (default `300000`) — `recoverStale` threshold.
- `paths.tasksDbFile` — resolved to `<stateDir>/tasks.sqlite`.

### Out of scope (deferred)

Task graphs / dependencies, workflow primitives (`kind != "runTurn"`), secret redaction in `userMessage` / `lastError`, per-origin priorities, distributed scheduler / leader election across multiple processes. Scheduling itself, webhook ingress, and agent-side `tasks.*` tools shipped in Option 4 — see next section.

## Background autonomy

Option 4 ships time-based scheduling, webhook ingress, and agent self-scheduling as a thin layer on top of §"Durable tasks". It **does not** change the `runTurn` contract or add any timers outside of `src/scheduler/`.

### Schedules on `TaskRecord`

`TaskRecord` carries an optional `schedule: TaskSchedule | null` where `TaskSchedule` is a discriminated union:

```ts
TaskSchedule =
  | { kind: "at"; at: number }                         // Unix ms
  | { kind: "cron"; expression: string; tz?: string }  // parsed via cron-parser
  | { kind: "interval"; everyMs: number }              // lower bound config.tasks.minIntervalMs
```

`resolveScheduledFor(schedule, fromMs)` in [src/tasks/task-schedule.ts](src/tasks/task-schedule.ts) is the **only** path that turns a schedule into an absolute `scheduledFor` (Unix ms). It is used both by `TaskRunner.create` on insert and by recurring requeue on completion. `cron-parser` is imported **only** from this file.

Schema bumped `TASK_SCHEMA_VERSION` 1 → 2, idempotent migration adding columns `schedule_kind`, `schedule_value` (JSON), `scheduled_for`, `recurring`, `last_scheduled_at`, `trigger_source` and a partial index `idx_tasks_due(status, scheduled_for) WHERE status='pending'` — the only path the scheduler uses to find work.

### Scheduler

[src/scheduler/scheduler.ts](src/scheduler/scheduler.ts) exposes one class with `start()`, `stop()`, `tickOnce()` (for tests). One `setInterval` per runtime, period = `config.tasks.schedulerTickMs` (default 5000), batch = `config.tasks.schedulerBatch` (default 10). On each tick:

1. Guard `running` flag (no reentry).
2. `await taskRunner.runDue(Date.now(), batch)`.
3. Errors are swallowed + logged + counted in `agent.scheduler.tick_errors`; interval keeps running.

Wired in [src/runtime/bootstrap.ts](src/runtime/bootstrap.ts) after `taskStore.recoverStale`. `shutdown()` awaits `scheduler?.stop()` **before** `taskStore.close()` to prevent a final tick from touching a closed handle.

### Session lifecycle for scheduled tasks

This is the most load-bearing rule in Option 4 — respect it when adding new code paths.

| Task shape | `sessionId` at `create()` | `sessionId` before `runTurn` |
|---|---|---|
| User-provided `sessionId` (CLI / HTTP / sidecar) | As provided | Unchanged. |
| One-shot, no `sessionId`, no `schedule` (or `schedule.kind="at"`) | `NULL` | `TaskRunner.runOne` lazily creates a fresh ephemeral session, **writes it back to the row**, then calls `runTurn`. Once written, stable for the row's lifetime. |
| Recurring (`cron` / `interval`), no `sessionId` | A fresh persistent session, created immediately by `sessionFactory` | Reused across every firing. If the session row is missing (user deleted it), `runOne` auto-recreates, logs a warning, emits `agent.tasks.session_recreated`, and continues. |

`requeueRecurring` atomically resets `attempts`, `last_error`, `started_at`, `completed_at` and rearms `scheduled_for` — **but never touches `session_id`**. This invariant is pinned by [src/tasks/task-store.test.ts](src/tasks/task-store.test.ts).

### Wake reason on session metadata

`TaskRunner.stampWakeReason` writes `session.metadata.wakeReason = { source, taskId, webhookName?, at }` before every `runTurn`, then persists the session. `source ∈ { "user", "scheduler", "webhook", "agent" }` mirrors `TaskRecord.triggerSource`. The reserved keys under `session.metadata` are documented in [src/session/session-state.ts](src/session/session-state.ts):

- `wakeReason` — set by `TaskRunner`, audit-only in this milestone (not rendered into the prompt).
- `recurringTask`, `scheduleKind` — set on persistent sessions owned by recurring tasks.
- `webhookName`, `webhookPersistent` — set on sessions created via `POST /api/webhooks/:name`.
- `ephemeralTask`, `scheduledBy` — set on lazy-created one-shot sessions.

None of these are currently rendered into the stable prefix; if you start rendering them, pin the stable-prefix hash test first.

### Webhook ingress

`POST /api/webhooks/:name` in [src/http/route-webhooks.ts](src/http/route-webhooks.ts) resolves `config.webhooks[name]` and returns 404 when missing or when `tasks.enabled=false`. On success:

1. Optional `x-webhook-secret` check against `config.webhooks[name].secret`.
2. `userMessage` = `evaluateWebhookTemplate(userMessageTemplate, body)` with `{{body.<json.path>}}` substitutions (see [src/http/webhook-template.ts](src/http/webhook-template.ts) — minimal substitution, no expression eval, length-capped).
3. `sessionId` resolved per `sessionMode`: `ephemeral` (leave null — `TaskRunner` creates fresh on `runOne`), `persistent` (read/create via [webhook-session-store.ts](src/http/webhook-session-store.ts), file-backed JSON in `<stateDir>/webhook-sessions.json`), `named` (require explicit `sessionId` in config).
4. `taskRunner.create({ origin: "http", triggerSource: "webhook", sessionId, userMessage, schedule })` — the route **never** calls `runTurn` directly.
5. HTTP 202 with `{ taskId }`.

Webhook config lives in the **user config file** (per-name declarative — ops shouldn't need a redeploy to add a new webhook). `USER_CONFIG_VERSION` bumped 2 → 3 with transparent `v2 → v3` migration (`webhooks: {}` default).

### Agent tools (`tasks.*`)

Five tools in [src/tools/tasks/](src/tools/tasks/), gated by `config.tasks.agentToolsEnabled`. Registered from [src/runtime/bootstrap.ts](src/runtime/bootstrap.ts) next to `registerMemoryTools`. The current session id is read via `AsyncLocalStorage` (`currentSessionId` from [src/runtime/session-context.ts](src/runtime/session-context.ts)).

| Tool | Writeable | Session resolution | Schedule |
|---|---|---|---|
| `tasks.schedule` | yes | **Inherits current session** by default; `newSession=true` opts into a fresh one | `at` (absolute) or `inSeconds` (relative) — validated via `parseOneShotSchedule` |
| `tasks.cron` | yes | **Always** a fresh persistent session (recurring ⇒ continuity, never mix with user thread) | `{ kind: "cron", expression, tz? }` |
| `tasks.list` | no | Defaults to current session; filters by `status` (CSV) and `limit` (capped at 200) | — |
| `tasks.cancel` | yes | — | — |
| `tasks.show` | no | — | — |

`TaskValidationError`s from `parseOneShotSchedule` / `task-schedule` are caught inside each tool's `run` method and surfaced as a structured `{ status: "error", details }` result — they never escape as thrown exceptions.

Descriptors in [src/prompt/tool-descriptors.ts](src/prompt/tool-descriptors.ts); the GBNF grammar [grammars/tool-call.gbnf](grammars/tool-call.gbnf) was extended with a `tasks-tool` branch covering all five names.

### Configuration (env-only under `tasks.*`)

Extending §"Durable tasks" config:

- `tasks.schedulerEnabled` (default `true`, env `ATOMIC_AGENT_TASKS_SCHEDULER_ENABLED`).
- `tasks.schedulerTickMs` (default `5000`).
- `tasks.schedulerBatch` (default `10`).
- `tasks.agentToolsEnabled` (default `true`, env `ATOMIC_AGENT_TASKS_AGENT_TOOLS_ENABLED`).
- `tasks.minIntervalMs` (default `1000`) — lower bound for `{ kind: "interval" }`.

Webhook config lives under `webhooks.*` in the user config file, not env.

### Telemetry

Added to [src/telemetry/agent-metrics.ts](src/telemetry/agent-metrics.ts):

- Counters: `agent.tasks.scheduled`, `agent.tasks.recurring_requeued`, `agent.tasks.session_recreated`, `agent.tasks.session_auto_created`, `agent.scheduler.ticks`, `agent.scheduler.tick_errors`, `agent.webhooks.received`.
- Histograms: `agent.scheduler.batch_size`, `agent.scheduler.tick_duration_ms`.
- Webhook tag: `webhook_name`.

### CLI

`atomic-agent task create` now accepts scheduling flags:

- `--at <unix-ms>` — one-shot at absolute time.
- `--cron "<expr>" [--tz <iana>]` — recurring cron (allocates a persistent session eagerly, so this path boots the full runtime).
- `--every <seconds>` — recurring interval.
- `--session <id>` is now optional; omit for one-shot ephemeral or let recurring allocate its own.

`atomic-agent task list` gained `schedule` and `next-run` columns.

`atomic-agent task tick` — one-shot `runDue(now, limit=Infinity)` for ops debugging (does not start the long-lived ticker).

### TUI surface (Tasks tab)

The `atomic-agent tui` debug pane exposes the task store as a first-class tab. State slice `state.tasksPanel` in [src/tui/tui-state.ts](src/tui/tui-state.ts) drives three view modes — `list`, `detail`, `create` — plus an optional `cancelConfirm` modal.

Module map:

- [src/tui/tasks/tasks-panel-state.ts](src/tui/tasks/tasks-panel-state.ts) — state types + `createInitialTasksPanelState`.
- [src/tui/tasks/tasks-actions.ts](src/tui/tasks/tasks-actions.ts) — `TasksAction` union (`tasks_*` prefix); folded into the root `TuiAction` via a mixin.
- [src/tui/tasks/tasks-reducer.ts](src/tui/tasks/tasks-reducer.ts) — slice reducer invoked first by the root reducer, returns `null` to fall through.
- [src/tui/tasks/tasks-filter.ts](src/tui/tasks/tasks-filter.ts) — pure filter+sort (status bucket, substring search).
- [src/tui/tasks/tasks-summary.ts](src/tui/tasks/tasks-summary.ts) — `TaskRecord → TaskSummaryRow` with time/interval formatters.
- [src/tui/tasks/cron-preview.ts](src/tui/tasks/cron-preview.ts) — thin wrapper over `peekNextFirings` (still keeps `cron-parser` behind `task-schedule.ts`).
- [src/tui/tasks/tasks-form-validator.ts](src/tui/tasks/tasks-form-validator.ts) — create-form parser; errors surfaced as `preview.error`, never thrown.
- [src/tui/tasks/tasks-orchestrator.ts](src/tui/tasks/tasks-orchestrator.ts) — the only module that calls `runtime.taskStore` / `runtime.taskRunner` from TUI code. Owns a 5s `setInterval` refresher (opt-in on first entry to the tab).
- [src/tui/tasks/tasks-key-bindings.ts](src/tui/tasks/tasks-key-bindings.ts) — dedicated hotkey layer; disables the editor when `activeTab === "tasks"` so single-char hotkeys (`j/k/n/c/R/r/a/f/o`) never conflict with typing.
- Components in [src/tui/components/tasks-*.tsx](src/tui/components/).

Keyboard contract:

- **List mode** — `j/k` (or arrows) move cursor, Enter opens detail, `n` opens create form, `c` cancels (y/n confirm for recurring), `R` runs now, `r` manual refresh, `a` toggles auto-refresh, `f` cycles status filter.
- **Detail mode** — `o` opens the task's session, `R` runs now, `c` cancels, Esc returns to list.
- **Create form** — Tab/Shift+Tab cycles focus (`kind → expression → tz? → message → submit`), Left/Right cycles kind when focused, Enter submits on the submit field or advances otherwise, Ctrl+Enter submits from any field, Esc closes.
- **Cancel confirm modal** — `y` confirms, `n`/Esc dismisses.

Slash commands:

- `/tasks` — jump to the Tasks tab.
- `/task new` — jump + open the create form.
- `/task cancel <id>` — enqueue a cancellation (skips the modal — intentional, the operator knows the id).
- `/task run <id>` — execute one attempt via `TaskRunner.runOne`.

Locked invariants (pinned by [src/tui/tasks/tasks-reducer.test.ts](src/tui/tasks/tasks-reducer.test.ts), [src/tui/tasks/tasks-filter.test.ts](src/tui/tasks/tasks-filter.test.ts), [src/tui/tasks/tasks-form-validator.test.ts](src/tui/tasks/tasks-form-validator.test.ts), [src/tui/tasks/cron-preview.test.ts](src/tui/tasks/cron-preview.test.ts), [src/tui/tasks/tasks-summary.test.ts](src/tui/tasks/tasks-summary.test.ts), [src/tui/commands/slash-command-handler.test.ts](src/tui/commands/slash-command-handler.test.ts)):

1. **`TasksOrchestrator` is the only TUI module that touches `runtime.taskStore` / `runtime.taskRunner`.** Components dispatch actions; actions reach the orchestrator via `TuiAppCallbacks`.
2. **`cron-parser` stays behind `task-schedule.ts`.** TUI only imports `peekNextFirings` via `cron-preview.ts`.
3. **The editor is disabled on the Tasks tab.** Single-char hotkeys are free to use letter keys; Tab re-enters the debug-tab cycler unless a create form or cancel modal is open.
4. **Form validation is pure.** Neither the reducer nor the keybinding layer throws; all errors surface as `preview.error` or `runtime_info` lines.
5. **Firings feed is best-effort.** The orchestrator diffs task snapshots between refresh ticks; it is never the source of truth for billing or auditing — that stays in metrics + traces.

### Locked invariants (pinned by tests)

Pinned by [src/scheduler/scheduler.test.ts](src/scheduler/scheduler.test.ts), [src/tasks/task-runner.test.ts](src/tasks/task-runner.test.ts), [src/tasks/task-store.test.ts](src/tasks/task-store.test.ts), [src/http/route-webhooks.test.ts](src/http/route-webhooks.test.ts), [src/runtime/bootstrap.test.ts](src/runtime/bootstrap.test.ts), and colocated tool tests:

1. **`Scheduler` is the only new periodic timer.** Never `setInterval` outside `src/scheduler/`.
2. **Webhooks never call `runTurn` directly.** Always `TaskRunner.create`.
3. **Recurring requeue preserves `session_id`.** Only auto-recreation on `session_not_found` may overwrite it.
4. **One-shot `session_id` is stable after the first attempt.** Lazy-created sessions must be written back to the row before `runTurn`.
5. **Partial-index `idx_tasks_due` is the only scheduler path.** No full scans.
6. **`tasks.enabled=false` disables everything.** Scheduler doesn't start, webhook routes 404, agent tools unregistered.
7. **`cron-parser` is isolated behind `task-schedule.ts`.** Future replacement touches one file.
8. **`session.metadata.wakeReason` is audit-only.** Survives restart, never rendered into the prompt.
9. **Agent tool validation errors are structured, not thrown.** Including nested errors from schedule parsing.

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
