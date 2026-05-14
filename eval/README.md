# atomic-agent — eval harness

End-to-end behaviour evals for `atomic-agent`. Each case spawns a real
`atomic-agent run` subprocess in an isolated temp `--cwd` and temp
`ATOMIC_AGENT_STATE_DIR`, feeds one user prompt over stdin, then asserts
on:

- the assistant reply (regex)
- the resulting filesystem (file existence / content)
- the session trace (which tools were invoked, with what status)

Per-case temp directories are wiped after each run so a long suite does
not litter `/tmp`.

## Why a separate suite

This corpus is **not** part of `npm test`. Unit tests must stay fast and
hermetic; evals talk to an external `llama-server`, take many seconds per
case, and are inherently noisy. Mixing them would force every developer
to run a model server before every commit.

## Layout

```
eval/
  .env.example            template for eval-local env vars (copy → .env)
  cases/                  one .case.ts per scenario, plus index.ts
  fixtures/skills/        skill bodies copied into per-case stateDir
  harness/                runner, trace parser, mock HTTP, judge client
  scripts/                standalone CLIs (judge-from-jsonl)
  reports/                CSV + JSONL + vitest JSON output (gitignored)
  cases.eval.ts           vitest spec: discovers cases, runs them, writes CSV+JSONL
  vitest.config.ts        separate config (fileParallelism: false)
  tsconfig.json           extends repo tsconfig, includes eval/
```

## Running

One-time setup:

```bash
cp eval/.env.example eval/.env
# edit eval/.env: set ATOMIC_AGENT_EVAL_LLAMA_URL + OPENROUTER_API_KEY
```

The harness loads `eval/.env` via Node's built-in `process.loadEnvFile`
at the top of every run — no `dotenv` dependency. Variables already set
in the shell win over the file (CI-friendly).

Day-to-day:

```bash
npm run eval                # full suite (inline judge for `judge` expectations)
npm run eval:judge          # re-score the latest JSONL with the configured judge
npm run eval:lint           # tsc --noEmit over eval/
```

### Why `ATOMIC_AGENT_EVAL_LLAMA_URL` matters

Each case spawns the agent with a fresh temp `ATOMIC_AGENT_STATE_DIR`.
Without `ATOMIC_AGENT_EVAL_LLAMA_URL` the agent falls back to the user
config default (`http://127.0.0.1:8080`) and every case times out on
the llama health-check (≈16s). Set this to the URL your llama-server
actually listens on.

Three report artefacts appear per run:

- `eval/reports/run-<ISO-timestamp>.csv` — one row per case with the
  stable additive schema (see `harness/append-report-row.ts`).
- `eval/reports/run-<ISO-timestamp>.jsonl` — full per-case record:
  prompt, full reply, expectations (with rubric source), metrics, and
  judge verdicts. This is the input for `npm run eval:judge`.
- `eval/reports/last-run.json` — vitest JSON reporter output, useful
  for feeding into a dashboard.

## LLM-as-judge

Open-ended cases (e.g. summarisation, structural description) cannot be
asserted with regex. They use `kind: "judge"` expectations: the harness
sends the prompt, the agent's reply, and a per-case rubric to a judge
model and treats `score >= threshold` (default `4` on a 1..5 scale) as
pass.

The judge speaks OpenAI-compatible `/v1/chat/completions`. **Default
provider is [OpenRouter](https://openrouter.ai)** with
`openai/gpt-4o-mini` — a small, consistent judge that is meaningfully
stronger than the local 7–9B agent. This removes the "same model grades
its own homework" bias.

Minimum setup:

```bash
export OPENROUTER_API_KEY=sk-or-v1-...
npm run eval
```

Without an API key on a remote base URL the harness prints a one-line
explanation to stderr and fails every `judge` expectation with
`judge unavailable`. Non-judge expectations still run — you get an
honest signal instead of a silently-green corpus.

Configuration via env vars (all optional unless noted):

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | unset (**required for the default URL**) | Bearer token for OpenRouter. Takes priority over `ATOMIC_AGENT_JUDGE_API_KEY`. |
| `ATOMIC_AGENT_JUDGE_URL` | `https://openrouter.ai/api/v1` | OpenAI-compatible base URL. Accepts short (`http://host:port`), `/v1`-suffixed, or fully-qualified `/chat/completions` forms. |
| `ATOMIC_AGENT_JUDGE_MODEL` | `openai/gpt-4o-mini` | Model slug. Try `anthropic/claude-3.5-haiku` for stricter rubric adherence, or `google/gemini-2.0-flash-001` for cost-sensitive runs. |
| `ATOMIC_AGENT_JUDGE_API_KEY` | unset | Legacy bearer token. Falls back to this when `OPENROUTER_API_KEY` is unset. |
| `ATOMIC_AGENT_JUDGE_TIMEOUT_MS` | `30000` | Per-call timeout. |
| `ATOMIC_AGENT_JUDGE_REFERER` | repo URL | Sent as `HTTP-Referer` (OpenRouter attribution). |
| `ATOMIC_AGENT_JUDGE_TITLE` | `atomic-agent eval` | Sent as `X-Title` (OpenRouter attribution). |
| `ATOMIC_AGENT_JUDGE_DISABLED` | unset | Set to `1` to skip every judge expectation silently (CI without key). |

### Using a local llama-server instead

```bash
export ATOMIC_AGENT_JUDGE_URL=http://127.0.0.1:8080
# no API key needed; localhost hosts are exempt from the key requirement
npm run eval
```

Remember: a 7–9B local model scoring its own replies is a weak judge.
Keep rubrics terse and binary-ish, or switch back to OpenRouter for
signal.

### Re-scoring without re-running the agent

`npm run eval:judge` reads the most recent `*.jsonl` from `reports/`
and re-scores every `judge` expectation with the currently-configured
judge. Output: `<run>.judge.csv` next to the source JSONL with one row
per verdict. Useful for A/B-testing a new rubric or a stronger judge
without paying for another agent run.

```bash
# default: latest jsonl
npm run eval:judge

# explicit input + custom output
npm run eval:judge -- --run eval/reports/run-2026-04-23.jsonl --out /tmp/aurora.csv
```

## Adding a case

1. Create `eval/cases/<id>.case.ts` exporting an `EvalCase` with a
   stable `id`, a category (`os` / `skill` / `http` / `coding` / `debug`), the user `prompt`,
   optional `setup`, and a list of `expectations`.
2. Append the named export to `eval/cases/index.ts`.
3. Run `npm run eval:lint` to typecheck.

Keep prompts short and unambiguous: a 7–9B model has a narrow attention
budget. If a case needs a prerequisite (mock HTTP, fixture skill), tag
it via `requires: ["mock-http"]` so the runner can skip cleanly when the
prerequisite is missing.

## Interpreting results

A case **passes** iff every expectation matched, the subprocess exited
0, and it did not time out. A failed expectation is not the end of the
world — partial credit is visible in the CSV's `failures` column. Use
that to spot regressions per category before the absolute pass-rate
moves.

For agent-quality work, compare the trace-derived columns as well:
`steps`, `parse_retries`, `tool_errors`, `batch_count`, `max_batch_size`,
`prompt_tokens`, and `predicted_tokens`. They separate "wrong final
answer" from planner churn, tool-call brittleness, and missed batching.

## Limitations

- No retry / `Pass@k` yet: each case runs exactly once. Add retries via
  vitest's `retry` option in `vitest.config.ts` if you want stochastic
  reliability metrics later.
- No browser cases: the corpus is restricted to OS / skill / HTTP /
  coding / debug for the first iteration. Browser cases need a headless
  Chrome + a fixed local site fixture; left for the second pass.
- Judge bias: with the default OpenRouter judge this is mitigated, but
  the judge is still a single model. For high-stakes regressions
  cross-check by swapping `ATOMIC_AGENT_JUDGE_MODEL` between two
  different providers (e.g. `openai/gpt-4o-mini` and
  `anthropic/claude-3.5-haiku`) and comparing pass-rates.
