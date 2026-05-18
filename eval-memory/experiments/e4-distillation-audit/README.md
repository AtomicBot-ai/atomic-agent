# E4 — distillation quality audit

**Status:** shipped (judge-bound).

**Cost:** ~5-10 min of llama-server time + 3 judge calls per cluster
(4 clusters × 3 axes ≈ 12 judge calls per run).

## What this proves

That the **consolidator's distill prompt produces useful lessons** on
clusters that have an obvious operator-authored "right answer". The
fear is "distill emits vague platitudes that look fine in isolation
but never get retrieved for anything actionable".

## Method

For each cluster (3-5 hand-crafted episode memories + a gold lesson):

1. Seed a fresh `MemoryStore` with the episodes (id numbering
   matters because the distill prompt references `#id`).
2. Build the distill prompt with `buildDistillPrompt`.
3. Call the chat llama with `DISTILL_GRAMMAR`.
4. Parse with `parseDistillOutput` → `{activation, principle, tags}`.
5. Judge on three axes vs the gold:
   - **activation** — does the produced activation trigger on the
     same conditions?
   - **principle** — does the produced principle capture the same
     actionable insight?
   - **coverage** — does the lesson as a whole match the gold's
     scope and specificity?
6. `meanScore = avg(activation, principle, coverage)`.

The store / lesson-store is **not** touched by E4 — we only measure
the LLM's distill output, not the consolidator's bookkeeping.

## Decision boundaries (env-tunable)

| Floor / ceiling | Default | Env var |
|---|---|---|
| `usefulLessonsRate ≥ …` | 0.60 | `ATOMIC_AGENT_E4_MIN_USEFUL_RATE` |
| `wrongLessonsRate ≤ …` | 0.15 | `ATOMIC_AGENT_E4_MAX_WRONG_RATE` |
| `meanLessonScore ≥ …` | 3.00 | `ATOMIC_AGENT_E4_MIN_MEAN_SCORE` |

"Useful" = `meanScore ≥ 4` OR all three axes ≥ 3 (the consolidator
got every axis at least "partially correct").
"Wrong" = any axis ≤ 1 (consolidator invented or contradicted).

## Output

`eval-memory/reports/<timestamp>/e4/`:

- `e4-results.jsonl` — `aggregate`, `cluster`, `axis` events.
- `e4-clusters.csv` — per-cluster scoreboard.
- `e4-summary.md` — operator-facing table.

## What this does NOT prove

- That the consolidator **picks** the right clusters to distill —
  clustering is a separate concern (currently a function of recall +
  link-graph, see Phase 2). E4 takes the clusters as given.
- That a distilled lesson **actually fires** during a real session —
  E2 covers that for one or two scenarios; full lesson-deprecation
  health is deferred.

## Running

```bash
# requires OPENROUTER_API_KEY in env (or eval-memory/.env)
npm run eval:memory:e4
```
