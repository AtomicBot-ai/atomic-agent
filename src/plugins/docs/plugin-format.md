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
| Commands | `commands/**/*.md` | Terminal slash command `/plugin:name`, plus `/name` when free (see below) |
| Subagents | `agents/*.md` | Profiles listed by `listPluginSubagents`, not run yet |
| Hooks | `hooks/hooks.json` | Path recorded; run by the hooks engine (ATO-493) |
| MCP servers | `.mcp.json` or manifest `mcpServers` | MCP server `<plugin>-<server>`, started with the agent; local ones need code consent |

`${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are expanded in MCP server entries. Other `${VAR}` references are left as written.

## Code consent

Skills (as text), commands, subagent profiles and remote MCP servers work right after install. Parts that start programs on the computer (local stdio MCP servers, hooks, skill scripts) stay off until the user runs `atomic-agent plugin allow-code <name>` or installs with `--accept-code`. The consent is stored as `runsCodeAccepted` and dropped on every update.

## Slash commands

Each `commands/**/*.md` file is a prompt template. `commands/git/push.md` in plugin `tools` becomes `/tools:git:push`; names are lower-cased. The bare `/git:push` works too when no built-in command, skill or other plugin command claims it. Built-in commands and skills always win; a plugin never replaces them.

Typing `/tools:review src/a.ts "only tests"` renders the body and sends the result as your message for that turn, as if you had typed it:

- `$ARGUMENTS` becomes the whole argument string (`src/a.ts "only tests"`).
- `$1`..`$9` are positional arguments, split on spaces with quotes grouping words (`$1` = `src/a.ts`, `$2` = `only tests`); `$ARGUMENTS[0]` is the 0-based form. A missing one becomes empty.
- `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` (also `${PLUGIN_ROOT}`, `${PLUGIN_DATA}`) become the plugin folder and its data folder.
- When the body has no argument placeholder and you gave arguments, they are appended as `ARGUMENTS: ...`, as Claude Code does.

Frontmatter: `description` (otherwise the first body line) and `argument-hint` are shown in the palette. `allowed-tools` is a hint only and grants nothing; every tool call still goes through the normal approvals. `model` is ignored: the command runs on the current model.

Nothing in a template is executed. Claude Code runs `` !`command` `` lines and inlines `@file` references; Atomic Agent leaves both as plain text, so the model sees them and can decide to run the command or read the file through its usual, approval-gated tools. User commands from `~/.claude/commands` are not loaded; only installed plugins provide commands.

The desktop app does not list plugin commands yet.

## Switching parts off

`disabledParts` in the install record holds `skill:<folder>`, `mcp:<server>`, `agent:<name>`, `command:<name>` and `hook:<event>` entries. The whole plugin is switched with `enabled`.

Installing from a marketplace: [marketplaces.md](marketplaces.md).
