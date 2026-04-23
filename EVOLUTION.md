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

## Option 2: workspace memory and retrieval

What it adds:

- workspace inventories and artifact indexing
- summaries for frequently used local resources
- retrieval slices injected into the prompt tail
- optional embeddings later, but not required in the first iteration

Why it matters:

- gives the runtime durable memory of the local operating context instead of only the current chat
- improves large-workspace behavior without expanding the stable prefix
- reduces repeated blind exploration of files, documents, and local resources

Likely modules:

- a new feature folder such as `src/retrieval/` or `src/memory/`
- `src/prompt/build-prompt.ts`
- `src/session/session-state.ts`
- `src/tools/os/fs-grep.ts`, `src/tools/os/fs-list.ts`, and `src/tools/os/read-document/` for bootstrapping sources

Main risk:

- scope creep is easy here; start with deterministic workspace summaries and keyword retrieval before semantic layers

## Option 3: LLM reliability policy

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
4. `workspace memory and retrieval`
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
