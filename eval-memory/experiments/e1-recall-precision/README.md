# E1 — recall precision micro-benchmark

**Cost:** ~5 minutes offline (no chat LLM). Embedding daemon optional —
if absent, `hybrid` and `hybrid+links` modes are skipped with a clear
note in the report.

**Decision boundary:** see [`../../PLAN.md` § E1](../../PLAN.md).

## What this proves

That hybrid recall (BM25 + cosine) beats BM25-only on paraphrased
queries against a labelled cluster corpus, AND that link expansion
(phase 2) does not degrade precision.

## What this does NOT prove

- That **agent performance** is better with hybrid recall — that is E2.
- That the corpus generalises to real user data — synthetic clusters
  are intentionally clean; production reflection writes are noisier.

## Method

- **Corpus.** 10 semantic clusters × 20 notes per cluster = 200
  memories. Each cluster has its own topic vocabulary so BM25 has a
  reasonable shot at the **exact** vocabulary used in any single note,
  but paraphrased queries deliberately use synonyms / structural
  variants. See `corpus.ts`.
- **Queries.** 50 paraphrased queries (5 per cluster). Each query is
  labelled with its target `cluster_id`. A "hit" is any returned
  memory belonging to the target cluster. See `queries.ts`.
- **Modes.** Each query is run in up to three modes:
  - `bm25-only` — `MemoryStore.recall(query, { k: 5 })`. Always run.
  - `hybrid` — `MemoryStore.recallHybridAsync(query, { k: 5 })` with
    embeddings wired. Requires the embedding daemon.
  - `hybrid+links` — hybrid recall then `LinkStore.expand()` to widen
    by one hop. The merged result is sliced back to top-K=5.
- **Metrics per (mode × query).** P@5, R@5, MRR. Aggregated per
  cluster and globally.
- **Synthetic links.** For `hybrid+links` mode the seeder writes
  intra-cluster `related` edges (notes 0↔1, 2↔3, … in each cluster) so
  there is a real graph to walk. No edges cross cluster boundaries —
  graph expansion can only ever pull **more correct answers**, never
  spurious ones. This is by design: it lets us cleanly separate "does
  the expansion machinery work" from "does the link-generator produce
  good edges" (the latter is part of E2/E3).

## Output

Per run (`eval-memory/reports/run-<ISO>/e1/`):

- `e1-summary.md` — operator readout (P@5/R@5/MRR per mode, deltas).
- `e1-results.csv` — one row per (mode × query): hits, precision,
  recall, MRR, top-5 returned ids.
- `e1-results.jsonl` — JSONL mirror of the CSV with the raw entries
  for spot-checking.
- `e1-config.json` — the resolved config (daemon url, hybrid weights,
  thresholds asserted) so re-runs are reproducible.
