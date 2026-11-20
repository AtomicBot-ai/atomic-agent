# External agent import

Status: current
Owner: src/import/

Imports sessions, skills and notes from other agents. AGENTS.md in the Codex importer is an external input filename, not a reference to this repository guide; do not rename it during documentation migration.

The [atomic-desktop](atomic-desktop/atomic-desktop-importer.ts) source is not another agent: it merges the desktop app's former state dir into the shared one (ATO-416) through the store APIs; see the [CLI guide](../cli/README.md#desktop-state-merge).

Projects and folders: every session importer tags each session item with the group it had at the source (the folder it ran in, or a Claude app project), and [grouping.ts](grouping.ts) turns those tags into desktop Projects (`projects.json`, when the folder exists on this computer) or chat Folders (`chat-folders.json`), idempotently. `atag import` and the TUI run it after each importer (`groupImportReport`); the group rows land in the report as `projects` / `folders` items.

Two sources are not another coding agent's state dir: [claude-app](claude-app/claude-app-importer.ts) reads the Claude data export (.zip or its folder; claude.ai and the Claude desktop app), and [atomic-agent](atomic-agent/atomic-agent-importer.ts) reads another Atomic Agent data folder, keeping its projects and folders as they were.

[user-facts](user-facts/index.ts) is not a session import: it takes the person's own messages out of a Claude or ChatGPT export, and saves only the facts the person ticked (extraction lives in `src/memory/import-facts`; ATO-1060). The run itself ([import-facts-service.ts](user-facts/import-facts-service.ts)) reads the export, binds ONE model for the whole run (the local one by default; a cloud one only with this run's consent, called directly so the fallback chain can never move it to another link), runs in the background as one job at a time with chunk progress and a stop, keeps candidates in memory only, and writes a receipt per save under `<stateDir>/import-receipts/` so the profile half can be undone. The desktop reaches it over `/api/import/facts/*` ([route-import-facts.ts](../http/route-import-facts.ts)); the terminal wizard calls the service in-process.

Entry point: [index.ts](index.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

Checks: `npx vitest run src/import` when tests are present; `npm run lint`; `npm run docs:check`.
