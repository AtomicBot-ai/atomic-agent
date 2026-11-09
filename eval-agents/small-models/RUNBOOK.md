# Small-model bench (4B / 9B / 27B): pre-release check

ATO-1118 (child of ATO-787, covers the ATO-895 compaction test set).

Question it answers before a release: does Atomic Agent still finish real tasks on
small local models (Qwen3.5 4B / 9B / 27B, Q4_K_M) with a 32K or 64K window?

> **Running it loads a local model for hours.** Do not start a real run (here, on the
> second Mac, or on a rented GPU) without an explicit yes from the product owner for
> that specific run: which models, which machine, how long, what it costs.
> `--dry-run` and the unit tests are always fine.

## What is in here

| File | What |
|---|---|
| `matrix.json` | Models, windows, thinking on/off, repeats, **all llama-server flags**, named profiles |
| `thresholds.json` | Pass-rate minimums per model size for the gate |
| `tasks/` | 16 tasks: prompt, fixture generator, deterministic checker, timeout, reference solution |
| `run.mjs` | Runner: fresh temp workspace + fresh agent state dir per run, checker, `results.jsonl` |
| `summary.mjs` | Markdown tables + `--gate` exit code |
| `small-models.test.ts` | Unit tests for checkers, fixtures, plan, summary, gate (no model) |

No dependencies beyond Node 22+, `python3` and `bash` (some checkers run the agent's script).

### Tasks

`node eval-agents/small-models/run.mjs --list`

| id | set | what it catches |
|---|---|---|
| t1–t5 | core | the five offline tasks of the 20.10 ten-agent 4B bench, same prompts and answers |
| h1 | core | one change spread over four files (constant + three importers) |
| h2 | core | a 3-line fix at line ~2170 of a 2.7k-line file; any change outside the function fails (catches "rewrote and truncated the file") |
| h3 | core | project-wide search over ~80 files with decoys (`send_webhook_legacy`, stale notes, other constants) |
| h4 | core | `./build.sh` fails twice with planted errors; the agent has to read the error, fix the cause, rerun |
| h5 | core | write HTML; a literal `\n` sequence instead of real newlines fails (seen on Nemotron 21.10) |
| n32k, n64k, n128k, n512k, n1m | stress | needle + count question in a log of ~32K…1M tokens, generated per run from a seed (never committed, 0.1–3.5 MB). Pass needs the right answer **and** a search tool, `grep/head/tail/sed -n`, or a ranged read in the trace |
| l1 | stress | multi-turn session that reads ~1.5x the window (13 turns at 32K, 16 at 64K), then writes all codes collected along the way; compaction has to happen and the agent has to finish (ATO-895) |

Core tasks are gated. Stress tasks are reported but not gated until we have a baseline.

Checker fix vs the old private stand: t5 used `grep -rl` and on GNU grep it counted
`__pycache__/*.pyc`, so correct renames failed. The checker now scans `*.py` sources only.
(The 23.10 Bolt stand also had a stale `__pycache__` inside the fixture itself; fixtures here are generated, so there is none.)

## Dry run (safe, no model)

```bash
node eval-agents/small-models/run.mjs --dry-run --profile release --agent .
node eval-agents/small-models/run.mjs --dry-run --profile quick --agent .
```

Prints every cell, the exact llama-server command per cell, the seeded agent config,
the number of runs and a time estimate.

Look at a fixture without running anything:

```bash
node eval-agents/small-models/run.mjs fixture h2 /path/to/empty-dir
node eval-agents/small-models/run.mjs fixture l1 /path/to/empty-dir --window 65536
```

## Real run (only after the explicit yes)

1. Build the agent under test in its checkout: `npm ci && npm run build`
   (the runner uses `<checkout>/dist/cli/index.js`; `grammars/` must sit next to `dist/`).
   `--agent` can also point at an installed `atomic-agent` binary.
2. Have a `llama-server` binary and the GGUF files from `matrix.json` in one folder.
3. Either let the runner start one server per (model, window) cell:

   ```bash
   node eval-agents/small-models/run.mjs --agent <checkout> --profile release \
     --start-server --models-dir <gguf folder> --llama-server <path to llama-server>
   ```

   or point it at a server you started yourself with the flags from `matrix.json`
   (one model, one window per invocation; the runner checks `/props` and refuses a window mismatch):

   ```bash
   node eval-agents/small-models/run.mjs --agent <checkout> --server-url http://127.0.0.1:18190 \
     --models qwen3.5-4b --windows 32768 --thinking off --tasks all --repeats 3
   ```

4. Summary and gate (several `results.jsonl` files can be merged, e.g. one per machine):

   ```bash
   node eval-agents/small-models/summary.mjs eval-agents/reports/small-models/*/results.jsonl --gate --out summary.md
   ```

   Exit 0 = gate passed, 1 = a cell is below its minimum, 3 = not enough data
   (missing cell or fewer than 3 runs per task), 2 = usage error.

Useful flags: `--tasks core|stress|all|t1,h2`, `--repeats N`, `--keep fail|all|none`
(copy the agent's workspace into the run folder; default `fail`), `--out <dir>`,
`--matrix <file>`.

### What a run writes

`eval-agents/reports/small-models/<run id>/` (gitignored):

- `results.jsonl`: one row per run: model, size, window, thinking, task, repeat, pass, reason,
  seconds, steps, prompt/predicted tokens, max prompt tokens, tool calls/errors,
  compactions, compaction failures, parse retries, loop detections.
- `environment.json`: agent git sha, Node, platform, plan, server flags.
- `runs/<model>/<window>/thinking-<x>/<task>-r<k>/`: `meta.json` (hidden expectations),
  agent stdout/stderr, copied trace NDJSON, `result.json`, and the workspace on failure.
- `llama-server-<model>-<window>.log` when the runner started the server.

### Isolation

- Each run gets a fresh workspace and a fresh `ATOMIC_AGENT_STATE_DIR` in the OS temp dir
  (outside the repo, so the agent does not pick up the repo's own `AGENTS.md`). The real
  `~/.atomic-agent` is never touched.
- `ATOMIC_AGENT_ANALYTICS=off` and `analytics.enabled: false`: bench runs must not show up
  as new users in product analytics.
- Agent settings stay at product defaults except: external llama URL, `localModels.thinking`
  per cell, `agent.approvalLevel: 5` (headless), per-task `agent.maxSteps`, tracing on,
  and `ATOMIC_AGENT_LLAMA_REQUEST_TIMEOUT_MS=1800000` so a slow 27B step is not cut at 5 min.

## llama-server settings

All in `matrix.json` → `server.args`. Same for every model so rows compare models, not tweaks:
`-ngl 999 -c <window> --jinja --parallel 1 -fa auto --ctx-checkpoints 32 --checkpoint-min-step 0`,
plain f16 KV cache, no TurboQuant (same as the 20.10 ten-agent bench).

- `--jinja` is required, without it tool calls do not work.
- `--parallel 1`: the window is per slot; with more slots each slot gets a fraction.
- The app's managed backend runs a TurboQuant build with a quantized KV cache. This bench
  measures plain llama.cpp on purpose. To measure what managed-mode users get, add the KV
  flags to `server.args` in a copy of the matrix and pass `--matrix`.
- Thinking is an agent setting (`localModels.thinking`), not a server flag, so one server
  serves both the thinking-on and thinking-off rows.

## Where to run and what it costs

Numbers below are estimates, **not measured yet**; the first release run replaces them.

| Profile | Runs | Worst case (every run times out) | Guess (~20% of timeout) |
|---|---|---|---|
| `quick` (4B, 32K, core, 1 repeat) | 10 | 2.0 h | ~25 min |
| `release` (3 models x 2 windows, thinking off, all tasks, 3 repeats) | 288 | 79.5 h | ~16 h serial |
| `full` (+ thinking on) | 576 | 159 h | ~32 h serial |

- **Second Mac (MacBook Pro M5, 32 GB):** fine for 4B and 9B. 27B Q4 (~16.5 GB) plus a 64K
  f16 KV cache is tight: macOS lets the GPU use about 2/3 of RAM by default. Run 27B on a
  rented 24 GB+ GPU instead, or raise `iogpu.wired_limit_mb` only with the owner's ok.
  Release profile for 4B+9B there: roughly 10 h, so start it in the evening.
- **Vast.ai:** one machine per model in parallel cuts wall time to ~5-6 h. RTX 4090/3090
  (24 GB) runs all three sizes; about $0.3-0.6/h each, so a full release run is roughly
  $5-10. Delete instances at the end and check the list is empty.

## Gotchas

- **The second Mac re-syncs the checkout on every `mbp` call**: tracked files are sent,
  ignored ones are not, so anything outside the gitignored `eval-agents/reports/` can be
  lost or overwritten between calls. Keep the default `--out`, and copy results off the
  machine after every run (find the folder with `mbp path -C <checkout>`).
- Do not run it on the second Mac while someone is doing hands-on QA there, and never stop
  other jobs on that machine.
- Start long runs in a visible terminal or tmux; a dropped ssh session must not kill them.
- The agent's config loader drops unknown keys silently. To see what a run actually used:
  `ATOMIC_AGENT_STATE_DIR=<run state dir> atomic-agent config get`.
- Server window must equal the cell's window. The runner reads `/props` and stops on a mismatch.
- If something already listens on the server port, `--start-server` refuses to start.
- `pkill -f llama-server` inside a `bash -c` also matches the shell running it. Let the
  runner manage the server, or use `pkill -x llama-server`.
- On Vast: add the SSH key before renting; if the Hugging Face CDN hangs, fetch from a
  mirror and verify sha256; some boxes are broken (no GPU runtime, full disk), drop them.
- Nemotron Bolt E4B: until ATO-879 lands the agent does not recognise it by name; the
  23.10 stand also ran it with an alias ending in `-gemma4`. Set `alias` in `matrix.json`
  to reproduce that row.

## Adding a task

Add an object to `tasks/core.mjs`, `tasks/hard.mjs` or `tasks/stress.mjs` with `id`, `set`,
`title`, `timeoutSec`, `maxSteps`, `turns(ctx)`, `fixture(dir, ctx) -> meta`,
`check(dir, meta, ctx) -> { pass, reason }` and a reference `solve(dir, meta, ctx)`.
The unit test checks every task both ways: untouched fixture fails, reference solution passes.
Fixtures must be generated from a seed; do not commit large files.
