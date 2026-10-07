# Command execution

Status: current
Owner: src/sandbox/

Owns command jobs, output caps and process-tree cancellation. Preserve shell interpretation and explicit cancellation; dispatch approval lives in the caller wrapper.

Entry point: [command-runner.ts](command-runner.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

Checks: `npx vitest run src/sandbox` when tests are present; `npm run lint`; `npm run docs:check`.
