# LoCoMo runner (campaign Phase 2)

Drives the **Long Conversational Memory** benchmark from
[`snap-research/locomo`](https://github.com/snap-research/locomo)
against every campaign memory profile and writes per-category
accuracy + cost tables.

## Dataset (not shipped)

Download `locomo10.json` from the upstream repo and place it at:

```
eval-memory/datasets/locomo/locomo10.json
```

…or set `ATOMIC_AGENT_LOCOMO_PATH` to point elsewhere. The file is
~30 MB and licensed for non-commercial research; it is intentionally
not committed.

## What it measures

| Category id | Label | What the question asks |
|---|---|---|
| 1 | `single_hop` | Fact present in **one** earlier session |
| 2 | `multi_hop` | Needs evidence from ≥ 2 sessions |
| 3 | `temporal` | "When" / "how long" / ordering questions |
| 4 | `open_domain` | World-knowledge fusion |
| 5 | `adversarial` | Gold answer is "I don't know" |

Per `(profile, category)` cell the runner reports:

- `substringAccuracy` — naive substring match (cheap baseline).
- `abstentionAccuracy` — for adversarial questions, the share of
  replies that hit an "I don't know" pattern; for non-adversarial,
  this equals `substringAccuracy` (the agent did not falsely abstain).
- `meanPromptTokens`, `meanDurationMs`, `meanStepCount` — cost +
  latency per QA turn.

The substring metric is intentionally cheap. The full campaign
report grades the same NDJSON output with the LLM judge (1..5 scale,
same rubric as the existing E2 / E3 / E4 specs); see
`scripts/run-locomo.mjs` for how the orchestrator chains both passes
together. **Until that judge pass is added in Phase 5 alongside the
competitor adapters**, the substring score is what `summary.md`
reports — operator-readable and good enough for first-cut profile
ordering.

## Stop-gate (PLAN.md Phase 2)

`hybrid_plus_graph` must beat `fts5_only` on `multi_hop` by **≥ 5 pp**
on substring accuracy. Failing that, the link-graph layer is either
inert on this dataset or the runner has a bug — investigate before
ranking deeper profiles.

## Run

Single-conversation smoke (default, ~5–10 min):

```bash
npm run eval:memory:locomo
```

Full 10-conversation run (hours):

```bash
ATOMIC_AGENT_LOCOMO_MAX_CONVS=10 npm run eval:memory:locomo
```

Subset of profiles:

```bash
ATOMIC_AGENT_LOCOMO_PROFILES=fts5_only,hybrid,hybrid_plus_graph \
  npm run eval:memory:locomo
```

Outputs land under `eval-memory/reports/run-<ISO>-locomo/`:

- `questions.ndjson` — one row per evaluated question.
- `by-category.csv` — per-profile-per-category roll-up.
- `summary.md` — operator-readable cheat sheet.

## Notes

- The runner feeds each LoCoMo `session_N` as **one** user prompt so
  the memory layer has N legitimate chances to extract facts. The QA
  phase then runs in the **same** session so the agent's accumulated
  memory is what answers the question.
- `full_v2` legitimately needs reflection drain between prompts —
  the spec injects `interPromptDrainMs: 1500` and a longer final
  drain so end-of-conversation reflections commit before QA starts.
- The orchestrator is at `eval-memory/scripts/run-locomo.mjs`. It
  brings the managed daemon up, sets `ATOMIC_AGENT_EVAL_LLAMA_URL`,
  and forwards to vitest.
