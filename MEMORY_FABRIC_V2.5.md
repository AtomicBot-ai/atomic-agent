# atomic-agent — memory fabric v2.5

> **Status:** implemented (phases A–C in `src/memory/retrieve/` and reflection
> paths). All three features are **opt-in** (`default: false` in config v18+).
> Runtime behaviour is documented in [`AGENTS.md`](AGENTS.md) §"Memory v2.5";
> v2 baseline remains [`MEMORY_FABRIC_V2.md`](MEMORY_FABRIC_V2.md).
>
> **Automated checks:** `npm run lint && npm test`; v2.5 integration experiments
> E9–E12 in [`eval-memory/PLAN.md`](eval-memory/PLAN.md) (`npm run eval:memory:v25`).

## Table of contents

1. [Implementation ledger](#1-implementation-ledger)
2. [Phase A — heuristic-gated query rewriter](#2-phase-a--heuristic-gated-query-rewriter)
3. [Phase B — sliding-window reflection segmentation](#3-phase-b--sliding-window-reflection-segmentation)
4. [Phase C — typed NOTE extraction](#4-phase-c--typed-note-extraction)
5. [Evaluation](#5-evaluation)
6. [Out of scope](#6-out-of-scope)

---

## 1. Implementation ledger

| Phase | Flag | Module | Tests |
|-------|------|--------|-------|
| **A** | `memory.retrieve.rewriter.enabled` | [`src/memory/retrieve/`](src/memory/retrieve/) | `referential-detector.test.ts`, `query-rewriter-*.test.ts`, `rewriter-aware-recall-provider.test.ts` |
| **B** | `memory.reflection.segmentation.enabled` | [`agent-loop.ts`](src/agent/agent-loop.ts), [`reflection-prompt.ts`](src/memory/reflection/reflection-prompt.ts) | `agent-loop-segmentation.test.ts`, `reflection-prompt.test.ts` |
| **C** | `memory.reflection.typedNotes.enabled` | [`reflection-grammar.ts`](src/memory/reflection/reflection-grammar.ts), [`reflection-parser.ts`](src/memory/reflection/reflection-parser.ts), [`reflection-prompt.ts`](src/memory/reflection/reflection-prompt.ts) | `reflection-grammar.test.ts`, `reflection-parser.test.ts`, `reflection-prompt.test.ts` |

**Config keys (v18+):**

- `memory.retrieve.rewriter.{enabled, timeoutMs, historyTurns}` — defaults `false`, `3000`, `3`.
- `memory.reflection.segmentation.{enabled, triggerEveryTurns, windowTurns}` — defaults `false`, `3`, `5`.
- `memory.reflection.typedNotes.enabled` — default `false`.

**Composition:** Phases are independent. Enabling C swaps the reflection stable
prefix to `REFLECTION_STABLE_PREFIX_TYPED` (one-time reflection-slot KV-cache
invalidation). B only changes the reflection **tail** (transcript window). A wraps
recall with `slotId: -1` and never touches agent or reflection slots.

---

## 2. Phase A — heuristic-gated query rewriter

**Problem:** BM25 recall on the raw user message fails on short referential
follow-ups ("and what about there?", "did they mention it?").

**Approach:** Before `MemoryStore.recallHybridAsync`, run a single LLM call
**only** when `isReferentialMessage()` is true and `recentTurns.length > 0`.
The rewriter expands the message using the last K user/assistant pairs; on any
failure, timeout, or `NONE` token, the **raw** user message is used.

**Heuristic gate** ([`referential-detector.ts`](src/memory/retrieve/referential-detector.ts)):

- ≤ 5 words without a leading question word, **or**
- contains a bilingual pronoun allowlist, **or**
- starts with a conjunction (`and`, `but`, `а`, `и`, …).

**Decorator:** [`rewriter-aware-recall-provider.ts`](src/memory/retrieve/rewriter-aware-recall-provider.ts)
wraps `createDefaultMemoryContextProvider`. With `enabled=false`, recall is
byte-identical to v2.

**Metrics:** `agent.memory.retrieve.rewriter` (outcomes:
`ok | skipped_not_referential | skipped_no_history | aborted | timeout | failed`),
`agent.memory.retrieve.rewriter.duration_ms`.

---

## 3. Phase B — sliding-window reflection segmentation

**Problem:** Per-turn reflection after every `reply` is costly and fragments
context across tool-heavy turns.

**Approach:** When enabled, reflection fires on `reply` only when
`turnCount % triggerEveryTurns === 0`, packing the last `windowTurns` complete
user/assistant pairs into `ReflectionInput.transcript`. On `finish`, reflection
**always** fires (final flush) so the trailing partial window is not lost.

**Pair projection:** `collectLastUserAssistantPairs` pairs each `user` turn with
the next `assistant_reply`; tool steps are skipped. Orphan trailing `user` rows
are dropped.

**Prompt tail** (when `transcript` is set):

```text
### turn 1
USER: ...
ASSISTANT: ...
### turn 2
...
### output
```

Disabled → legacy single-pair tail; byte-stable with v2.

---

## 4. Phase C — typed NOTE extraction

**Problem:** Untagged freeform notes make consolidator clustering noisier.

**Approach:** Optional `[type=X]` marker on `NOTE` lines (`X ∈ event | behavior |
knowledge | skill`). Parser projects to synthetic tag `type:X` on `memories.tags`
(JSON) — **no schema migration**. FTS5 indexes the tag; use
`memory.notes.recall { query: "type:event" }` for filtered recall.

**Grammar:** `typemark` is optional so legacy untyped NOTE lines still validate.

**Prompts:**

- `REFLECTION_STABLE_PREFIX` — v2 untyped (default when C off).
- `REFLECTION_STABLE_PREFIX_TYPED` — per-type guidance + forbidden lists when C on.

**Per-type contracts:**

| Type | Store | Never store |
|------|-------|-------------|
| `event` | Specific happening, time, participants | Recurring routines |
| `behavior` | Recurring pattern or routine | One-off events |
| `knowledge` | Static facts, definitions, domain lore | Events, behaviors |
| `skill` | Replicable how-to with tools/steps | Trivial one-offs, pure opinions |

---

## 5. Evaluation

Three slots (same model as v2):

| Slot | Question | Automation |
|------|----------|------------|
| 1. Engineering | Regressions? | `npm test` + lint |
| 2. Spec | Matches AGENTS invariants? | Colocated `*.test.ts` |
| 3. Product | Useful to the operator? | Scenarios below + [`eval-memory/PLAN.md`](eval-memory/PLAN.md) E9–E12 |

Before enabling any v2.5 flag, run v2 cross-cutting checks with the flag **off**
([`MEMORY_FABRIC_V2.md`](MEMORY_FABRIC_V2.md) §0, §9, §14).

Status legend: `[ ]` pending · `[x]` pass · `[!]` fail · `[~]` partial

### 5.1 Cross-cutting (v2.5)

| # | Assertion | How to verify | Pass |
|---|-----------|---------------|------|
| 5.1.1 | Rewriter off → recall byte-identical to v2 | Diff `prompt_captured.tail` on non-referential turns | `[ ]` |
| 5.1.2 | Segmentation off → one reflection per `reply`, no `transcript` | Count `agent.memory.reflection` vs user turns | `[ ]` |
| 5.1.3 | Typed notes off → `REFLECTION_STABLE_PREFIX` hash matches v2 | Reflection slot `stablePrefixHash` | `[ ]` |
| 5.1.4 | Rewriter uses `slotId: -1` always | Unit test + trace spot-check | `[ ]` |
| 5.1.5 | Rewriter timeout/parser failure → raw query, recall still runs | `timeoutMs: 1` fixture | `[ ]` |
| 5.1.6 | `finish` on empty session skips reflection (B) | Slash `/finish` on new session | `[ ]` |

### 5.2 Phase A scenarios

**Flag:** `memory.retrieve.rewriter.enabled`.

| # | Assertion | Pass |
|---|-----------|------|
| 5.2.1 | Non-referential follow-up → `skipped_not_referential`, no rewriter LLM call | `[ ]` |
| 5.2.2 | Referential follow-up → `outcome=ok`, rewriter trace with `slotId: -1` | `[ ]` |
| 5.2.3 | Rewritten recall query includes anchor terms from prior turns | `[ ]` |
| 5.2.4 | Rewriter p95 ≤ 100 ms (cold `slotId=-1` acceptable) | `[ ]` |
| 5.2.5 | Rewriter fires on ≤ 15% of turns in a long session | `[ ]` |

**Automated:** `npm run eval:memory:e9`.

### 5.3 Phase B scenarios

**Flag:** `memory.reflection.segmentation.enabled` (defaults `triggerEveryTurns: 3`,
`windowTurns: 5`).

| # | Assertion | Pass |
|---|-----------|------|
| 5.3.1 | Six `reply` turns → exactly two reflection fires (turns 3 and 6) | `[ ]` |
| 5.3.2 | Each fire's transcript has trailing pairs in `### turn N` order | `[ ]` |
| 5.3.3 | `finish` mid-cadence still flushes reflection | `[ ]` |
| 5.3.4 | Reflection call count drops ≥ 60% vs off-mode on 30-turn session | `[ ]` |
| 5.3.5 | Cross-session cadence isolated | `[x]` (pinned test) |

**Automated:** `npm run eval:memory:e10`.

### 5.4 Phase C scenarios

**Flag:** `memory.reflection.typedNotes.enabled`.

| # | Assertion | Pass |
|---|-----------|------|
| 5.4.1 | Event-like turn → `type:event` in `memories.tags` | `[ ]` |
| 5.4.2 | Behavior-like turn → `type:behavior` tag | `[ ]` |
| 5.4.3 | `memory.notes.recall { query: "type:event" }` returns typed row | `[ ]` |
| 5.4.4 | Legacy untyped rows still parse and recall after flag flip | `[x]` (pinned test) |
| 5.4.5 | Typed tags survive consolidator `archiveInto` on parents | `[ ]` |

**Automated:** `npm run eval:memory:e11`.

### 5.5 Combined smoke (A + B + C on)

| # | Assertion | Pass |
|---|-----------|------|
| 5.5.1 | v2 §9 invariants still green with all three flags on | `[ ]` |
| 5.5.2 | Rewriter ≤ 15% of turns; reflection ≤ 35% with default cadence | `[ ]` |
| 5.5.3 | At least one referential recall uplift + one multi-turn typed extraction | `[ ]` |
| 5.5.4 | Final `finish` flush captures last partial window | `[ ]` |

**Automated:** `npm run eval:memory:e12` or `npm run eval:memory:v25`.

---

## 6. Out of scope

- LLM-driven topic segmentation / judger gates on reflection (counter + final
  flush only).
- Persisting pending-window state outside `SessionState.turns[]`.
- Cross-session reflection cadence aggregation.
- `memory.notes.recall { type: "event" }` shorthand (use FTS5 `type:event` query).
- Automatic re-typing of legacy untyped rows.
- `context` column on `memories` (tags-only typing).
