# Skill Lab: does a skill help?

Status: current
Owner: src/skills/eval/

`atomic-agent skill eval <skill> --tasks tasks.yaml` runs each task twice: once with the skill in the model's catalog (`with`) and once with it hidden (`without`). It checks every answer and saves accuracy, wall time, tokens and cost for both to one JSON file. Epic ATO-996; format ATO-1099, command ATO-1098.

## Entry points

- [task-set.ts](task-set.ts): reads and validates a tasks file.
- [checks.ts](checks.ts): the `exact`, `regex` and `command` checks.
- [run-skill-eval.ts](run-skill-eval.ts): plans and runs the with/without runs through a driver (`SkillEvalDriver`), so tests need no model.
- [eval-result.ts](eval-result.ts): the result document and its summary.
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
```

Checks:

- `exact`: the reply equals `expected` after normalizing both sides: trimmed, one wrapping pair of `**`, backticks or quotes removed, one trailing period removed, whitespace collapsed, lower-cased unless `caseSensitive: true`.
- `regex`: `new RegExp(pattern, flags)` matches the raw reply.
- `command`: a shell command run in the run's working folder after the agent finished; exit code 0 passes. The reply is on stdin and in the file named by `SKILL_EVAL_ANSWER_FILE`. The environment is filtered like `os.shell.run`, so provider keys do not reach it. A tasks file is code: only run tasks files you trust.

A run that timed out or crashed fails without running its checks.

## How a run works

- One runtime is booted on a fresh temp folder. Before each run the folder is emptied and the task's fixtures are copied in; the agent works there and the command checks run there.
- `with` and `without` differ only in the skill registry's disabled set, changed in memory (`SkillRegistry.setDisabledNames` + `refreshSkills`). `config.json` is never written.
- Each run is one turn in a new session, deleted afterwards so eval runs do not fill the thread list.
- The order of the two variants flips from task to task and from attempt to attempt (`planRuns`), so a warm model cache or a slow first call does not always land on the same side.
- Approval requests are refused, since nobody is there to answer; `--no-approval` runs at level 5 instead. Refusals are counted per run (`approvalsDenied`).
- Memory is read-only during an eval (`memoryReadOnly` on `runTurn`): recall works as in a normal chat, but no run writes to memory. No end-of-turn reflection (notes, lessons, procedures), no lesson success/failure bump, and the `memory.*` write tools (`memory.notes.store` / `forget`, `memory.profile.set` / `remove`) are hidden from the model (`memoryReadOnlyToolFilter` in `src/agent/tool-resource-class.ts`). So nothing one variant does can help or hurt the other through memory. Both still see the same memory the person already had.

Options: `--repeat <n>` runs everything n times; `--only with|without` runs one variant; `--max-steps <n>` is the step limit for tasks without their own `maxSteps`; `--json` prints the result document instead of the table; `--keep-workdir` keeps the temp folder.

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
  "options": { "repeat": 1, "variants": ["with", "without"], "maxSteps": null, "approvalLevel": 2 },
  "runs": [
    {
      "taskId": "page-count", "variant": "with", "attempt": 1,
      "passed": true,
      "checks": [{ "type": "exact", "passed": true, "detail": "matched" }],
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
                 "errors": 0, "skillLoadedRuns": 4 },
    "without": { "…": "same fields" },
    "delta":   { "accuracy": 0.25, "wallMsMean": -5000, "totalTokens": 9000, "costUsd": 0 },
    "perTask": [{ "taskId": "page-count", "with": { "…": "same fields" }, "without": { "…": "same fields" } }]
  }
}
```

`delta` is `with` minus `without`: positive accuracy means the skill helps, positive time, tokens or cost means it costs more. It is null unless both variants ran; a token or cost delta is null when either side reported none. A with/without table (the TUI, ATO-1100; the desktop button, ATO-1102) reads `summary` and `summary.perTask` as they are.

Tokens and cost come from the turn result (`RunTurnResult.usage`, `RunTurnResult.spendUsd`): the same usage the provider reports and the same per-model pricing the cost accumulator (`src/llm/provider/cost-accumulator.ts`) uses. Side calls outside the step loop (memory, compaction) are not included.
