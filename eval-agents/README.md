# eval-agents — multi-agent GAIA benchmark

Compare **atomic-agent**, **Hermes**, and **OpenClaw** on the same local chat
model (default campaign: `gemma-4-26b-a4b`) using the public **GAIA**
validation split. Scoring uses the official GAIA `question_scorer`
normalization (exact match).

## Prerequisites

- `npm run build` (eval spawns `dist/cli/index.js` for atomic-agent).
- Managed llama daemons **or** `ATOMIC_AGENT_EVAL_LLAMA_URL`.
- For atomic-agent memory fabric: embedding daemon on port `19092` (started
  by `atomic-agent models start` when an embedding model is configured).
- Competitors: `hermes` and `openclaw` on `PATH` (skipped automatically when
  missing).
- Full GAIA (not smoke): `HF_TOKEN` + `npm run eval:agents:datasets`.

```bash
cp eval-agents/.env.example eval-agents/.env
# edit tokens / URLs
```

## Running

Unit tests (scoring + parsing, no LLM):

```bash
npm run eval:agents:lint
npx vitest run --config eval-agents/vitest.config.ts eval-agents/harness
```

Smoke (committed fixtures, all agents):

```bash
npm run eval:agents:smoke
```

GAIA validation Level 1 (real dataset):

```bash
npm run eval:agents:datasets   # once
npm run eval:agents:level1
```

Filter agents:

```bash
ATOMIC_AGENT_EVAL_AGENTS=atomic-agent npm run eval:agents:smoke
```

Scorecard:

```bash
npm run eval:agents:scorecard
```

## Reports

Each run writes `eval-agents/reports/run-<ISO>/`:

- `matrix.csv` / `matrix.jsonl` — per (agent × question) row
- `environment.json` — pinned model, sampling, git SHA

## Methodology

- **Chat model**: shared `llama-server` URL for all agents.
- **atomic-agent**: memory fabric **on** (chat + embedding daemons when available).
- **Hermes / OpenClaw**: stock CLI, local OpenAI-compatible endpoint.
- **Prompt**: GAIA prefix + `FINAL ANSWER:` convention; scorer is deterministic.
- **Hermetic smoke**: `datasets/gaia/fixtures/smoke-level1.json` (no HF leak).

See [docs/PHASE0-COMPATIBILITY.md](docs/PHASE0-COMPATIBILITY.md) for research
notes and known risks.
