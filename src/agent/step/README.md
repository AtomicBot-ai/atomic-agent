# Inference, parsing, admission and commit

Status: current
Owner: src/agent/step/

Read [agent instructions](../AGENTS.md) and the [module route](../README.md). Entry: [step-contract.ts](step-contract.ts).

step-inference.ts prepares the request and consumes the existing completion stream. step-parsing.ts and step-batch-parsing.ts synchronously parse and prepare/finish repair; the original model await remains explicit in step-executor.ts. step-batch-policy.ts owns batch shaping, step-evidence.ts admission, and step-commit.ts ordered session effects. step-errors.ts owns the single BatchValidationError constructor. No phase adds an unconditional async boundary.

Checks: `npx vitest run src/agent`; `npm run lint`; `npm run typecheck:tests`. Read [batching](../docs/batching.md) for dispatch or [recovery](../docs/recovery.md) for retries and progress.
