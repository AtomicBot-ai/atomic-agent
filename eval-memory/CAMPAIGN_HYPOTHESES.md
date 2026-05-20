# Memory Fabric v2 — pre-registered campaign hypotheses (DRAFT)

> **Status: DRAFT — pending magos approval before the first scored run.**
> Once approved, this document is **frozen** for the campaign: commit
> the final version to git, capture its SHA in
> `eval-memory/reports/environment-lock.json`, and reference that SHA in
> every published number. Post-hoc edits invalidate the pre-registration
> and must trigger a fresh campaign run.

## Purpose

This document fixes — _before_ any scored run — the predictions the
benchmark is meant to test. It exists to:

1. Defend against p-hacking ("we ran 20 things, here are the 3 that
   worked").
2. Make confirmations and rejections symmetric — a rejected prediction
   is a real result, not a quietly dropped slide.
3. Give external reviewers a fixed yardstick.

## Scope

- **Benchmark:** LoCoMo (`eval-memory/datasets/locomo/locomo10.json`,
  10 conversations × 272 sessions × 1986 questions, 5 categories).
- **Profiles compared in this round:** `none` (no memory layer),
  `full_v2` (everything on). Optional: `hybrid` (vector + BM25 without
  graph + lessons).
- **Coverage:** _to be filled in before run_ — either FULL corpus or a
  seed-pinned stratified subset (record the exact fraction + seed +
  generated dataset path here).
- **Chat backend:** `qwen-3.6-35b-a3b` (chat) + `bge-base-en-v1.5`
  (embeddings), both managed by the agent's `models` CLI.
- **Sampling knobs:** as locked in `CAMPAIGN_SAMPLING` (temperature 0.2,
  top_p 0.95, top_k 40, seed 0xa70a1c).
- **Judge:** `openai/gpt-5.4-mini` via OpenRouter (one judge for the
  whole campaign; subset is re-graded by an alt judge for inter-judge
  agreement — see H8 below).
- **Statistical model:** mean ± 95% bootstrap CI on per-question scores
  (within a single run) and on per-run means (across N runs when N ≥ 3).
  Sample CI computed by `eval-memory/harness/bootstrap-ci.ts`.

## Decision rules

For every hypothesis below:

- **Confirmed** ⇔ the predicted direction holds AND the 95% bootstrap
  CI on the relevant Δ excludes zero in the predicted direction.
- **Rejected** ⇔ the 95% CI excludes zero in the _opposite_ direction.
- **Inconclusive** ⇔ the CI straddles zero. Inconclusive results are
  published as inconclusive — not silently demoted.

Per-category samples below ~30 questions are inherently wide-CI; treat
those as exploratory unless N ≥ 3 runs collapse the noise.

## Hypotheses

### Recall quality vs. `none` baseline

**H1 — overall judge score.** `full_v2` will score ≥ **0.50 points
higher** on the 1..5 LLM-judge scale than `none`, averaged across all
non-adversarial categories (1..4), with 95% CI on the Δ excluding zero.

**H2 — single-hop recall.** On category 1 (`single_hop`), `full_v2`
will reach a mean judge score ≥ **3.8**. `none` will stay below **3.0**.
The Δ is the largest of any non-adversarial category.

**H3 — multi-hop recall.** On category 2 (`multi_hop`), `full_v2` will
beat `none` by ≥ **0.6 points** on the judge scale. This is the
category most sensitive to graph + lesson layers; under-performance
here invalidates the v2 thesis even if H1 is confirmed.

### Abstention

**H4 — adversarial abstention.** On category 5 (`adversarial`),
`full_v2` `abstainCorrect` will be ≥ **0.70**, and the Δ vs `none` will
be **non-negative** with CI excluding the "memory hurts abstention"
direction. We explicitly predict memory does NOT make the agent more
confident-wrong on questions whose gold answer is "I don't know".

### Cost

**H5 — prompt-token cost.** `full_v2` p95 prompt tokens per question
will stay within **3×** the `none` baseline p95 across all categories.
If this fails, the memory layer is paying more than its recall gain is
worth on the published model.

**H6 — wall-clock cost.** `full_v2` p95 latency per question will stay
within **5×** the `none` baseline p95. This is a soft ceiling — the
reflection / consolidation slot is genuinely additional work — but
beyond 5× the layer's product story breaks.

### Negative predictions (these would invalidate the v2 thesis)

**H7 — temporal floor.** On category 3 (`temporal`, n=96 in the full
corpus), if `full_v2` mean judge score is **below** `none` by more than
0.3 points with CI excluding zero, the temporal-reasoning story in
MEMORY_FABRIC_V2.md is wrong as deployed and must be revisited
before any external claim about "temporal" is made.

### Methodology

**H8 — inter-judge agreement.** On a 50-item seed-pinned subset
re-graded by an alt judge (e.g. `openai/gpt-5.5` or
`anthropic/claude-3.5-haiku`), the primary judge will reach Cohen's
quadratic-weighted κ ≥ **0.6** vs the alt. If κ < 0.6, the campaign
numbers are reported as "judge-dependent" and must include the alt
score side-by-side.

## What is explicitly NOT being claimed in this round

- Parity / superiority vs Mem0, Zep, LangMem — those competitor
  adapters are out of scope for this round; the campaign produces a
  standalone baseline that can later be compared to published numbers
  once an adapter lands.
- Generalisation beyond LoCoMo — no claim about LongMemEval or any
  other corpus until those runs are scored under the same protocol.
- Statistical significance below the configured CI level (95%) — we do
  not report p-values or multiple-comparison corrections in this round;
  add them in a follow-up if reviewer pressure demands.

## Anti-hypotheses (we'd be surprised, but the protocol must accept them)

- `full_v2` underperforms `none` on `open_domain` (category 4) — would
  suggest the recall layer is pulling noise into the context.
- Latency p95 on `single_hop` exceeds 60 seconds — would suggest the
  reflection slot is being saturated by trivial questions.

## Sign-off

- **Drafted by:** _(magos pending)_
- **Approved on:** _(date)_
- **Frozen at git SHA:** _(filled by `lock-environment.ts` before the
  first scored run)_
- **Coverage decision (FULL or stratified subset path):** _(filled
  before first run)_
- **Number of runs N:** _(filled before first run; 1 ≤ N ≤ 3 typical)_
