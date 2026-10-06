# Progress observations and notices

Status: current
Owner: src/agent/progress/

Read [agent instructions](../AGENTS.md) and the [module route](../README.md). Entry: [loop-contract.ts](loop-contract.ts).

ToolLoopTracker remains the state owner in ../loop-detector.ts. loop-fingerprints.ts normalizes observations; loop-notices.ts formats decisions; loop-constants.ts owns existing thresholds. Read coverage, wandering spread, test command recognition and workspace fingerprints live beside their tests here. Pure helpers do not load tracker state.

Checks: `npx vitest run src/agent`; `npm run lint`; `npm run typecheck:tests`. Read [batching](../docs/batching.md) for dispatch or [recovery](../docs/recovery.md) for retries and progress.
