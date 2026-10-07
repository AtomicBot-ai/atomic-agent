# Turn and step policies

Status: current
Owner: src/agent/policies/

Read [agent instructions](../AGENTS.md) and the [module route](../README.md). Entry: [plan-mode.ts](plan-mode.ts).

Plan mode, fusion orchestrator restrictions, claim evidence, link evidence and step tool sets are separate policy owners. Dispatch still enforces their decisions. They do not acquire runtime resources or frontend state. Old root paths re-export the same values/types for compatibility; new consumers should use these concrete owners.

Checks: `npx vitest run src/agent`; `npm run lint`; `npm run typecheck:tests`. Read [batching](../docs/batching.md) for dispatch or [recovery](../docs/recovery.md) for retries and progress.
