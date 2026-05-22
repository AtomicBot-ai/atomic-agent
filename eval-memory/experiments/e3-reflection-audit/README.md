# E3 — reflection signal-to-noise audit

**Status:** shipped (judge-bound).

**Cost:** ~5-15 min of llama-server time + 1 OpenRouter call per
extracted entry (≤ 8 cases × ≤ 6 entries ≈ 30-50 judge calls per run).

## What this proves

That the **fraction** of reflection writes that are useful is high
enough to justify the prompt-tail real estate they consume. The fear
is "reflection is poisoning memory faster than it improves it" — E3
puts a number on it.

## Method

For each curated `(userMessage, assistantReply)` pair:

1. Build the reflection prompt with `buildReflectionPrompt`.
2. Call the chat llama with `REFLECTION_GRAMMAR` (no store side effects).
3. Parse the output via `parseReflectionOutput` → list of SET / NOTE / EVOLVE.
4. For each entry, send a per-pair rubric to the LLM-judge
   (OpenRouter, default `openai/gpt-4o-mini`) and capture a 1..5 score.
5. Aggregate: `usefulnessRate = P(score ≥ 4)`, `wrongnessRate = P(score ≤ 1)`,
   `noneCorrectness = P(NONE | expects_none)`, `meanScore`.

## Decision boundaries (env-tunable)

| Floor / ceiling | Default | Env var |
|---|---|---|
| `usefulnessRate ≥ …` | 0.60 | `ATOMIC_AGENT_E3_MIN_USEFULNESS` |
| `wrongnessRate ≤ …` | 0.10 | `ATOMIC_AGENT_E3_MAX_WRONGNESS` |
| `noneCorrectness ≥ …` | 0.50 | `ATOMIC_AGENT_E3_MIN_NONE_CORRECTNESS` |

A failure of E3 is **not** a stop-the-line event for the campaign —
the runner continues to E2 / E4 — but it predicts noise downstream
and should be fixed by tightening the reflection prompt / grammar
before the next promotion.

## Output

`eval-memory/reports/<timestamp>/e3/`:

- `e3-results.jsonl` — append-only event log (`aggregate`, `case`, `entry`).
- `e3-entries.csv` — flat table of every graded entry.
- `e3-summary.md` — operator-facing summary with per-case table.

## What this does NOT prove

- That the SET/NOTE entries are actually **useful in retrieval** — E2
  covers that.
- That reflection is well-calibrated across long real sessions — the
  dataset is curated to be discriminative, not representative of a
  real session's distribution.

## Running

```bash
# requires OPENROUTER_API_KEY in env (or eval-memory/.env)
npm run eval:memory:e3
```
