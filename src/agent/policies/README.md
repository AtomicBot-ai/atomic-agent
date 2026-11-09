# Turn and step policies

Status: current
Owner: src/agent/policies/

Read [agent instructions](../AGENTS.md) and the [module route](../README.md). Entry: [plan-mode.ts](plan-mode.ts).

Plan mode, fusion orchestrator restrictions, claim evidence, link evidence, step tool sets and [unknown tool names](unknown-tool.ts) are separate policy owners. A call to a tool the registry does not hold gets an error result naming the closest real tools; only a streak of unknown-only steps ends the turn. The step tool set's users are the stalled Fusion review (`../review-stall.ts`) and the automatic replan hold (`../fusion-replan.ts`, ATO-941), which outranks it. Dispatch still enforces their decisions. They do not acquire runtime resources or frontend state. Old root paths re-export the same values/types for compatibility; new consumers should use these concrete owners.

Checks: `npx vitest run src/agent`; `npm run lint`; `npm run typecheck:tests`. Read [batching](../docs/batching.md) for dispatch or [recovery](../docs/recovery.md) for retries and progress.
