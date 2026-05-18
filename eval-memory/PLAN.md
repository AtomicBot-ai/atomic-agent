# atomic-agent — memory fabric v2 evaluation campaign

> **Status:** active campaign post-phase-5 (lessons + consolidator landed).
> Companion to [`MEMORY_FABRIC_V2.md`](../MEMORY_FABRIC_V2.md) (the design plan)
> and [`MEMORY_FABRIC_V2_SCORECARD.md`](../MEMORY_FABRIC_V2_SCORECARD.md)
> (the human-in-the-loop scorecard). This document covers **slot 3** of the
> scorecard — "is memory actually useful" — with reproducible scripts.

## Why this lives in `eval-memory/` and not `eval/`

`eval/` was built for **per-task one-turn** evaluation: every case spawns
a fresh agent with a fresh `stateDir`, feeds one user message, asserts on
the reply / filesystem / trace. That harness deliberately wipes the
state between cases.

Memory evaluation needs the **opposite** axis:

- Multi-turn sessions with **shared** `stateDir` so memory accumulates.
- **Paired runs** (memory ON vs memory OFF) with identical prompts.
- Direct inspection of `memory.sqlite` after the session (rows / counts /
  utilities), not just the visible reply.
- Synthetic-corpus retrieval-precision experiments that bypass the agent
  entirely and call `MemoryStore` / `recallHybridAsync` directly.

Keeping these in a sibling folder avoids contaminating `eval/`'s
hermetic "one prompt → one CSV row" contract.

## Memory ON vs OFF profiles

| Flag | OFF (control) | ON (treatment) |
|---|---|---|
| `memory.eviction.utilityWeighted` | `false` (FIFO by `updated_at`) | `true` |
| `memory.dedup.enabled` | `false` | `true` |
| `memory.embeddings.enabled` | `false` | `true` (requires daemon) |
| `memory.links.enabled` | `false` | `true` |
| `memory.links.autoGenerate` | n/a | `true` |
| `memory.evolution.enabled` | `false` | `true` |
| `memory.lessons.enabled` | `false` | `true` |
| `memory.consolidation.enabled` | `false` | `true` |
| `memory.reflection.enabled` | `true` (legacy v1) | `true` (same — both run reflection; OFF is just v1-shape memory) |

The "OFF" profile is **not** "no memory" — that would compare against a
straw man. It is **v1 memory** (profile facts + FTS5-only notes +
reflection, no embeddings / links / lessons / evolution). The "ON"
profile is **v2 memory with all phases 1–5 enabled**. The delta is
strictly what v2 adds.

## Experiment campaign

Each experiment lives under `experiments/<id>/` with:

- `corpus.ts` / `queries.ts` / `scenarios.ts` — seeded test data.
- `runner.ts` — the actual measurement logic.
- `*.eval.ts` — vitest spec that invokes the runner.
- `README.md` — what this experiment proves, what it does not.

Reports land in `eval-memory/reports/run-<ISO>/` (gitignored).

### E1 — recall precision micro-benchmark (offline, no LLM) [shipped]

**Question:** does hybrid recall (BM25 + embeddings) beat BM25-only at
finding the right cluster across paraphrased queries? Does link
expansion add precision or just noise?

**Method:** 10 semantic clusters × 20 notes per cluster = 200 seeded
memories. 50 paraphrased queries (5 per cluster). For each query in
each mode (`bm25-only`, `hybrid`, `hybrid+links`), compute precision@5,
recall@5, MRR. Output: mode × cluster matrix.

**Cost:** ~5 minutes to run (no LLM round-trips except embedding
generation; if the embedding daemon is not running, `hybrid` / `hybrid+links`
modes are skipped with a clear note in the report).

**Decision boundary:** if hybrid does not beat BM25 by ≥ 5 pp in P@5,
flip `memory.embeddings.enabled` default to `false` and re-cost
phase 1B. If link expansion **drops** precision, raise an issue —
phase 2 is hurting recall, not helping.

### E2 — paired multi-turn session benchmark (with LLM) [shipped]

**Question:** does the agent perform **better** on tasks where past
context is relevant, when memory is ON vs OFF?

**Method:** 15–20 multi-turn scenarios (4–8 turns each). Each scenario
establishes a fact in early turns and **requires** the fact in late
turns. Each scenario runs twice: ON profile vs OFF profile, fresh
`stateDir` per run. Metrics: tool-call count, reply correctness
(LLM-judge), latency, prompt tokens, parse retries.

**Cost:** ~1–2 hours per full run (depends on llama-server speed).

**Decision boundary:** ON should beat OFF on correctness OR tie on
correctness with **fewer tool calls / lower tokens**. Otherwise memory
is overhead without value.

### E3 — reflection signal-to-noise audit [shipped]

**Question:** what fraction of reflection writes are **useful**,
**trivia**, or **wrong**?

**Method:** 30 real user-turn pairs (from existing `traces/` or
synthetic). For each, run reflection in isolation against a freshly
seeded profile + memory store. Capture extracted SET / NOTE / EVOLVE.
Two grading paths:

1. **LLM-judge auto-grading** with rubric "useful / trivia / wrong"
   per item.
2. **Operator hand-sampling** of 20 % of the dataset to validate the
   judge.

**Cost:** ~30 minutes to run + manual sampling time.

**Decision boundary:** ≥ 60 % useful AND ≤ 10 % wrong. Anything worse
means reflection is poisoning the memory faster than it improves it.

### E4 — distillation quality audit (phase 5 specific) [shipped]

**Question:** does `ConsolidatorJob` produce coherent lessons, or are
they overgeneralised garbage?

**Method:** 8–12 synthetic clusters (3–5 linked episodes each, with a
known "correct" lesson). Run `ConsolidatorJob.runOnce()` against each.
Score the resulting `lesson.activation` + `lesson.principle` against
the gold lesson via LLM-judge (with operator sampling).

**Cost:** ~15 minutes to run + sampling time.

**Decision boundary:** ≥ 60 % "useful or close to gold", ≤ 15 %
"wrong" (contradicts gold). Otherwise the consolidator prompt /
grammar needs tuning before phase 6 ships.

### E5 — vote decision audit (phase 7a specific) [shipped]

**Question:** when the runtime surfaces a set of `lessons` / `memories`
/ `profile` items to a turn, does the vote sub-call cast votes that
correctly reflect which ones helped vs which ones were noise?

**Method:** 8 hand-written cases — each is a single `(user, assistant)`
exchange + a surfaced candidate set + per-candidate gold labels
(`helpful` / `noise` / `neutral`). Run the vote sub-call in isolation
via `runIsolatedVote` (LLM + GBNF + parser, no `VoteStore` writes).
Classify each produced vote against the gold (`correct_upvote`,
`correct_downvote`, `correct_abstain`, `missed_signal`,
`false_upvote`, `false_downvote`); judge each decision 1..5.

**Cost:** ~3 minutes (one llama-server completion per case + judge).

**Decision boundary:** `correctness ≥ 0.60`, `falseVoteRate ≤ 0.20`,
`missedSignalRate ≤ 0.50`. Permissive on purpose — voting is a new
9B sub-call and the design contract is "drag noise down over many
turns", not "perfect first-shot". Allowlist breaches must be **0** —
that's the load-bearing invariant 18 guard, not a soft target.

### E7 — lesson lifecycle bench (phase 6 + 7a, deterministic, no LLM) [shipped]

**Question:** do the age-out sweep, vote-driven deprecation, and
score-blended recall reranking actually behave the way Phase 6 + 7a
contracts say they do?

**Method:** 5 deterministic scenarios. Each seeds a fresh
`memory.sqlite` with lessons of varying `(created_at, success_count,
vote_score)`, runs `ConsolidatorJob.runOnce()` once with a frozen
`now`, and asserts:

1. Per-lesson final `status` matches the expected map.
2. The `(byVote, byAge, byOverflow)` count tuple matches the gold
   tally so we pin not just *what* was deprecated but *why*.
3. When the scenario carries a `rerank` block, `lessonStore.recall(...)`
   under `scoreBlend` returns the expected top-K order.

**Cost:** ~1 second total (pure SQL + no LLM).

**Decision boundary:** all three precisions = 1.0 by default. This
is an architectural-correctness bench — any drop is a Phase 6/7a
regression worth investigating, not a tuning question.

## Run order and gates

Strict-gates ROI ordering — deterministic + cheapest LLM signal first:

1. **E7** (deterministic, ~1 s) → answers the Phase 6/7a lifecycle
   question. If lessons aren't deprecating / reranking correctly,
   nothing downstream is trustworthy.
2. **E1** (offline, ~5 min) → answers the embeddings question. If
   negative, fix or disable phase 1B before continuing.
3. **E3** (semi-auto, ~30 min + manual) → answers the reflection
   question. If reflection is noisy, fixing prompt / parser comes
   **before** E2 — otherwise we'd measure the noise, not the
   feature.
4. **E5** (~3 min) → answers the vote-quality question. A red E5
   does not block E2/E4 (vote curation is emergent over many turns)
   but informs whether E2's deltas can be attributed to voting.
5. **E2** (~1–2 h LLM time) → the headline number. Pass / fail signal
   for "memory ON helps the agent".
6. **E4** (~15 min) → phase 5 internal QA.

A red verdict on E7, E2, or E3 is a **stop-go** signal — debug before
shipping further phases.

## Running

One-time setup:

```bash
cp eval-memory/.env.example eval-memory/.env
# fill in OPENROUTER_API_KEY (for E2/E3/E4 judges)
# ATOMIC_AGENT_EVAL_LLAMA_URL is optional — scripts can bring up the
# managed daemon themselves via `atomic-agent models start`.
```

Run a single experiment:

```bash
npm run eval:memory:e7                   # lifecycle bench (deterministic, no LLM)
npm run eval:memory:e1                   # recall precision (no LLM)
npm run eval:memory:e1 -- --bm25-only       # offline-only subset
npm run eval:memory:e3                   # reflection audit (LLM + judge)
npm run eval:memory:e5                   # vote decision audit (LLM + judge)
npm run eval:memory:e2                   # paired ON/OFF sessions (LLM + judge)
npm run eval:memory:e4                   # distillation audit (LLM + judge)
```

Run the full campaign (E7 → E1 → E3 → E5 → E2 → E4):

```bash
npm run eval:memory                      # full sweep, exits non-zero on red verdicts
npm run eval:memory -- --skip e2,e4         # partial sweep
```

Reports land in `eval-memory/reports/run-<ISO>/`.

## Out of scope (deferred)

- **Phase 7b evals** — wait until that phase lands. The harness
  shape will accommodate them.
- **Real-world journal** — multi-day memory drift / consolidation
  observation. Needs operator commitment, not scriptable.
- **Cross-model comparison** — same scenarios across different chat
  models. Useful but expensive; defer until E2 produces a stable
  baseline.
- **Concurrency / parallel sessions** — E2 sequential is enough for
  v0; per-session memory isolation is already pinned by unit tests.
