# Release exam

Before a release, the agent solves a fixed set of 28 typical tasks on a real
local model, and the result is compared with the previous release: how many
it solved, how long it took, how many steps and tokens it used. It exists to
catch "the agent got dumber", which unit tests do not see.

- `exam-cases.json` lists the cases and why each one is in the exam.
- `run-exam.ts` runs them through the harness in `eval/harness`.
- `compare-exam.mjs` compares two results.

The harness itself is unchanged. This has not been run yet, so treat the first
run as a test of the exam itself.

## Running it on a Mac with 32 GB

`eval/` has no default model: it uses whatever server
`ATOMIC_AGENT_EVAL_LLAMA_URL` points at. The exam uses **Gemma 4 26B-A4B**
(`gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf`, catalog id `gemma-4-26b-a4b`), the
default of the `eval-agents` campaign. It fits in 32 GB. The catalog's default,
`qwen-3.5-4b`, is meant for 8 GB machines and is likely to fail the harder
cases, which would hide regressions in them.

Keep the model and its server flags the same from release to release.

```bash
# 1. Build the commit under test. The exam refuses a stale dist/.
npm run build

# 2. Start a plain llama-server in another terminal. Flags are a starting point.
llama-server -m /path/to/gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf --port 18991 -c 65536 --parallel 1 --jinja

# 3. Run the exam. Results go to eval/reports/exam/ unless --out-dir is given.
ATOMIC_AGENT_EVAL_LLAMA_URL=http://127.0.0.1:18991 npm run eval:exam -- --repeat 3

# 4. Compare with the result saved for the previous release.
npm run eval:exam:compare -- old.json new.json
```

Use your own `llama-server` rather than `atomic-agent models start`. A managed
server requires a key that the agent cannot find from the temporary state
folder each case uses, so every request would be rejected. If your server does
need a key, set `ATOMIC_AGENT_LLAMA_API_KEY`.

Keep the result files: the next release is compared against them.

## Reading the result

A local model varies between runs. With `--repeat N` every case runs N times
and a strict majority decides, so use an odd number. `--repeat 3` is the
sensible setting for a release decision.

A case is **not run**, rather than failed, when its setup errored, the agent
never started a session, the trace is missing, the model server went away or
the model produced no output. `eval:exam` exits 2 if any case did not run.

A timeout counts as a failure: the agent had its chance.

`eval:exam:compare` exits:

| Code | Meaning |
| --- | --- |
| 0 | The pass count did not drop by more than the threshold (`--threshold N`, default 2). |
| 1 | It did. The agent got worse. |
| 2 | Not a fair comparison: different model, different or edited cases, an unfinished run, or a case that did not run. |

Run both results with the same `--repeat`, and on the same machine if you care
about the time figures. "Tokens" adds the prompt tokens of every step to the
generated tokens.

## How long it takes

Estimates only, never measured:

- Each repeat is about 100 model steps. At 10 to 30 seconds per step that is
  **roughly 20 to 60 minutes**, so `--repeat 3` is 1 to 3 hours.
- The hard limit is 5 minutes per case (`ATOMIC_AGENT_EVAL_TIMEOUT_MS`), so a
  single repeat can never exceed about 2 hours 20 minutes.

## What it does not prove

- A clean exam does not mean the release is good. 28 small tasks in temporary
  folders say nothing about the desktop app, the terminal UI, the browser,
  cloud providers, Fusion mode, memory or long sessions.
- It measures one model. Another model may behave differently.
- The drop threshold is a guess until there are a few real results to show how
  much the same build moves between runs. A change of one or two cases can be
  noise, and a real regression in a single behaviour can stay under it.
- Passing is judged by file contents, reply patterns and which tools ran, so
  a wrong solution that matches the pattern still passes.
- Its result is not comparable with the published GAIA numbers.
- The comparison spots edits to a case's prompt and checks, but not to the
  files its setup creates.
