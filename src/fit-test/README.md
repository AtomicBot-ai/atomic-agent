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

Checks: `npx vitest run src/fit-test src/cli/models-tasks-command.test.ts`.
