# CLI frontend

Status: current
Owner: src/cli/

Owns command parsing and terminal entry points. User turns enter runtime.runTurn; preserve exit semantics, state-dir selection and separation from release scripts.

Entry point: [index.ts](index.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

Checks: `npx vitest run src/cli` when tests are present; `npm run lint`; `npm run docs:check`.
