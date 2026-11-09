# Progress observations and notices

Status: current
Owner: src/agent/progress/

Read [agent instructions](../AGENTS.md) and the [module route](../README.md). Entry: [loop-contract.ts](loop-contract.ts).

ToolLoopTracker remains the state owner in ../loop-detector.ts. loop-fingerprints.ts normalizes observations; loop-notices.ts formats decisions; loop-constants.ts owns existing thresholds. Read coverage, wandering spread (counted in step rounds, so one step's fan-out is one round), mutation-attempt epochs for re-reads after a write or edit attempt, test command recognition, deliberate-poll recognition (poll-command.ts), the history walks and bounded recent-key window (loop-history.ts) and workspace fingerprints live beside their tests here. Repetition is judged on the recent window and on what changed in between (a landed write, a poll), never on lifetime totals. Pure helpers do not load tracker state.

Checks: `npx vitest run src/agent`; `npm run lint`; `npm run typecheck:tests`. Read [batching](../docs/batching.md) for dispatch or [recovery](../docs/recovery.md) for retries and progress.
