# atomic-agent — evolution options

This document captures high-leverage ways to improve the `atomic-agent` core without changing its product identity as a local operator runtime. It complements:

- `README.md` for user-facing setup and usage
- `ARCHITECTURE.md` for the current design and invariants
- `AGENTS.md` for contributor constraints and the current memory model

## Current core

Today the runtime is strongest as a reactive, step-by-step operator loop built around:

- `src/runtime/bootstrap.ts`
- `src/agent/agent-loop.ts`
- `src/agent/step-executor.ts`
- `src/prompt/build-prompt.ts`
- `src/session/session-state.ts`

Its current strengths are clear:

- stable prompt prefix and KV-cache reuse
- explicit tool loop with grammar-constrained tool calls
- durable session persistence in SQLite
- browser and OS tool surfaces with approval gating

Its current limits are also clear:

- memory is session-scoped only
- long `conversation` and `world` tails can grow until the model context limit
- there is no scheduler, wakeup layer, or external event ingress
- LLM failure recovery is narrow
- there is no durable background task model

## Design constraints

Any core evolution should preserve the current architectural invariants:

- keep the stable prefix byte-stable within a session
- keep one LLM inference equal to one agent step
- keep tool calls grammar-constrained
- keep dependencies explicit
- keep session state outside the model whenever possible

## Option 1: managed turn memory

What it adds:

- a bounded transcript window
- session summaries for older turns
- explicit token budgets for `worldSnapshot` and conversation tail

Why it matters:

- gives the fastest stability win for long sessions
- reduces silent dependence on the remote model's `n_ctx`
- makes prompt growth predictable and observable

Likely modules:

- `src/prompt/build-prompt.ts`
- `src/prompt/token-budget.ts`
- `src/session/session-state.ts`
- `src/session/conversation-turn.ts`
- `src/compressor/`

Main risk:

- summary quality can hide details if the compression policy is too aggressive

## Option 2: memory fabric (operator-first) [done: 2026-04-23; revised: 2026-04-23]

Reframed from the original "workspace memory and retrieval" framing: `atomic-agent` is a general-purpose local operator, not a coding-scoped assistant, so the first memory milestone targets operator durability (who the user is) rather than workspace / file-index retrieval. Workspace inventories, document summaries, and embedded retrieval are explicitly deferred.

**Retracted:** the original plan bundled an **Action History** layer that searched existing `tool_invocation` events in `<stateDir>/traces/*.ndjson`. In production tracing is off by default, which left the feature dead on arrival. Action History (`memory.history.*` config, `memory.history.search` tool, `action-history-reader`/`action-history-search` modules) has been removed. Memory formation now happens through an **async end-of-turn reflection runner** that distils durable facts out of the last exchange and writes them into the same `ProfileStore`.

What ships (single-layer profile + async reflection formation):

- **User Profile** — durable key/value facts in a new SQLite file `<stateDir>/memory.sqlite`, rendered as `### profile` in the **variable tail** of the prompt between `### session` and `### world`. Managed by three tools: `memory.profile.set`, `memory.profile.remove`, `memory.profile.list`. Gated by `memory.profile.enabled` (default `true`), capped by `memory.profile.maxTokens` (default `512`).
- **Reflection runner** — fire-and-forget at the end of every `AgentLoop.runTurn`. Uses a dedicated llama-server slot (`slotManager.reserveReflectionSlot()`) with its own tiny stable prefix so the main agent's KV cache is never invalidated. A GBNF-constrained micro-prompt emits either `NONE` or at most `memory.reflection.maxFactsPerCall` `SET key=value` lines, which flow through `ProfileStore` validators. Gated by `memory.reflection.enabled` (default `true`), timeout `memory.reflection.timeoutMs` (default `10000`).

Why this order:

- gives the runtime durable cross-session memory of the user (Type 1) with near-zero prompt cost
- replaces the trace-dependent Action History with an autonomous formation mechanism that works regardless of whether telemetry is enabled
- defers embeddings, semantic retrieval, summaries, and workspace indexing until after we measure real usage

Shipped modules:

- `src/memory/`: `memory-schema.ts`, `profile-store.ts`, `profile-renderer.ts`, plus the `src/memory/reflection/` feature folder (`reflection-prompt.ts`, `reflection-grammar.ts`, `reflection-parser.ts`, `reflection-runner.ts`)
- `src/tools/memory/`: `profile-set.ts`, `profile-remove.ts`, `profile-list.ts`
- `src/prompt/build-prompt.ts` — `### profile` injection in the variable tail, profile tokens subtracted from the effective conversation cap in `src/prompt/token-budget.ts`
- `src/prompt/tool-descriptors.ts` + `grammars/tool-call.gbnf` — three profile tools
- `src/config/config-schema.ts` + `src/config/load-config.ts` — `memory.profile.*` and `memory.reflection.*` keys, `paths.memoryDbFile`
- `src/llm/slot-manager.ts` — `reserveReflectionSlot()` for a dedicated reflection slot
- `src/agent/agent-loop.ts` — optional `reflectionRunner` dependency; `abortPending()` at turn start, fire `reflect()` at turn end
- `src/runtime/bootstrap.ts` — instantiates `ProfileStore`, registers memory tools, wires `profileFactsProvider` + `ReflectionRunner` into `AgentLoop`
- `src/telemetry/agent-metrics.ts` — `agent.memory.reflection` counter + latency histogram
- `AGENTS.md` — revised §"Memory fabric" section (single layer + reflection subsection)

Invariants (locked):

- the `### profile` section lives in the variable tail only — the stable prefix is byte-stable across profile edits (pinned by `build-prompt.test.ts`)
- reflection uses its own reserved slot; main agent KV-cache is never touched by reflection (pinned by `slot-manager.test.ts`)
- reflection is never awaited by the loop; its errors are caught by the runner and surface only via logs + metrics
- no embeddings, no TTL, no tags, no redaction in this milestone

Explicitly out of scope for this milestone (deferred to future options or later iterations of this one):

- episodic memory / session summaries (Type 2)
- action-history search over trace files (retracted — see above)
- long-term fact store with TTL / tags / topics (Type 4)
- embeddings / semantic search
- workspace inventories and document indexing
- secret redaction of profile / reflection content

Main risk (as expected):

- scope creep — kept contained by freezing the design at the single-profile layer with async reflection and resisting the urge to add retrieval / topic / TTL layers before real usage demands them

### Option 2a: FTS5 notes memory [shipped]

Additive layer on top of Option 2. Inspired by the ZeroClaw hybrid-memory trait, stripped to a deterministic keyword-only slice:

- **`memories` table + `memories_fts` virtual table** in the same `<stateDir>/memory.sqlite` file that owns `profile_facts`. Bumps `MEMORY_SCHEMA_VERSION` from 1 to 2; migration is idempotent, downgrade-guarded.
- **`MemoryStore`** (new) — freeform content, BM25 ranking via FTS5 (`porter unicode61` tokenizer), hard-cap eviction by `updated_at`. Shares the SQLite connection pattern and `better-sqlite3` discipline with `ProfileStore`.
- **Three new agent tools**: `memory.notes.store`, `memory.notes.recall`, `memory.notes.forget`. Originally write and read were both explicit LLM actions; the notes corpus was never rendered into the prompt. The hybrid-memory increments below relax this for read-only tail injection while keeping the corpus itself out of the prompt.
- **Config keys**: `memory.notes.{enabled,maxEntries,maxContentChars,recallDefaultK}`. `USER_CONFIG_VERSION` bumped to 2 with transparent v1→v2 migration (existing configs load with defaults injected).

### Option 2c: hybrid memory increments (read-side recall + contextual profile + auto-NOTE) [shipped: 2026-04-23]

Shipped as a three-step refinement on top of Option 2 + 2a. Full description in [MEMORY.md](MEMORY.md). Plan: `.cursor/plans/memory_compromise_three_increments_0ea627e7.plan.md`.

- **Increment 0 — reflection writes freeform notes.** Reflection now emits `NOTE body [tags]` lines in addition to `SET key=value`. Capped by `memory.reflection.maxNotesPerCall` (default 2) and gated by `memory.reflection.autoStoreNotes`. Closes the "memory doesn't fill itself unless prodded" gap by making `MemoryStore` self-populating from natural conversation.
- **Increment 1 — automatic recall + memory-index in the tail.** `agent-loop.runTurn` pre-fetches two new tail sections via [src/memory/memory-context-provider.ts](src/memory/memory-context-provider.ts):
  - `### recalled` — top-K BM25 hits against the current `userMessage` (`memory.recallInjection.{enabled,k,previewChars,maxTokens}`).
  - `### memory-index` — compact `#id [tags] preview` pointer rows the agent can drill into via `memory.notes.recall { id }` (`memory.index.{enabled,limit,previewChars,maxTokens}`).
  - Both sections are deduplicated by id and live strictly in the variable tail. `SessionState` gains ephemeral `recalledNotes` / `memoryIndex` fields stripped by `stripEphemeral` before persistence. The notes corpus body is **still** never dumped wholesale — only top-K hits and pointer rows.
- **Increment 3 — contextual profile facts.** `MEMORY_SCHEMA_VERSION` bumped to 3 with two new columns on `profile_facts`: `pinned INTEGER NOT NULL DEFAULT 1` and `keywords TEXT`. `pinned=true` facts always render; `pinned=false` facts only render when at least one keyword hits the current `userMessage` (case-insensitive substring match). Reflection learned a new SET flavour: `SET key=value [pinned=false; keywords=a,b,c]`. Master switch `memory.profile.contextualKeywordGate` (default `true`).

The end result: a hybrid memory system where (a) hot bits surface automatically, (b) warm bits surface as cheap pointers, (c) cold bits are reachable via explicit tool calls, and (d) writes happen autonomously after each turn — all without invalidating the KV-cached stable prefix.

What M2 (Option 2b) would add on top: embeddings for semantic recall, an importance score / decay curve, content-based deduplication of notes, and a two-stage FTS5+vector ranking pipeline. Parked until real notes usage justifies the extra operational surface (second llama-server with `--embedding`, `sqlite-vec`, reciprocal-rank fusion).

## Option 3: LLM reliability policy [done: 2026-04-23]

What it adds:

- retries with bounded backoff for transient LLM failures
- parser recovery for malformed or truncated tool-call output
- clearer error classification between transport, grammar, and model failures

Why it matters:

- improves reliability without changing product scope
- reduces turn-ending failures caused by temporary llama-server issues
- makes smaller local models more usable in practice

Likely modules:

- `src/llm/llama-server-client.ts`
- `src/llm/llama-server-health.ts`
- `src/agent/step-executor.ts`
- `src/agent/agent-loop.ts`

Main risk:

- retries must never replay already-executed tools; they should stay on the LLM side only

Implementation notes (2026-04-23):

- Transport retry with bounded backoff lives in `LlamaServerClient.complete` and the unary pre-body of `completeStream` (`llama.completionRetries`, `llama.completionRetryBackoffMs`), limited to network errors and HTTP 5xx.
- One-shot parser recovery sits in `src/agent/step-executor.ts`: on `ToolCallParseError` the executor replays through the unary LLM path, emits a `parse_retry` step event, and surfaces a typed `GrammarError` if the second attempt still fails.
- Error taxonomy lives in a new feature folder `src/llm/reliability/` — `LlmFailureCategory`, the `LlmFailure` class hierarchy (`TransportError`, `GrammarError`, `ModelError`, `ToolExecutionError`, `CancelledError`), `classifyFailure`, and `detectModelFailure`. The executor wraps any escaping error into an `LlmFailure` before emitting `step_error`; the agent loop classifies at the outer catch and attaches `category` to `loop_failed`.
- `detectModelFailure` short-circuits the parser retry on `truncated` / `empty` / `no_stop` completions so the runtime does not waste an LLM call reproducing the same wall.
- `category` is propagated end-to-end: `step_error` / `loop_failed` events → `trace-recorder` → `AgentMetrics.recordLlmFailure` (`agent.llm.failure`) → TUI event feed label → sidecar protocol (`session_failed.category`, `error.code = step_error:<category>`) → OpenAI SSE (`error.category` for atomic extensions, `error.type = agent.<category>` for OpenAI-compatible clients).
- Tests: `src/llm/reliability/*.test.ts`, new `agent-loop.test.ts` cases (`truncated`, `empty`, persistent grammar failure, missing tool), `telemetry.test.ts` `recordLlmFailure`, `trace-recorder.test.ts` category propagation, `agent-event-reducer.test.ts` feed label. See `AGENTS.md` §"LLM reliability policy" for the full invariant table.

## Option 4: background autonomy [done: 2026-04-24]

What it adds:

- time-based scheduling (`at` / `cron` / `interval`) on top of the Option 5 task queue
- a single in-process `Scheduler` that drains due tasks through the existing `TaskRunner.runDue`
- generic webhook ingress (`POST /api/webhooks/:name`) that materialises as a task — never a direct `runTurn`
- agent-side self-scheduling via `tasks.schedule`, `tasks.cron`, `tasks.list`, `tasks.cancel`, `tasks.show`
- explicit `session.metadata.wakeReason` stamped just before `runTurn` so audit plumbing can distinguish user / scheduler / webhook / agent turns

Why it matters:

- turns the runtime from purely reactive chat into an assistant that can resume work later
- unlocks reminders, periodic sync, watchdog, and trigger-based workflows on top of the durable queue from Option 5
- keeps the concurrency story intact: every background firing still enters the same per-session FIFO via `TurnController`

Shipped modules:

- `src/tasks/` — extended `TaskRecord` with `schedule`, `scheduledFor`, `recurring`, `lastScheduledAt`, `triggerSource`; new `task-schedule.ts` (pure `resolveScheduledFor` / `isRecurring`, backed by `cron-parser`); `TaskStore.listDue` / `requeueRecurring` plus `idx_tasks_due` partial index; `TaskRunner` now supports schedule-aware `create()` (recurring tasks get a persistent session at create time; one-shot tasks stay `session_id = NULL` until the first attempt), wake-reason stamping, recurring requeue at completion, and a scheduler-facing `runDue(now, limit)` drain. Schema migrated to v2 idempotently.
- `src/scheduler/` — new feature folder. Single `Scheduler` class (`start()` / `stop()` / `tickOnce()`) holding the only periodic timer in the runtime; re-entry guarded, errors swallowed + logged + metered.
- `src/http/route-webhooks.ts` + `src/http/webhook-template.ts` + `src/http/webhook-session-store.ts` — generic webhook route keyed off `config.webhooks[name]`, `{{body.<jsonpath>}}` substitution, optional `x-webhook-secret` gate, three `sessionMode`s (`ephemeral` / `persistent` / `named`). Persistent mode stores its `webhookName → sessionId` map in `<stateDir>/webhook-sessions.json`.
- `src/tools/tasks/` — five agent tools, gated by `config.tasks.agentToolsEnabled`. `tasks.schedule` inherits the caller session by default (`newSession: true` opts out); `tasks.cron` always allocates a fresh persistent session so recurring autonomy never contaminates the caller's thread.
- `src/runtime/bootstrap.ts` — wires `Scheduler` (start after `recoverStale`, stop before `taskStore.close`), `WebhookSessionStore`, and the `registerTaskTools` call. `AgentRuntime` now exposes `scheduler: Scheduler | null` and `webhookSessionStore`.
- `src/config/config-schema.ts` + `load-config.ts` — env-only `tasks.schedulerEnabled`, `tasks.schedulerTickMs`, `tasks.schedulerBatch`, `tasks.agentToolsEnabled`, `tasks.minIntervalMs`; `USER_CONFIG_VERSION` bumped 2 → 3 with a transparent migration that defaults `webhooks: {}`.
- `src/cli/task-command.ts` — `task create` gained `--at` / `--cron` / `--every` / `--tz`; `task list` prints `schedule` + `next-run`; new `task tick` subcommand for one-shot scheduler pumps.
- `src/telemetry/agent-metrics.ts` — new counters `agent.tasks.{scheduled,recurring_requeued,session_recreated,session_auto_created}`, `agent.scheduler.{ticks,tick_errors}`, `agent.webhooks.received`, and histograms `agent.scheduler.{batch_size,tick_duration_ms}`.
- `grammars/tool-call.gbnf` + `src/prompt/tool-descriptors.ts` — grammar alternative list and descriptors extended with `tasks.*`.
- `src/session/session-state.ts` — documented reserved `metadata.wakeReason` key.

Locked invariants (pinned by tests):

- `Scheduler` is **the only** new periodic timer in the runtime; `TaskRunner` and every ingress path stay event-driven.
- Webhooks never call `runTurn` directly — they always create a task through `TaskRunner.create`.
- Recurring requeue is atomic: attempts/lastError/startedAt/completedAt reset, `scheduled_for` rearms, **`session_id` never changes** (only auto-recreation on missing session may overwrite it).
- A recurring task owns exactly one persistent session for its full lifetime; no row-per-firing duplication.
- One-shot tasks may carry `session_id = NULL` until the first `runOne` attempt; once written it is stable for that row's lifetime.
- The `scheduled_for` partial index is the only path the scheduler uses — no full-table scans.
- `tasks.enabled=false` disables the entire subsystem: scheduler not started, `POST /api/webhooks/:name` returns 404, agent `tasks.*` tools not registered.
- `cron-parser` is encapsulated behind `task-schedule.ts` — no other module imports it.

Deferred to later milestones:

- distributed scheduler / leader election across processes
- task graphs & dependencies
- per-trigger fairness
- rendering `wakeReason` into the prompt (today it is audit-only metadata)

## Option 5: durable task model [done: 2026-04-24]

What it adds:

- durable `TaskRecord` with `pending | running | completed | failed | blocked | cancelled` states
- retries with exponential capped backoff for deferred `runTurn` submissions, classified through the existing `LlmFailureCategory` taxonomy from Option 3
- explicit `(sessionId, userMessage)` linkage between tasks and sessions, with runtime validation that the session exists (missing session → `blocked` with `session_not_found`)
- CLI (`atomic-agent task list|show|create|cancel|run`) and HTTP admin surfaces (`POST/GET /api/tasks`, `GET/DELETE /api/tasks/:id`, `POST /api/tasks/:id/run`, `POST /api/tasks/drain`)
- `agent.tasks.*` counters and histograms for end-to-end observability of the queue

Why it matters:

- gives structure to deferred work without committing to a workflow engine — one task is exactly one deferred `runTurn`, nothing more
- unblocks Option 4 (background autonomy / cron): the scheduler now has a stable, persistent submission target with at-least-once semantics
- formalises the "operator can re-trigger this turn" affordance that previously existed only as ad-hoc CLI scripting

Shipped modules:

- new feature folder `src/tasks/` — `task-types.ts`, `task-schema.ts` (`TASK_SCHEMA_VERSION = 1`, separate `<stateDir>/tasks.sqlite` file, no cross-file FKs), `task-store.ts` (synchronous `better-sqlite3` CRUD + lifecycle transitions + `recoverStale`), `task-backoff.ts` (pure `nextDelayMs`), `task-runner.ts` (`create` + `runOne` + `drainPending`), `index.ts` named exports, plus colocated `*.test.ts` for store / backoff / runner.
- `src/runtime/bootstrap.ts` — wires `TaskStore` and `TaskRunner` into `AgentRuntime`, calls `taskStore.recoverStale(config.tasks.staleAfterMs)` once on boot, closes the SQLite handle in `shutdown()`.
- `src/config/config-schema.ts` and `src/config/load-config.ts` — new `tasks.*` block (`enabled`, `maxAttempts`, `backoffInitialMs`, `backoffMaxMs`, `runOnCreate`, `staleAfterMs`) + `paths.tasksDbFile`, all env-overridable.
- `src/telemetry/agent-metrics.ts` — `agent.tasks.{created,started,completed,failed,blocked,cancelled,retried}` counters and `agent.tasks.{attempts,duration_ms}` histograms, with `TaskOriginTag` reused by metric tags.
- `src/http/route-tasks.ts` (+ `route-tasks.test.ts`) and `src/http/route-table.ts` — admin routes; all return 404 when `tasks.enabled=false`, mirroring the `memory.profile.enabled` gate from Option 2.
- `src/cli/task-command.ts` (+ `task-command.test.ts`) and `src/cli/index.ts` — CLI subcommands; `list/show/create/cancel` open the `TaskStore` directly for fast one-shot access, `run` boots the full `createAgentRuntime` and tears it down on the way out.
- Documentation: `ARCHITECTURE.md` §4.16 + §10 extension table, `AGENTS.md` "Durable tasks" subsection, `README.md` CLI paragraph.

Locked invariants (pinned by tests):

- task `kind` is implicit — every record is a deferred `runTurn`. The schema does **not** carry a discriminator; new kinds are not part of this milestone (and would require an additive migration).
- task always executes through `runtime.runTurn(..., { origin: "scheduler" })` — never through `executeTurn` (which bypasses the controller). Per-session FIFO + cross-session parallelism are inherited from Option 6.
- retries are turn-level only: `runTurn` is replayed with the same `userMessage`. Step-level retries inside a single `runTurn` remain Option 3's responsibility. **No partial-tool replay.**
- `TaskRunner` never holds a `SessionState` reference between attempts — re-reads via `sessionStore.load(sessionId)` inside the next attempt (same pattern as `src/sidecar/main.ts`).
- `cancel()` is idempotent on already-terminal rows; `recoverStale` is one-shot at bootstrap (no background sweeper).
- `tasks.enabled=false` keeps `TaskStore` constructed (it owns the SQLite handle that must be closed in `shutdown`); `drainPending` becomes a no-op and HTTP routes return 404.

Explicitly out of scope (deferred to Option 4 or later):

- background ticker / cron / `scheduledFor` timestamps
- agent-side `tasks.*` tools (self-scheduling)
- task graphs / dependencies between tasks
- workflow primitives (`kind != "runTurn"`)
- secret redaction inside `userMessage` / `lastError`
- per-session task priorities / fairness across origins

**Option 4 unblocked by this milestone:** the scheduler now has a stable durable-queue contract (`taskRunner.create` + `taskRunner.drainPending`) to attach to without touching the agent-loop or controller invariants. Adding cron / wakeups becomes a thin module that calls `drainPending` on a timer.

## Option 6: runtime isolation and concurrency contract [done: 2026-04-23]

What it adds:

- a documented and enforced policy for concurrent `runTurn` calls
- per-session isolation with explicit FIFO queueing per session
- clearer browser ownership, slot ownership, and reflection ownership rules

Why it matters:

- prevents subtle races when the runtime is embedded in richer hosts
- prepares the core for multiple sessions without hidden shared-state bugs
- gives Option 4 (background autonomy / cron) a stable contract to attach to without breaking browser state, slot ownership, or trace recording

Shipped modules:

- new `src/runtime/turn-controller.ts` (+ `turn-controller.test.ts`) — per-session FIFO queue, per-session event hook map, `isBusy` / `busySessionIds` introspection. Single primitive that every entry point funnels through.
- `src/runtime/bootstrap.ts` — `runtime.runTurn` is now a thin wrapper around `turnController.enqueue(executeTurn)`; `currentRecorder` lives in an `AsyncLocalStorage` keyed by `sessionId`; `runtime.executeTurn` is exposed for callers that already hold the per-session lock (sidecar).
- `src/http/turn-hub.ts` — **deleted**. `src/http/openai-chat-completions.ts` enqueues directly via `runtime.runTurn({ origin: "http", eventHook })`.
- `src/sidecar/main.ts` — `send_message` enqueues through `runtime.turnController.enqueue` and re-reads `active.session` inside the queued callback so two rapid NDJSON messages serialise FIFO without crossing state.
- `src/cli/run-agent.ts`, `src/tui/tui-command.ts` — pass `origin` and (CLI) `eventHook` through the new `runtime.runTurn` API.
- `src/llm/slot-manager.ts` — doc-comment pinning the single-active-turn-per-session invariant to `TurnController` (no internal locking added).
- `src/memory/reflection/reflection-runner.ts` — `pending` is now a `Map<sessionId, AbortController>`; `abortPending({ sessionId })` cancels only the matching session. `src/agent/agent-loop.ts` passes `state.id` so a sibling session's reflection is never aborted by an unrelated turn.

Invariants (locked):

- per-session FIFO, no cross-session serialisation
- no preemption, no priorities — scheduler enqueues like everyone else
- event hook is per-session, set on enqueue and cleared in `finally`
- recorder is per-session, lives behind `AsyncLocalStorage`, never leaks across turns
- `SlotManager` / `ApprovalGate` / recorder safety relies on at most one `runTurn` per session at a time, enforced by `TurnController`
- shared SQLite stores (`ProfileStore`, `MemoryStore`, `SessionStore`) are safe under cross-session parallel access because `better-sqlite3` is synchronous (no race window between read and write inside a single statement)
- `ReflectionRunner` has per-session pending state; reflection on session A is never aborted by reflection on session B

Explicitly out of scope:

- per-session `PlaywrightBackend` / per-session browser context (cross-session browser sharing remains an accepted product constraint)
- preemption, priorities, or fairness between origins
- durable queue (shipped as Option 5 [done: 2026-04-24])
- secret redaction in per-session recorder output

Tests:

- `src/runtime/turn-controller.test.ts` — same-session FIFO, cross-session parallelism, hook isolation, error recovery, signal cancellation, scheduler-behind-user ordering
- `src/http/openai-chat-completions.test.ts` — cross-session HTTP requests do not block each other; same-session HTTP serialises FIFO
- `src/sidecar/send-message-concurrency.test.ts` — two rapid `send_message` calls on the same session serialise without crossing state
- `src/memory/reflection/reflection-runner.test.ts` — same-session re-entry aborts the prior reflection; cross-session reflections never trample each other; `abortPending({ sessionId })` is scope-correct

Documentation:

- `ARCHITECTURE.md` §"Concurrency contract"; mirrored in `AGENTS.md`

## Option 7: traceability and replay [done: 2026-04-23]

Shipped as `src/telemetry/trace/` (append-only NDJSON per session at `<stateDir>/traces/<sessionId>.ndjson`) + `src/replay/` (prompt-drift replay) + `atomic-agent trace list|show|export|replay`. Secret redaction is intentionally deferred — traces are currently sensitive local artefacts.

What it adds:

- append-only execution traces
- replayable step records
- prompt and tool timing diagnostics for postmortems

Why it matters:

- makes regressions easier to debug
- gives a clean foundation for future evaluation and benchmarking
- helps distinguish model failures from runtime and tool failures

Likely modules:

- `src/telemetry/`
- `src/session/`
- `src/runtime/bootstrap.ts`

Main risk:

- traces must be redacted carefully because tool outputs may include secrets or personal data

## Recommended sequence

If the goal is maximum leverage with minimum architectural risk, the best order is:

1. `managed turn memory`
2. `LLM reliability policy`
3. `traceability and replay`
4. `memory fabric (operator-first)`
5. `runtime isolation and concurrency contract`
6. `durable task model`
7. `background autonomy`

Why this order:

- the first three improve the current runtime without changing its product shape
- retrieval becomes much easier once prompt growth and traces are under control
- durable tasks should exist before cron and event-driven autonomy, otherwise background behavior becomes hard to reason about

## Suggested first milestone [done: 2026-04-23]

If only one substantial investment is possible, start with a combined milestone:

- bounded conversation window [done]
- session summary for older turns [done]
- explicit tail truncation markers [done]
- parser retry for malformed tool-call output [done]
- basic LLM retry policy for transient transport failures [done]

This keeps the existing runtime model intact while improving the failure modes users hit first in real work.

Implementation notes (2026-04-23): prompt-time compression lives in `packConversation` (`src/session/conversation-turn.ts`); world / conversation safety-net caps (`agent.worldSnapshotMaxTokens`, `agent.conversationMaxTokens`) are enforced in `buildPrompt` and clamped by `ModelProfile.contextWindow` via `computeEffectiveConversationCap`. Parser retry lives in `src/agent/step-executor.ts` (one-shot unary retry, emits `parse_retry`); transport retry sits in `LlamaServerClient` (`complete` + pre-body of `completeStream`), bounded by `llama.completionRetries` / `llama.completionRetryBackoffMs` and limited to network errors and HTTP 5xx. See `AGENTS.md` §"Current memory model" / §"LLM reliability policy".
