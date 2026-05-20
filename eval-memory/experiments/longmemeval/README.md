# LongMemEval runner (campaign Phase 3)

Drives the **Long-term Interactive Memory Evaluation** benchmark from
[`xiaowu0162/LongMemEval`](https://github.com/xiaowu0162/LongMemEval)
against every campaign memory profile and reports per-axis accuracy +
cost.

## Dataset (not shipped)

Download `longmemeval_s.json` from the upstream repo and place it at:

```
eval-memory/datasets/longmemeval/longmemeval_s.json
```

…or set `ATOMIC_AGENT_LONGMEMEVAL_PATH` to point elsewhere. The
`LongMemEval_S` variant has haystacks ~115K tokens long — the smallest
tier that still stresses long-context recall.

## Five axes (PLAN.md Phase 3)

| Axis | Question types that map here |
|---|---|
| `information_extraction` | `single-session-user`, `single-session-assistant`, `single-session-preference` |
| `multi_session_reasoning` | `multi-session` |
| `temporal_reasoning` | `temporal-reasoning` |
| `knowledge_updates` | `knowledge-update` |
| `abstention` | Any `question_type` whose row carries `is_abstention: true` |

The **knowledge_updates** axis is the bi-temporal `ProfileStore`
acceptance test (phase 4 of MEMORY_FABRIC_V2.md). The **abstention**
axis exposes the anti-hallucination discipline.

## Per-row metrics

| Metric | Meaning |
|---|---|
| `substringMatch` | Naive substring presence of the gold answer in the reply (0/1). |
| `abstainCorrect` | For abstention rows: did the reply say "I don't know" (0/1). For other rows: combines substring match with "did NOT spuriously abstain" (0/1) so a model that always abstains scores zero here. |
| `meanPromptTokens` | Prompt-token average per QA turn. |
| `meanDurationMs` | Wall-clock per QA turn. |
| `meanStepCount` | Steps per QA turn (higher means the agent is wandering). |

## Stop-gate (PLAN.md Phase 3)

`full_v2` must beat `hybrid` on **both** `knowledge_updates` AND
`abstention` by **≥ 3 pp** on `substringAccuracy` / `abstentionAccuracy`
respectively. Otherwise voting + procedures + bi-temporal profile
are not earning their slot in the prompt budget on this dataset.

## Run

```bash
# Default: 20-row smoke across all seven profiles.
npm run eval:memory:longmemeval

# Knowledge-updates-only against the two extreme profiles.
ATOMIC_AGENT_LONGMEMEVAL_AXES=knowledge_updates \
ATOMIC_AGENT_LONGMEMEVAL_PROFILES=fts5_only,full_v2 \
  npm run eval:memory:longmemeval

# Full ~500-row campaign run (hours).
ATOMIC_AGENT_LONGMEMEVAL_MAX_ROWS=10000 \
  npm run eval:memory:longmemeval
```

Outputs land under `eval-memory/reports/run-<ISO>-longmemeval/`:

- `questions.ndjson` — one row per evaluated question.
- `by-axis.csv` — per-profile × per-axis roll-up.
- `summary.md` — operator-readable cheat sheet.
