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

`name` (required, kebab-case), `version`, `description`, `author` (string or object), `homepage`, `repository`, `license`, `keywords`, and the path overrides `skills`, `commands`, `agents` (string or list), `hooks` and `mcpServers` (path or inline object), and `experimental.monitors` (a path or the array; a top-level `monitors` is read too). `outputStyles`, `lspServers`, `bin` and `settings` are recognised and skipped with a note.

## What each part becomes

| Part | Default location | Becomes |
|---|---|---|
| Skills | `skills/<name>/SKILL.md`, or a root `SKILL.md` | Skill `plugin:<frontmatter name>` (root skill: `plugin`) |
| Commands | `commands/**/*.md` | Terminal slash command `/plugin:name`, plus `/name` when free (see below) |
| Subagents | `agents/*.md` | Subagent profiles a Fusion task can name as `plugin:agent` |
| Hooks | `hooks/hooks.json` | Path recorded; run by the hooks engine (ATO-493) |
| MCP servers | `.mcp.json` or manifest `mcpServers` | MCP server `<plugin>-<server>`, started with the agent; local ones need code consent |
| Monitors | `monitors/monitors.json` or manifest `experimental.monitors` | A background job of each chat with a monitor on it (see below); needs code consent |

`${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are expanded in MCP server entries. Other `${VAR}` references are left as written.

## Monitors

A monitor (ATO-2438, Claude Code's plugin monitors) is `{"name", "command", "description", "when"?, "until"?}`. `command` is a shell line; `${CLAUDE_PLUGIN_ROOT}` and the other plugin path variables are filled in (quote them, a path may hold spaces), nothing else is exported to it, and `${user_config.*}` is refused. `until` is our addition: a case-insensitive line pattern; without it every non-blank line counts. `when` is `"always"` (the default). `"on-skill-invoke:<skill>"` is not supported yet: such an entry is skipped with a note. An entry with any other key is skipped with a note, the rest of the plugin still loads.

With code allowed, each monitor starts with a chat's first message in this process (`runtime/composition/runtime-plugin-monitors.ts`): in the chat's folder, with the filtered environment `os.shell.run` uses, as a kept background job of that chat with a monitor on it. It is not asked about, like a hook. Its lines reach the agent as monitor notices, with the same batching, cooldown and limits as a monitor the agent sets ([shell jobs](../../tools/os/shell/README.md)); the notice names the plugin. It shows in the agent's `jobs`, in `/ps`, and `/stop` or a `kill` ends it; it then stays stopped for that chat until Atomic Agent restarts, except after the chat's own end. It never pushes out the agent's jobs: with `tools.shell.maxJobs` already running it waits for the next message. Turning the plugin or the monitor (`monitor:<name>`) off, or stopping its code, stops it at that chat's next message. Monitors do not start for subagent or Fusion workers, nor in a channel's guest session (its turns carry the guest limits; a monitor's wake would not).

## Code consent

Skills (as text), commands, subagent profiles and remote MCP servers without keys work right after install. Parts that start programs on the computer (local stdio MCP servers, hooks, monitors, skill scripts) and MCP servers that read the user's keys stay off until the user runs `atomic-agent plugin allow-code <name>` or installs with `--accept-code`. The consent is stored as `runsCodeAccepted` and dropped on every update.

`skill.run_script` refuses scripts from a plugin skill until that consent is given (the per-call approval still applies after it).

### Keys in MCP entries

`${NAME}` and `${NAME:-default}` anywhere in a server entry (command, args, env, url, headers) are filled from the agent's environment, which includes `<data folder>/.env`. Handing a key to a plugin's server is trusted like running its code, so such a server is skipped until code is allowed. A key that is unset with no default skips the server instead of sending the literal `${NAME}`; the Plugins screen shows it as "needs a key".

## Slash commands

Each `commands/**/*.md` file is a prompt template. `commands/git/push.md` in plugin `tools` becomes `/tools:git:push`; names are lower-cased. The bare `/git:push` works too when no built-in command, skill or other plugin command claims it. Built-in commands and skills always win; a plugin never replaces them.

Typing `/tools:review src/a.ts "only tests"` renders the body and sends the result as your message for that turn, as if you had typed it:

- `$ARGUMENTS` becomes the whole argument string (`src/a.ts "only tests"`).
- `$1`..`$9` are positional arguments, split on spaces with quotes grouping words (`$1` = `src/a.ts`, `$2` = `only tests`); `$ARGUMENTS[0]` is the 0-based form. A missing one becomes empty.
- `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` (also `${PLUGIN_ROOT}`, `${PLUGIN_DATA}`) become the plugin folder and its data folder.
- When the body has no argument placeholder and you gave arguments, they are appended as `ARGUMENTS: ...`, as Claude Code does.

Frontmatter: `description` (otherwise the first body line) and `argument-hint` are shown in the palette. `allowed-tools` is a hint only and grants nothing; every tool call still goes through the normal approvals. `model` is ignored: the command runs on the current model.

Nothing in a template is executed. Claude Code runs `` !`command` `` lines and inlines `@file` references; Atomic Agent leaves both as plain text, so the model sees them and can decide to run the command or read the file through its usual, approval-gated tools. Your own commands from `.atomic-agent/commands/`, a project's `.claude/commands/`, `~/.atomic-agent/commands/` and `~/.claude/commands/` use this format too, inline `@file` and run their shell lines through the normal approval: [user-commands.md](user-commands.md).

The desktop `/` menu lists plugin commands and your own through `GET /api/commands`.

## Switching parts off

`disabledParts` in the install record holds `skill:<folder>`, `mcp:<server>`, `agent:<name>`, `command:<name>` and `hook:<event>` entries. The whole plugin is switched with `enabled`.

Installing from a marketplace: [marketplaces.md](marketplaces.md).
