# Fusion workers

Status: current
Owner: src/tools/fusion/

Fusion delegates bounded task waves to worker turns. Contracts carry deliverables, declared inputs and dependencies; completed providers order later waves even when their task failed. Preserve task status attribution and hand-back based on completed-step progress rather than an independent timer.

Workers are ephemeral: no durable session row/reflection/trace; no recursive delegation or invisible interactive approval. Provider pins must not fall over to a different billing/model leg. Declared input replacement remains forbidden. Concurrency is resolved from the call, task count and serving slot capability, rather than blindly capturing startup state.

Worker spend is priced per completion with the prompt-cache discount (`estimateUsageCostUsd`, ATO-918). With `llm.runMode.fusion.turnBudgetUsd` / `turnTimeBudgetMs` set, [turn-budget.ts](turn-budget.ts) caps a fusion turn (ATO-947): reset at the turn's start, checked before a delegation, before each worker starts and on every worker completion; reaching it stops running workers and returns a plain-words instruction to the orchestrator. Unset, none of it runs.

[escalation.ts](escalation.ts) escalates a stuck worker (ATO-942): with `escalation: "advisor"`, the first stall or cut first answer asks `ResolvedRunMode.escalation` (a configured provider other than the worker leg) for a hint at most `ADVISOR_MAX_OUTPUT_TOKENS` long, refused when its worst case is over `escalationMaxUsd`, and steers the worker with it. A later stall re-runs the task on that model only with `escalationReplace`. `FusionLiveWorkers` exposes the person's stop / escalate per running worker (ATO-66). Escalation spend is added to the turn's cap and reported per row and per fan-out.

[judge.ts](judge.ts) is the trimmed judge (ATO-944, `judge: "on"`): an acceptance list per task, rendered read-only into its brief (`briefSuffix`); after the waves, facts (check outcomes, provide presence, declared files) decide their items and can only be red or green on their own; a fresh-context judge (no transcript; files, or the reply when no file was declared) rules on the rest, and only a literal `pass: true` passes. A red list re-runs the task once with the findings; the contract is re-evaluated on the retried rows only. Unreadable or impossible judging leaves the task `needs_orchestrator`, never `ok`.

Read [tool instructions](../AGENTS.md), [worker runner](worker-runner.ts), [worker policy](worker-tool-policy.ts), [delegate](fusion-delegate.ts), [wave planning](contract-waves.ts), [input contract](contract-inputs.ts), and [run modes](../../llm/run-mode/README.md). Run tools/fusion and runtime fusion seam tests.
