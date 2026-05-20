# E14 — noise resistance

> **Status:** scaffold. The deterministic core (corpus generator,
> recall measurement) is wired; the runner and `.eval.ts` spec are
> not. The README documents what the experiment proves and how to
> finish it. Phase 4 stop-gate ("`full_v2` shows a delta on ≥ 4 / 10
> categories") does not require this to land before reporting; the
> existing E1 paraphrase coverage already exercises hybrid retrieval.

## Question

When the `memory.sqlite` store contains 1000 unrelated noise rows,
does the **correct** memory still surface in the top-K of a recall
query?

This is the failure mode `none` / `fts5_only` are most exposed to:
BM25 is great when the corpus is small and the gold answer's
keywords are rare. As the corpus grows, common keywords get re-used
and the BM25 signal becomes washed out. Hybrid recall (FTS5 +
embeddings) is supposed to be more robust because the cosine signal
on the gold answer's *meaning* survives the keyword overlap.

## Method

1. Seed the corpus with **5 gold notes** about distinct topics
   (`async-js`, `sql-opt`, `clean-arch`, `prompt-eng`, `sqlite-ops`).
2. Generate **1000 noise notes** with realistic-shaped text on
   unrelated topics (LLM-style filler + random keyword bag). The
   generator is pure and seeded so two runs produce byte-identical
   corpora.
3. Run **20 paraphrased queries** (4 per gold topic) under each
   campaign profile.
4. Metric: `P@5` on each query. Aggregate: per-profile mean.

## Expected

| profile | meanP@5 |
|---|---|
| `none` | undefined — memory off, no recall path |
| `fts5_only` | starts to slide vs the small-corpus E1 numbers (estimate ≥ 0.4 → ~0.25) |
| `vector_only` | reasonable; cosine doesn't degrade with noise (estimate ~0.55) |
| `hybrid` | stays close to the small-corpus E1 numbers (estimate ~0.65) |
| `hybrid_plus_lessons` | same as `hybrid` (consolidator does not affect recall ranking on raw notes) |
| `full_v2` | same as `hybrid_plus_lessons` |

## Implementation TODO

- `corpus.ts` — gold notes + deterministic noise generator (seeded
  Mulberry32 PRNG + a few thousand topical tokens).
- `queries.ts` — 20 paraphrased queries with `goldClusterId`.
- `runner.ts` — open `MemoryStore` (+ optional embeddings), seed,
  run queries per mode, compute P@5 / R@5 / MRR. Same shape as the
  existing `e1-recall-precision/runner.ts`.
- `noise-resistance.eval.ts` — vitest spec that iterates over each
  campaign profile, builds the config inline, opens the store with
  the matching feature flags, and writes `summary.md` in the unified
  format consumed by `scripts/aggregate-atomic-eval.mjs`.
- `scripts/run-e14.mjs` — orchestrator, mirrors `run-e1.mjs`.

This experiment is deterministic (no LLM round-trips for recall —
only when embeddings are enabled, the embedding daemon's `/embedding`
endpoint is involved), so once the runner lands the full sweep is
~10 minutes wall time.
