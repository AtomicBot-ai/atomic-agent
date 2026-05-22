# E15 — bounded growth

> **Status:** scaffold. Documents the contract; runner not yet
> implemented. The contract is the load-bearing assertion — once the
> runner lands it just measures.

## Question

After 1000 fired reflection turns, do the prompt-tail token count
and the SQLite file size stay within configured budgets?

The v2 invariant is "memory grows but the prompt does not". This
experiment is the regression net for that invariant — if either
number drifts upward over the course of a long session, an eviction
path is broken.

## Method

1. Open a single agent session under `full_v2`.
2. Feed 1000 turns of synthetic user messages. Each message contains
   a distinct fact ("user N likes color X") to give the reflection
   layer something to extract.
3. Every 100 turns, snapshot:
   - `<stateDir>/memory.sqlite` byte size.
   - `tail` section token count from the most recent
     `prompt_captured` trace event (sum of `### profile` +
     `### recalled` + `### memory-index` + `### lessons`).
4. Metric: max(byte size), max(tail tokens) over the run, plus the
   slope of each over time (bytes / 100 turns; tokens / 100 turns).
5. Expected: tail tokens stable around the configured caps; SQLite
   size grows linearly until eviction kicks in, then plateaus.

## Stop-gate

- `max(tail_tokens) ≤ sum(memory.{profile.maxTokens,
  recallInjection.maxTokens, index.maxTokens, lessons.maxTokens})`
  + 10% margin.
- `max(sqlite_bytes) ≤ 2 × (memory.notes.maxEntries × 1024)` —
  a generous upper bound on per-row average byte cost.

## Implementation TODO

- `scenario.ts` — synthetic prompt generator (deterministic, seeded).
- `runner.ts` — drives the session via `runCampaignScenario`, polls
  the trace + sqlite file every K turns.
- `bounded-growth.eval.ts` — vitest spec.
- `scripts/run-e15.mjs` — orchestrator.

This is the longest-wall-clock atomic experiment (~1 hour for 1000
turns on a managed daemon). The runner produces the per-100-turn
snapshots as CSV so the operator can chart growth even when the
single-number stop-gates pass.
