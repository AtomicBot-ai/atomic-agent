# Model fit-test

Status: current
Owner: src/fit-test/

Answers "which local model is best on my own tasks" (ATO-994).

## Task set (ATO-1089)

`atomic-agent models tasks collect [--last <n>] [--out <file>] [--json]` reads the newest 50 chats from the sessions database and writes the user's last n tasks (default 10) as a JSON task set ([fit-task.ts](fit-task.ts)). A task is one macro-turn: the user's message (with any steering folded in), the tools the agent called and the reply that closed it ([collect-tasks.ts](collect-tasks.ts)).

Left out, and counted in the command's summary:

- outbound: the run sent something outside the machine ([outbound-calls.ts](outbound-calls.ts)): mail, a push, a GitHub issue, PR or comment, a browser click or typing, a writing HTTP method, a shell line that pushes, publishes or posts, an MCP tool without a reading verb, or an approval in the `email`, `publish`, `git_remote`, `browser_commit`, `browser_secret` or `paid_generation` category. The rule is wide on purpose: a replay must never send mail twice.
- stopped by the user, never answered, a slash command, or a repeat of a newer prompt.

Prompts and reference replies are masked with the error scrubber's `maskSecrets` plus the agent's own keys from the environment. The file is written owner-only.

Each task carries the JSON fields of an eval case (`eval/harness/case-schema.ts`) with one `judge` expectation whose rubric quotes the old reply as a hint, not ground truth. `eval/harness/load-fit-task-set.ts` turns the file into `EvalCase[]` for the eval runner. The file shape only gains fields; a breaking change bumps `version`.

## Fit-test (ATO-1090)

`atomic-agent models fit-test --tasks <file> --models <a,b[,c]> --judge-url <url> [--judge-model <id>] [--judge-key-env <NAME>] [--timeout <s>] [--out <file>] [--json]` runs the set on up to three local models and prints one row per model: mean judge score, tasks passed (score 4 or more), total task time, peak memory of the model server, tokens. `--out` keeps the full run as JSON ([fit-test-types.ts](fit-test-types.ts)).

- The runner ([run-fit-test.ts](run-fit-test.ts)) takes its outside world as `FitTestDeps` (load a model, run a task, judge a reply, sample memory), so it is tested with fakes. Models are loaded and released one at a time; one that fails to load is recorded and the run goes on.
- The CLI ([../cli/models-fit-test-command.ts](../cli/models-fit-test-command.ts)) loads a model through the `models stop` / `use` / `start` handlers, so it needs managed mode, and puts the previously active model back at the end (started again if it was running). The local model is not available to other clients while the run goes on.
- Stopped by SIGINT (Ctrl+C) or SIGTERM (the desktop's Cancel), the CLI winds the run down instead of dying (ATO-1498, `runRestoringOnStop`): the running child gets SIGTERM (SIGKILL after 3 s) and its temp dirs are removed, no further task or judge call starts, the test model is stopped and the previous one put back, and the command exits 130 / 143. If the run has not wound down after 15 s the model is put back anyway and the process exits; a second signal quits at once.
- Each task runs as a child `atomic-agent run` in a temp working dir and a temp state dir, in external mode on the loaded model ([agent-task-runner.ts](agent-task-runner.ts)). Stdin closes after the prompt, so every approval prompt is denied: that is the dry mode for tools with side effects. Chats, memory and tasks of the run never reach the user's state. Tokens are read from the child's trace.
- Peak memory is the model server's resident memory from `ps` every 2 s ([process-memory.ts](process-memory.ts)); `n/a` on Windows. The table also prints the machine's GPU memory budget (`readRecommendSnapshot`, `gpu-memory-budget.ts`).
- The judge ([fit-judge.ts](fit-judge.ts)) is a copy of the eval harness's prompt and parsing: the shipped `src/` tree cannot import `eval/`. There is no default endpoint, because the judge reads the user's prompts; the key is read from the environment variable `--judge-key-env` names, never from the command line.

Checks: `npx vitest run src/fit-test src/cli/models-tasks-command.test.ts src/cli/models-fit-test-command.test.ts`.
