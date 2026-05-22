# E2 — paired multi-turn sessions (ON vs OFF)

**Status:** shipped (judge-bound, heaviest experiment).

**Cost:** ~10-20 min of llama-server time **per scenario** × 2 sides;
4 scenarios → roughly 60-120 min wall clock + 1 judge call per side
per scenario (≈ 8 OpenRouter calls per run).

## What this proves

The end-to-end product question: **does the memory ON profile
actually answer better than the v1 baseline?** All of E1, E3, E4
prove individual mechanisms work in isolation — E2 is the
gross-revenue test: does turning the whole thing on make the agent
visibly better at multi-turn recall?

## Method

For each scenario:

1. Spin up **two** isolated runtimes: one with the memory ON profile
   (all v2 phases enabled), one with the v1 baseline. Same model,
   same llama-server, fresh `<stateDir>` per side, fresh
   `<workingDir>` per side.
2. Drive each runtime through the scenario's prompts via the public
   `atomic-agent run` CLI (real subprocess, stdin/stdout, traces).
   The driver pipes N prompts separated by `\n` and closes stdin —
   the agent's readline reader processes them sequentially.
3. After the run, parse the trace ndjson to reconstruct per-turn
   metrics (`assistant_reply` content, tool calls, prompt tokens,
   parse retries, step count, failure category).
4. Read both sides' `memory.sqlite` for a "what stuck" summary
   (profile facts, notes, lessons, links).
5. Send the **scored turn's** reply on each side to the same judge
   with the same rubric → `(onScore, offScore)`.
6. Aggregate: mean delta, win rate, regression count, mean
   tool / token deltas.

## Decision boundaries (env-tunable)

| Metric | Default | Env var |
|---|---|---|
| `meanScoreDelta ≥ …` | 0.40 | `ATOMIC_AGENT_E2_MIN_SCORE_DELTA` |
| `(winsOn + ties) / total ≥ …` | 0.50 | `ATOMIC_AGENT_E2_MIN_WIN_RATE` |
| `regressions ≤ …` | 1 | `ATOMIC_AGENT_E2_MAX_REGRESSIONS` |
| Per-scenario wall-clock cap | 6 min | `ATOMIC_AGENT_E2_SCENARIO_TIMEOUT_MS` |
| Per-turn step cap | 30 | `ATOMIC_AGENT_E2_MAX_STEPS_PER_TURN` |

A "regression" is a scenario where the OFF profile beats the ON
profile by ≥ 1 point — that means memory is **hurting** the agent on
that scenario, which is more interesting than it failing to help.

## Output

`eval-memory/reports/<timestamp>/e2/`:

- `e2-results.jsonl` — `aggregate` + per-`scenario` events with both
  replies, both scores, both judge reasons, and the metric deltas.
- `e2-scenarios.csv` — flat per-scenario scoreboard.
- `e2-summary.md` — operator-facing table.

## Caveats

- **Same model both sides.** E2 isolates the memory delta, not the
  model. If the underlying model is too small to follow rubrics, both
  sides score low and the delta is noisy. Re-run with a stronger
  model when this is the case.
- **Scenarios are small.** 4 scenarios × 3-4 turns each gives a noisy
  win-rate estimate. Treat E2 outcomes as **directional**, not
  statistically rigorous. Expand the corpus before turning this into
  a gate.
- **Browser disabled.** E2 does not exercise browser tools so as not
  to fight Playwright over a shared profile across sides. The
  scenarios are pure-language tasks by design.

## Running

```bash
# requires OPENROUTER_API_KEY in env (or eval-memory/.env)
npm run eval:memory:e2
```
