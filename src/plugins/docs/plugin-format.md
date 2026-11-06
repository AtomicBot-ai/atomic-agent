# Plugin format

Status: current
Owner: src/plugins/

## Detection order

1. `.claude-plugin/plugin.json` (Claude Code)
2. `.codex-plugin/plugin.json` (Codex)
3. `.cursor-plugin/plugin.json` (Cursor)
4. `plugin.json` at the root (Agent Plugins 1.0)
5. No manifest, but a Claude layout: `SKILL.md`, `skills/`, `commands/`, `agents/`, `hooks/` or `.mcp.json`. The folder name becomes the plugin name.

## Manifest fields read

`name` (required, kebab-case), `version`, `description`, `author` (string or object), `homepage`, `repository`, `license`, `keywords`, and the path overrides `skills`, `commands`, `agents` (string or list), `hooks` and `mcpServers` (path or inline object). `outputStyles`, `lspServers`, `monitors`, `bin` and `settings` are recognised and skipped with a note.

## What each part becomes

| Part | Default location | Becomes |
|---|---|---|
| Skills | `skills/<name>/SKILL.md`, or a root `SKILL.md` | Skill `plugin:<frontmatter name>` (root skill: `plugin`) |
| Commands | `commands/**/*.md` | Listed now; slash commands `/plugin:name` arrive with ATO-952 |
| Subagents | `agents/*.md` | Profiles listed by `listPluginSubagents`, not run yet |
| Hooks | `hooks/hooks.json` | Path recorded; run by the hooks engine (ATO-493) |
| MCP servers | `.mcp.json` or manifest `mcpServers` | MCP server `<plugin>-<server>`, started with the agent; local ones need code consent |

`${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are expanded in MCP server entries. Other `${VAR}` references are left as written.

## Code consent

Skills (as text), commands, subagent profiles and remote MCP servers without keys work right after install. Parts that start programs on the computer (local stdio MCP servers, hooks, skill scripts) and MCP servers that read the user's keys stay off until the user runs `atomic-agent plugin allow-code <name>` or installs with `--accept-code`. The consent is stored as `runsCodeAccepted` and dropped on every update.

`skill.run_script` refuses scripts from a plugin skill until that consent is given (the per-call approval still applies after it).

### Keys in MCP entries

`${NAME}` and `${NAME:-default}` anywhere in a server entry (command, args, env, url, headers) are filled from the agent's environment, which includes `<data folder>/.env`. Handing a key to a plugin's server is trusted like running its code, so such a server is skipped until code is allowed. A key that is unset with no default skips the server instead of sending the literal `${NAME}`; the Plugins screen shows it as "needs a key".

## Switching parts off

`disabledParts` in the install record holds `skill:<folder>`, `mcp:<server>`, `agent:<name>`, `command:<name>` and `hook:<event>` entries. The whole plugin is switched with `enabled`.
