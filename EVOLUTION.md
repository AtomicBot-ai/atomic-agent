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
- **Three new agent tools**: `memory.notes.store`, `memory.notes.recall`, `memory.notes.forget`. Write and read are both explicit LLM actions — the notes corpus is NEVER rendered into the prompt and therefore never invalidates the KV-cached stable prefix. `scope` defaults to `"all"` (cross-project); the caller passes `scope: "project"` to narrow to the current `workingDir`.
- **No changes** to `build-prompt.ts`, `step-executor.ts`, or the reflection runner — reflection still writes only to `profile_facts`.
- **Config keys**: `memory.notes.{enabled,maxEntries,maxContentChars,recallDefaultK}`. `USER_CONFIG_VERSION` bumped to 2 with transparent v1→v2 migration (existing configs load with defaults injected).

What M2 (Option 2b) would add on top: embeddings for semantic recall, an importance score / decay curve, and a two-stage FTS5+vector ranking pipeline. Parked until real notes usage justifies the extra operational surface (second llama-server with `--embedding`, `sqlite-vec`, reciprocal-rank fusion).

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

## Option 4: background autonomy

What it adds:

- cron-style wakeups
- scheduled follow-ups
- webhook or event-driven ingress
- explicit wake reasons in session metadata

Why it matters:

- turns the runtime from purely reactive chat into an assistant that can resume work later
- opens reminders, periodic sync, watchdog, and trigger-based workflows

Likely modules:

- new feature folders such as `src/scheduler/` and `src/events/`
- `src/runtime/bootstrap.ts`
- `src/session/session-state.ts`
- `src/http/` and `src/sidecar/` for ingress surfaces

Main risk:

- this changes the product model more than the other options; it needs a durable task abstraction, not just timers

## Option 5: durable task model

What it adds:

- task records with states such as pending, scheduled, blocked, running, completed, failed
- retries and backoff for deferred work
- explicit linkage between tasks and sessions

Why it matters:

- gives structure to long-running autonomous behavior
- provides a foundation for reminders, cron, follow-up delivery, and resumable work

Likely modules:

- a new feature folder such as `src/tasks/`
- `src/session/`
- `src/runtime/bootstrap.ts`
- `src/http/` admin routes

Main risk:

- it introduces workflow semantics that do not exist today; start with a minimal durable queue before adding rich orchestration

## Option 6: runtime isolation and concurrency contract

What it adds:

- a documented and enforced policy for concurrent `runTurn` calls
- either per-session isolation or explicit queueing
- clearer browser ownership and slot ownership rules

Why it matters:

- prevents subtle races when the runtime is embedded in richer hosts
- prepares the core for multiple sessions without hidden shared-state bugs

Likely modules:

- `src/runtime/bootstrap.ts`
- `src/http/turn-hub.ts`
- `src/sidecar/main.ts`
- `src/llm/slot-manager.ts`

Main risk:

- naive parallelism can break browser state, approvals, and cache reuse guarantees

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
