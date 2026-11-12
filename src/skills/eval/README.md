# Skill Lab: does a skill help?

Status: current
Owner: src/skills/eval/

`atomic-agent skill eval <skill> [--tasks tasks.yaml]` runs each task twice: once with the skill in the model's catalog (`with`) and once with it hidden (`without`). It checks every answer and saves accuracy, wall time, tokens and cost for both to one JSON file. Epic ATO-996; format ATO-1099, command ATO-1098, judge ATO-1101, starter tasks ATO-1163.

## Entry points

- [task-set.ts](task-set.ts): reads and validates a tasks file.
- [checks.ts](checks.ts): the `exact`, `regex`, `command` and `judge` checks.
- [judge.ts](judge.ts): the judge model behind `judge` checks (ATO-1101).
- [run-skill-eval.ts](run-skill-eval.ts): plans and runs the with/without runs through a driver (`SkillEvalDriver`), so tests need no model.
- [eval-result.ts](eval-result.ts): the result document and its summary.
- [tasks-location.ts](tasks-location.ts): finds a skill's own tasks file when `--tasks` is left out (ATO-1163).
- [run-store.ts](run-store.ts): saves and reads results under `<stateDir>/skill-evals/`.
- [../../cli/skill-eval-command.ts](../../cli/skill-eval-command.ts): the CLI and the driver over a live runtime.

## Tasks file

YAML (JSON also parses). Paths are relative to the tasks file.

```yaml
skill: pdf                 # optional; when set, must match the skill being evaluated
description: Reading PDFs  # optional
defaults:                  # optional, applies to every task
  timeoutMs: 600000        # wall-clock limit of one run (default 10 minutes)
  maxSteps: 30             # step limit of one run (default: agent.task.maxSteps)
  checkTimeoutMs: 60000    # limit of one command check (default 1 minute)
  fixtures: fixtures       # folder copied into each run's working folder
tasks:
  - id: page-count         # 1-64 letters, digits, ".", "-", "_"; unique
    prompt: How many pages does report.pdf have? Answer with the number only.
    fixtures: fixtures     # overrides defaults.fixtures
    check: { type: exact, expected: "3" }
  - id: extract-title
    prompt: Write the title of report.pdf to title.txt.
    checks:                # every check must pass
      - type: command
        run: grep -qi "quarterly report" title.txt
      - type: regex
        pattern: "title\\.txt"
        flags: i
  - id: summary
    prompt: Summarize report.pdf in three sentences.
    check:
      type: judge
      rubric: Mentions revenue growth and the new office; no invented numbers.
      reference: Revenue grew 12%; a Berlin office opened.   # optional
      minScore: 4                                            # optional, 1..5, default 4
```

Checks:

- `exact`: the reply equals `expected` after normalizing both sides: trimmed, one wrapping pair of `**`, backticks or quotes removed, one trailing period removed, whitespace collapsed, lower-cased unless `caseSensitive: true`.
- `regex`: `new RegExp(pattern, flags)` matches the raw reply.
- `command`: a shell command run in the run's working folder after the agent finished; exit code 0 passes. The reply is on stdin and in the file named by `SKILL_EVAL_ANSWER_FILE`. The environment is filtered like `os.shell.run`, so provider keys do not reach it. A tasks file is code: only run tasks files you trust.

- `judge`: a judge model grades the reply against `rubric` (and `reference`, when given) on a 1..5 scale: 1 wrong, 3 partly right, 5 fully right. Passes at `minScore` or above; output the judge cannot be read as a score never passes. For answers no pattern can check.

A run that timed out or crashed fails without running its checks.

### The judge

The judge is always one of the person's own models; there is no built-in paid default. The first that applies:

1. `--judge-url <url>` or `ATOMIC_AGENT_JUDGE_URL`, with `--judge-model <id>` or `ATOMIC_AGENT_JUDGE_MODEL` (required with a URL): an OpenAI-compatible endpoint, the same knobs as the eval harness judge (`eval/harness/judge-client.ts`). Key from `ATOMIC_AGENT_JUDGE_API_KEY` or `OPENROUTER_API_KEY` (the agent's `.env` is read first); a localhost URL needs none.
2. `skills.eval.judgeProvider` in config.json: an id from `llm.providers`. The judge calls that provider with its own configured model.
3. The active text provider, when it is a cloud provider. Then the model under test also grades; set `skills.eval.judgeProvider` to another provider for an independent judge.

A local llama-server entry is never the judge (it is the model under test). A tasks file with `judge` checks and no usable judge (a local model active and nothing set, an unknown provider id, a hosted URL without a key) stops before anything runs, exit 2. `ATOMIC_AGENT_JUDGE_TIMEOUT_MS` (default 60000) bounds each call. The prompt and the 1..5 scale match the harness judge.

Judge calls are eval overhead: their tokens and cost are not counted in the runs or the summary. They are reported apart, as `judgeUsage` in the result and a `judge: N tokens, $X` line under the table. The cost is the service's bill when it reports one, else the model's price from `userModels` or the bundled catalog; null when neither prices it.

## Where the tasks file lives

Without `--tasks`, `skill eval <skill>` looks in this order and takes the first file found (`findSkillTasksFile`):

1. `<starter-skills>/<skill>/evals/tasks.yaml` (or `.yml`): the packaged starter tree (`resolveStarterSkillsSourceDir`).
2. `<stateDir>/skills/<skill>/evals/tasks.yaml`, `evals/tasks.yml`, `tasks.yaml`, `tasks.yml`: the installed skill folder.

Project skills are not looked up: the eval runtime works in a temp folder, so it never loads them.

The seeder leaves a starter's `evals/` folder out of the installed copy (`STARTER_EVALS_DIR_NAME` in `../seed-starter-skills.ts`). The model can read any file under a loaded skill's folder, and `evals/` holds the expected answers. A skill you write yourself can keep its tasks in its own folder; the same caveat applies to it.

- `--all` runs every skill that has a tasks file, on one runtime, one result file per skill. A skill with tasks that is not installed is skipped and listed; the exit code is then 1.
- `--check-tasks` runs nothing: it prints `<skill>\t<n> tasks\t<path>` per skill and exits 0, or exits 2 when there is no tasks file. A UI can use it to decide whether to offer the eval.
- `command` checks get `SKILL_EVAL_TASKS_DIR`, the folder of the tasks file, so a check can call a helper script shipped next to it: `node "$SKILL_EVAL_TASKS_DIR/checks/x.mjs"`.

### Starter tasks (ATO-1163)

| Skill | Tasks | Needs on the machine |
|---|---|---|
| `audit` | find the SQL injection and the hard-coded password with file:line; audit read-only | node |
| `code-graph` | callers of `chargeCard` with path:line (a decoy has a similar name); where login lives | node |
| `pandoc` | Markdown to .docx; Markdown to a standalone HTML page | node; pandoc for the agent |
| `pdf` | page count; a figure from the text; save page 2 as its own PDF | poppler (`pdfinfo`, `pdftotext`) for the check; qpdf or poppler for the agent |
| `plain-writing` | rewrite landing copy without AI tells, facts kept; rewrite one sentence | node |
| `skill-creator` | write a valid `SKILL.md` for two small skills | node |
| `verify-work` | run a script and report its real output; fix a bug and prove the test passes | node |
| `xlsx` | build a sales workbook with a SUM formula | node; python3 + openpyxl for the agent |

The command checks are POSIX shell lines (`node "$SKILL_EVAL_TASKS_DIR/…"`, `grep`), so the starter tasks expect macOS or Linux. `src/skills/eval/starter-evals.test.ts` loads every starter tasks file and checks that the helper scripts its checks call exist. The tasks are kept small so a full run stays short; they say whether a skill helps a model on its typical job, not how good the model is.

## How a run works

- One runtime is booted on a fresh temp folder. Before each run the folder is emptied and the task's fixtures are copied in; the agent works there and the command checks run there.
- `with` and `without` differ only in the skill registry's disabled set, changed in memory (`SkillRegistry.setDisabledNames` + `refreshSkills`). `config.json` is never written.
- Each run is one turn in a new session, deleted afterwards so eval runs do not fill the thread list.
- The order of the two variants flips from task to task and from attempt to attempt (`planRuns`), so a warm model cache or a slow first call does not always land on the same side.
- Approval requests are refused, since nobody is there to answer; `--no-approval` runs at level 5 instead. Refusals are counted per run (`approvalsDenied`).
- Memory is read-only during an eval (`memoryReadOnly` on `runTurn`): recall works as in a normal chat, but no run writes to memory. No end-of-turn reflection (notes, lessons, procedures), no lesson success/failure bump, and the `memory.*` write tools (`memory.notes.store` / `forget`, `memory.profile.set` / `remove`) are hidden from the model (`memoryReadOnlyToolFilter` in `src/agent/tool-resource-class.ts`). So nothing one variant does can help or hurt the other through memory. Both still see the same memory the person already had.

Options: `--repeat <n>` runs everything n times; `--only with|without` runs one variant; `--max-steps <n>` is the step limit for tasks without their own `maxSteps`; `--json` prints the result document instead of the table; `--keep-workdir` keeps the temp folder; `--all` and `--check-tasks` are described above.

## Result file

`<stateDir>/skill-evals/<skill>/<runId>.json` (`~/.atomic-agent/skill-evals/pdf/2026-11-12T09-30-00-000Z.json`). The run id is the start time in UTC, so names sort oldest first; `listSkillEvalResults` and `readLatestSkillEvalResult` read them. A plugin skill `plugin:name` is stored as `plugin_name`.

```jsonc
{
  "schema": "atomic-agent.skill-eval/1",
  "runId": "2026-11-12T09-30-00-000Z",
  "complete": true,                  // false when stopped (Ctrl-C) before the plan finished
  "skill": { "name": "pdf", "version": "1.0.0", "source": "global" },
  "tasks": { "file": "/abs/tasks.yaml", "sha256": "…", "count": 4 },
  "startedAt": "…", "finishedAt": "…",
  "agentVersion": "0.7.1",
  "model": { "provider": "local-llama", "model": "qwen3.5-9b" },
  "judge": { "provider": "openrouter", "model": "qwen/qwen3-235b", "url": null },   // null when no task has a judge check; url set for an ATOMIC_AGENT_JUDGE_URL judge
  "judgeUsage": { "calls": 8, "promptTokens": 4100, "completionTokens": 260, "totalTokens": 4360, "costUsd": 0.0012 },   // the judge's own calls; null without a judge
  "options": { "repeat": 1, "variants": ["with", "without"], "maxSteps": null, "approvalLevel": 2 },
  "runs": [
    {
      "taskId": "page-count", "variant": "with", "attempt": 1,
      "passed": true,
      "checks": [{ "type": "exact", "passed": true, "detail": "matched" }],   // a judge check also has "score": 1..5
      "end": "reply",                // reply | finish | max_steps | cancelled | failed | timeout | error
      "reply": "3", "error": null,
      "wallMs": 41250, "steps": 4,
      "promptTokens": 18230, "completionTokens": 410,   // null when the provider reported none
      "costUsd": 0,                  // 0 on a local model, null when nothing priced the run
      "approvalsDenied": 0,
      "skillLoaded": true            // the model called skill.view on this skill
    }
  ],
  "summary": {
    "with":    { "runs": 4, "passed": 3, "accuracy": 0.75, "wallMsTotal": 160000, "wallMsMean": 40000,
                 "promptTokens": 70000, "completionTokens": 1600, "totalTokens": 71600, "costUsd": 0,
                 "errors": 0, "skillLoadedRuns": 4, "judgeScoreMean": 4.5 },   // null without judge scores
    "without": { "…": "same fields" },
    "delta":   { "accuracy": 0.25, "judgeScoreMean": 1.0, "wallMsMean": -5000, "totalTokens": 9000, "costUsd": 0 },
    "perTask": [{ "taskId": "page-count", "with": { "…": "same fields" }, "without": { "…": "same fields" } }]
  }
}
```

`delta` is `with` minus `without`: positive accuracy means the skill helps, positive time, tokens or cost means it costs more. It is null unless both variants ran; a token or cost delta is null when either side reported none. A with/without table (the TUI, ATO-1100; the desktop button, ATO-1102) reads `summary` and `summary.perTask` as they are.

`--json` prints this document (pretty-printed, the whole of stdout; progress goes to stderr). With `--all --json` stdout is one object `{ "schema": "atomic-agent.skill-eval-batch/1", "results": [ …one document per skill… ], "missing": ["skill-not-installed"] }`.

Exit codes: 0 when every run finished; 1 when stopped early (Ctrl-C or SIGTERM abort the run, the partial result is still saved with `"complete": false` and printed) or a skill was not installed; 2 for bad arguments, a missing or invalid tasks file, or a judge that cannot be used.

Tokens and cost come from the turn result (`RunTurnResult.usage`, `RunTurnResult.spendUsd`): the same usage the provider reports and the same per-model pricing the cost accumulator (`src/llm/provider/cost-accumulator.ts`) uses. Side calls outside the step loop (memory, compaction) are not included.
