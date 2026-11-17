# External agent import

Status: current
Owner: src/import/

Imports sessions, skills and notes from other agents. AGENTS.md in the Codex importer is an external input filename, not a reference to this repository guide; do not rename it during documentation migration.

The [atomic-desktop](atomic-desktop/atomic-desktop-importer.ts) source is not another agent: it merges the desktop app's former state dir into the shared one (ATO-416) through the store APIs; see the [CLI guide](../cli/README.md#desktop-state-merge).

Projects and folders: every session importer tags each session item with the group it had at the source (the folder it ran in, or a Claude app project), and [grouping.ts](grouping.ts) turns those tags into desktop Projects (`projects.json`, when the folder exists on this computer) or chat Folders (`chat-folders.json`), idempotently. `atag import` and the TUI run it after each importer (`groupImportReport`); the group rows land in the report as `projects` / `folders` items.

Two sources are not another coding agent's state dir: [claude-app](claude-app/claude-app-importer.ts) reads the Claude data export (.zip or its folder; claude.ai and the Claude desktop app), and [atomic-agent](atomic-agent/atomic-agent-importer.ts) reads another Atomic Agent data folder, keeping its projects and folders as they were.

Hermes Python plugins (ATO-953): `atag import hermes --trust-plugin <name>` registers each named plugin from `~/.hermes/plugins` as a stdio MCP server in `config.mcp.servers` that runs the bundled stdlib-only shim ([hermes_mcp_shim.py](../../assets/hermes-plugin-bridge/hermes_mcp_shim.py), copied to `<stateDir>/hermes-plugin-bridge/`). The shim imports the plugin with a stand-in `ctx` and serves only `ctx.register_tool` and `ctx.register_command`; hooks, platforms and providers are ignored. Plugins run local code, so there is no preset, `--include` or UI toggle for this: only the per-plugin trust flag, and calls stay behind the approval gate. Discovery and config: [hermes-plugins.ts](hermes/hermes-plugins.ts).

Entry point: [index.ts](index.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

Checks: `npx vitest run src/import` when tests are present; `npm run lint`; `npm run docs:check`.
