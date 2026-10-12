# CLI frontend

Status: current
Owner: src/cli/

Owns command parsing and terminal entry points. User turns enter runtime.runTurn; preserve exit semantics, state-dir selection and separation from release scripts.

Entry point: [index.ts](index.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

Skill list/show/enable/disable accept `--workspace <dir>` for cloud project scope; `skill project on|off --workspace <dir>` controls all project sources. Without the flag enable/disable remain global. See [cloud skill controls](../skills/docs/cloud-workspace.md).

Checks: `npx vitest run src/cli` when tests are present; `npm run lint`; `npm run docs:check`.
