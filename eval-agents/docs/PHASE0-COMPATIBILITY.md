# Phase 0 — compatibility research

## GAIA dataset access

| Item | Status |
|------|--------|
| HF repo | `gaia-benchmark/GAIA` (gated) |
| Validation answers | Public in `2023/validation/metadata.jsonl` |
| Test answers | Private — use validation only for local scoring |
| Download | `npm run eval:agents:datasets` (`huggingface-cli` + `HF_TOKEN`) |
| Smoke without HF | `datasets/gaia/fixtures/smoke-level1.json` |

**Leak risk:** validation gold answers are on Hugging Face. We never inject
gold into agent prompts; scoring happens offline in the harness.

## Dual-daemon (atomic-agent)

| Daemon | Role | Default port |
|--------|------|--------------|
| Chat | All three agents | `19091` (managed) |
| Embedding | atomic-agent hybrid memory | `19092` |

Orchestrators reuse [eval-memory/scripts/_lib.mjs](../scripts/_lib.mjs) pattern:
`atomic-agent models start` brings up both when configured; embedding probe is
best-effort (FTS5-only fallback).

## Agent headless surfaces

| Agent | Invocation | Requirements |
|-------|------------|--------------|
| atomic-agent | `atomic-agent run --no-approval` + stdin | Built CLI; memory via `seedConfigJson("on")` |
| Hermes | `hermes run --message ... --cwd ...` | `HERMES_CLI` on PATH; `HERMES_LLM_BASE_URL` or shared chat URL |
| OpenClaw | `openclaw agent --message ...` | `OPENCLAW_CLI` on PATH; `OPENCLAW_WORKSPACE` = case cwd |

**Caveat:** Hermes/OpenClaw CLI flags may differ by version. Adapters document
env overrides; smoke skips missing binaries instead of failing the matrix.

## Answer extraction

Agents must end with `FINAL ANSWER: <value>`. Harness uses
[extract-answer.ts](../harness/extract-answer.ts) with GAIA
[score-gaia.ts](../harness/score-gaia.ts) (port of leaderboard `scorer.py`).

## Non-hermetic runs

Real GAIA questions may require live web access. Record `environment.json`
`capturedAt` and treat web-dependent items as variable across dates.

## Multimodal attachments

Initial matrix filters to text-friendly fixtures. Full HF rows with audio/video
may need vision tooling — run with `ATOMIC_AGENT_GAIA_LIMIT` while validating
tool coverage.
