# External agent import

Status: current
Owner: src/import/

Imports sessions, skills and notes from other agents. AGENTS.md in the Codex importer is an external input filename, not a reference to this repository guide; do not rename it during documentation migration.

The [atomic-desktop](atomic-desktop/atomic-desktop-importer.ts) source is not another agent: it merges the desktop app's former state dir into the shared one (ATO-416) through the store APIs; see the [CLI guide](../cli/README.md#desktop-state-merge).

Entry point: [index.ts](index.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

Checks: `npx vitest run src/import` when tests are present; `npm run lint`; `npm run docs:check`.
