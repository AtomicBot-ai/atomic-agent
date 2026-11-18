# Shareable agent setup

Status: current
Owner: src/setup-share/

`atag setup export` and `atag setup import` (ATO-1073, [setup-command.ts](../cli/setup-command.ts)) let one person hand their agent setup to another, the way Hermes Agent's `profile export` / `profile import` do. Atomic Agent has one state dir rather than many profiles, so a bundle is added into the current setup, never swapped in for it.

What goes in is picked by allow-list ([collect-setup.ts](collect-setup.ts)): the person's own skills (starter skills, VCS and install folders, credential-looking files and symlinks left out), subagent profiles in `agents/*.md`, and a reduced `config.json` holding only `mcp.servers`, `llm.providers` and `agent.personas.definitions` ([redact-setup-config.ts](redact-setup-config.ts)). Secret-named keys, every MCP `env` and `headers` value, secret flags in `args`, URL credentials and key-shaped strings are blanked and listed in the manifest. Chats, memory, logs, traces, caches, `.env`, MCP OAuth tokens and models never go in; memory only with `--include-memory`, as a SQLite snapshot, with a warning. Scheduled jobs live in `tasks.sqlite` rows and are not part of this version.

The format ([setup-bundle-format.ts](setup-bundle-format.ts)) is a `.tar.gz` under `atomic-agent-setup/`, manifest first. Import ([setup-import.ts](setup-import.ts)) unpacks into a private staging folder and refuses the whole bundle on any entry outside the allow-list, a link, an unlisted file or a size cap ([setup-bundle-read.ts](setup-bundle-read.ts)); runs the skill security scanner over skills and profiles and stops on `dangerous` without `--acknowledge-risk`; switches every MCP server off and drops its approval and trust settings; then merges by name through the existing [Atomic Agent importer](../import/atomic-agent/atomic-agent-importer.ts) (skills, MCP servers, providers, memory) plus [setup-import-parts.ts](setup-import-parts.ts) (profiles, personas). A name that exists with different content refuses the import unless `--force`; `--dry-run` previews only. Blanked keys stay empty and are printed for the person to fill in.

Checks: `npx vitest run src/setup-share`.
