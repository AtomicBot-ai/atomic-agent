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

### E6 — procedure distill audit (phase 7b specific) [shipped]

**Question:** does `ConsolidatorJob` correctly choose between
distilling a **lesson** (conceptual cluster) vs a **procedure**
(repeated tool-call recipe), and is the resulting procedure body
faithful to the seeded steps?

**Method:** 6 synthetic clusters — 3 procedural (homogeneous tool
sequences like `os.fs.glob → os.fs.grep`), 3 conceptual (heterogeneous
remediation recipes). Each cluster runs through the isolated
`distill-with-procedure-isolated.ts` harness which exercises the
combined lesson + procedure grammar branch. Outputs are graded by
LLM-judge against a fixture rubric.

**Cost:** ~10 minutes per full run.

**Decision boundary:** procedural clusters must produce a `Procedure`
with a non-empty `tool_hints` set that matches the seeded tools (≥80%
hit rate); conceptual clusters must NOT produce a procedure (zero
false positives). Mirror of E4's contract for the lesson branch.

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

### E8 — procedure lifecycle bench (phase 7b, deterministic, no LLM) [shipped]

**Question:** mirror of E7 for the procedure surface — does the
phase-7b lifecycle for procedures (vote-driven deprecation, age-out
sweep, overflow eviction, score-blended recall reranking) behave as
the contract says?

**Method:** 3 deterministic scenarios seeding `procedures` with
varying `(created_at, success_count, vote_score, application_count)`.
`ConsolidatorJob.runOnce()` runs once with a frozen `now`; asserts
on per-procedure final `status` + `(byVote, byAge, byOverflow)` tally
+ `procedureStore.recall(...)` rerank order.

**Cost:** ~1 second total (pure SQL + no LLM).

**Decision boundary:** same as E7 — all precisions = 1.0. Any drop is
a Phase 7b regression, not a tuning question.

### E2E — cross-session scenarios (full v2, LLM in the loop) [shipped]

**Question:** end-to-end, can knowledge formed in session N influence
session N+1 across the full v2 stack — profile facts, lessons,
procedures, bi-temporal supersession, and vote curation?

**Method:** five scenarios, each chaining 2–4 sequential CLI sessions
against a SHARED `<stateDir>` via `multi-session-driver.ts`, with
optional explicit `runConsolidatorTick` injections between sessions.
Reports land in `eval-memory/reports/run-<ISO>/e2e-N-*/`.

| Scenario | What it proves | Mechanism |
|---|---|---|
| **E2E-1** profile recall | A fact stated in S1 lands in `### profile` and is reused in S2 / S3 without re-asking | Reflection writes profile fact end-of-turn; next sessions read it from the tail |
| **E2E-2** lesson application | A lesson distilled from S1's repeated remediation episodes is recalled and applied in S3 | `ConsolidatorJob` between S2 and S3 via `runConsolidatorTick` |
| **E2E-3** procedure follow | A repeated tool-call sequence in S1–S3 yields a `Procedure` that S4 follows on a similar task | Consolidator with `proceduresEnabled=true`; scenario-specific `linkSweepExample` |
| **E2E-4** stale fact (bi-temporal) | A fact corrected in S2 supersedes the S1 row; S3 uses only the new value | `ProfileStore` `superseded_by` chain — readers filter to `IS NULL` |
| **E2E-5** vote cleansing | Explicit user "helpful" / "noise" signals move `vote_score` in both directions | Vote-aware reflection on the shared slot; `votingEnabled=true`; `seed_memories` fixture step |

Two harness helpers are load-bearing for the E2E suite:

- `multi-session-driver.ts` — flat ordered list of steps:
  `{kind: "session" | "consolidate" | "seed_memories"}`. The
  `seed_memories` step writes fixture rows directly into
  `MemoryStore` so the assertion can target a downstream pipeline
  (vote / consolidator) without being gated by reflection variance.
  Canonical use: E2E-5, where the subject of test is vote curation
  rather than memory creation.
- `consolidator-tick.ts` — programmatic `ConsolidatorJob.runOnce()`
  invocation, including the eval-only `link-sweep` step that forces
  `cachePrompt: false` for the `LinkGeneratorRunner` and accepts a
  per-scenario `linkSweepExample` so the prompt's embedded example
  matches the cluster context (e.g. CSV vs `.eslintignore`).

**Cost:** ~3–8 minutes per scenario, ~15 min for the full set.

**Decision boundary:** every scenario's `passed` must be `true`. A
red E2E means the integration story for v2 broke — debug before
shipping.

**Known flake (eval-only, deferred):** E2E-3 passes consistently in
isolation (`npm run eval:memory:e2e -- -t "E2E-3"` ~65s), but fails
deterministically when run inside the full E2E suite after E2E-1/2/4/5
have warmed the reflection slot. The failure mode is a `Procedure`
without `tool_hints` — the distill prompt drifts to a generic
extraction shape under hot-cache bias. This is **not** a production
risk: production sessions don't run 5 unrelated scenario families
back-to-back on the same slot, and distill in production uses
heterogeneous cluster content where the hot-slot bias does not
trigger. Fix (planned, eval-harness only): mirror the existing
`cachePrompt: false` carve-out from link-sweep into the distill call
inside `consolidator-tick.ts`. Until then, run E2E-3 in isolation
when the rest of the suite is also being run.

### v2.5 (memU-inspired additions) — opt-in integration suite [shipped]

Companion to the base v2 suite above. Covers the three opt-in
features from `MEMORY_FABRIC_V2.5_MEMU_ADDITIONS.md`. Wired through a
**separate** entry point (`npm run eval:memory:v25`) so flipping the
v2.5 flags on remains a deliberate operator action — they are
decoupled from the v2 release gate. Each experiment lives under
`eval-memory/experiments/e9..e12/`.

- **E9 — Phase A (query rewriter)** — *isolated harness*, no CLI
  spawn. Drives `createQueryRewriterRunner` directly against the
  live daemon over 8 cases (referential / non-referential gate,
  empty-history short-circuit, 1ms hard timeout, stub-injected
  parser-rejection bodies). Asserts the runner's slot-pinning
  invariant (`slot=-1`) and a soft pass-rate floor. Cheapest of
  the four (~10 s of LLM time on a healthy daemon).
- **E10 — Phase B (reflection segmentation)** — *CLI spawn*, two
  scenarios with identical 6-turn prompt lists. Runs once with
  `segmentation.enabled=false` (legacy: ~6 reflection fires) and
  once with `segmentation.enabled=true, triggerEveryTurns=3` (~2
  cadence-gated fires). Counts `reflection.fired` debug log lines
  in the agent's stderr and asserts a cadence ratio of ≥1.6×. The
  `finish`-flush branch is **not** re-tested here (pinned by
  `agent-loop-segmentation.test.ts`; the CLI exits on stdin EOF,
  not via the agent emitting `finish`).
- **E11 — Phase C (typed notes)** — *CLI spawn*, three
  sub-scenarios:
  1. `typed-roundtrip` — event + behavior prompts produce
     `type:event` and `type:behavior` tags in `memories.tags`.
  2. `forbidden-soft` — 10 trivial one-off action/event prompts.
     Allows up to 30% misfires to the forbidden type (Q2: small
     models are noisy on prompt-encoded forbidden lists).
  3. `legacy-compat` — first session with the flag off (legacy
     untyped notes), second session with the flag on (typed
     notes). Asserts both rows survive in the same `memory.sqlite`
     without schema drift and that S2 added at least one typed
     row.
- **E12 — combined smoke** — *CLI spawn*, single 18-turn session
  with all three flags on. Asserts the integration does not
  explode and that each phase produces at least one observable
  signal (reflection fire, rewriter attempt, type:* tag). This is
  a "did the integration co-exist" check, not a quality bar — the
  scorecard §6 precision claims belong on the operator's
  subjective audit, not on automated CI.

Costs (per run, against a managed 9B chat llama):

| Experiment | LLM time | Notes |
|---|---:|---|
| E9 | ~10 s | Isolated; cases are short prompts on `slot=-1`. |
| E10 | ~5–12 min | 2 sessions × 6 turns × ~15 s/turn. |
| E11 | ~15–25 min | Round-trip + 10 forbidden cases + legacy compat. |
| E12 | ~10–20 min | One 18-turn session, mixed prompts. |

## Run order and gates

Strict-gates ROI ordering — deterministic + cheapest LLM signal first:

1. **E7** (deterministic, ~1 s) → Phase 6/7a lesson lifecycle. If
   lessons aren't deprecating / reranking correctly, nothing
   downstream is trustworthy.
2. **E8** (deterministic, ~1 s) → Phase 7b procedure lifecycle.
   Same category as E7.
3. **E1** (offline, ~5 min) → embeddings question. If negative,
   fix or disable phase 1B before continuing.
4. **E3** (semi-auto, ~30 min + manual) → reflection question. If
   reflection is noisy, fixing prompt / parser comes **before** E2.
5. **E5** (~3 min) → vote-quality question. A red E5 does not block
   E2/E4 but informs whether E2's deltas can be attributed to voting.
6. **E2** (~1–2 h LLM time) → the headline number for "memory ON
   helps the agent".
7. **E4** (~15 min) → phase 5 lesson distillation QA.
8. **E6** (~10 min) → phase 7b procedure distillation QA. Mirror of
   E4 for the procedure branch.
9. **E2E** (~15 min) → cross-session integration story (E2E-1..5).

A red verdict on E7, E8, E2, or E3 is a **stop-go** signal — debug
before shipping further phases. E2E failures are also stop-go: they
prove or disprove the entire v2 integration story.

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
npm run eval:memory:e7                   # lesson lifecycle bench (deterministic, no LLM)
npm run eval:memory:e8                   # procedure lifecycle bench (deterministic, no LLM)
npm run eval:memory:e1                   # recall precision (no LLM)
npm run eval:memory:e1 -- --bm25-only       # offline-only subset
npm run eval:memory:e3                   # reflection audit (LLM + judge)
npm run eval:memory:e5                   # vote decision audit (LLM + judge)
npm run eval:memory:e2                   # paired ON/OFF sessions (LLM + judge)
npm run eval:memory:e4                   # lesson distillation audit (LLM + judge)
npm run eval:memory:e6                   # procedure distillation audit (LLM + judge)
npm run eval:memory:e2e                  # cross-session scenarios (E2E-1..5)
npm run eval:memory:e2e -- -t "E2E-2"    # single E2E scenario
npm run eval:memory:smoke:link-sweep     # link-sweep + cluster + distill smoke
```

Run the **v2.5 (memU-inspired) integration suite** (E9–E12). This is a
separate entry point on purpose — v2.5 features are opt-in and
decoupled from the base v2 release gate (see
[`MEMORY_FABRIC_V2.5_MEMU_ADDITIONS.md`](../MEMORY_FABRIC_V2.5_MEMU_ADDITIONS.md)).

```bash
npm run eval:memory:v25                  # all four v2.5 experiments
npm run eval:memory:e9                   # Phase A — query rewriter (isolated, fast)
npm run eval:memory:e10                  # Phase B — reflection segmentation cadence
npm run eval:memory:e11                  # Phase C — typed NOTE extraction round-trip
npm run eval:memory:e12                  # all-three-on combined smoke
```

The v2.5 suite is intentionally NOT wired into `npm run eval:memory`
so flipping the new flags on stays a deliberate operator action.

v2.5 decision-boundary env knobs (all optional):
- `ATOMIC_AGENT_E9_MIN_OUTCOME_MATCH` (default `0.75`)
- `ATOMIC_AGENT_E9_MIN_PASS_RATE` (default `0.7`)
- `ATOMIC_AGENT_E10_MIN_CADENCE_RATIO` (default `1.6`)
- `ATOMIC_AGENT_E11_MAX_FORBIDDEN_SHARE` (default `0.3`)

Run the full campaign (E7 → E8 → E1 → E3 → E5 → E2 → E4 → E6 → E2E):

```bash
npm run eval:memory                      # full sweep, exits non-zero on red verdicts
npm run eval:memory -- --skip e2,e4         # partial sweep
npm run eval:memory -- --skip e2e           # skip the cross-session suite
```

Reports land in `eval-memory/reports/run-<ISO>/`.

## Out of scope (deferred)

- **Real-world journal** — multi-day memory drift / consolidation
  observation. Needs operator commitment, not scriptable.
- **Cross-model comparison** — same scenarios across different chat
  models. Useful but expensive; defer until E2 produces a stable
  baseline.
- **Concurrency / parallel sessions** — E2 sequential is enough for
  v0; per-session memory isolation is already pinned by unit tests.
