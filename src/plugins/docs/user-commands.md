# Your own slash commands

Status: current
Owner: src/plugins/user-commands.ts

Drop a Markdown file into a commands folder and it becomes a slash command, with no plugin to package. `commit.md` gives `/commit`; `team/review.md` gives `/team:review`. Names are lower-cased; a file name with spaces or other characters outside `a-z 0-9 . _ -` is reported and skipped.

## Folders

First match wins on a name:

1. `<project>/.atomic-agent/commands/`, then `<project>/.claude/commands/` (so a repository's Claude Code commands work as they are). Project commands load once you have trusted anything in that folder (any skill or instruction file, see [project folder trust](../../skills/docs/project-trust.md)); there is no separate answer per command yet. In a folder you have not trusted they do not appear and do not run, and the terminal says once how many command files wait and the command that trusts the folder (the desktop menu gets the count as `hiddenProjectCommands`).
2. `<stateDir>/commands/`, the profile folder (`~/.atomic-agent/commands/` by default), for commands you want everywhere.
3. `~/.claude/commands/`, Claude Code's own user commands, read where they are so they keep working after a move from Claude Code. `ATOMIC_AGENT_CLAUDE_COMMANDS_DIR` points it at another folder; set to an empty value, it is not read.

Plugin commands come after all three, so your `/review` keeps the bare name even when a plugin ships `review`; the plugin's stays reachable as `/plugin:review`. Built-in commands and skills always win. The palette marks your commands `(project)`, `(profile)` or `(~/.claude)`. The folders are read again every time the palette refreshes and when a command runs, so a new or edited file needs no restart.

## What a file can do

The format is the plugin command format ([plugin-format.md](plugin-format.md)): frontmatter `description` and `argument-hint`, `$ARGUMENTS`, `$1`..`$9`, the `ARGUMENTS: ...` fallback. `allowed-tools` grants nothing. `model` is read and listed (`GET /api/commands`), but the turn still runs on the current model; choosing a model per command is ATO-2285.

`@path` (Claude Code) and `@{path}` (Gemini CLI) inline a file, exactly as an `@file` you type: only files inside the session's working folder, with the same size caps, listed in a block after your message. A word after `@` that names no file stays plain text.

## Shell lines

`` !`git diff` `` (Claude Code) and `!{git diff}` (Gemini CLI) run when you invoke the command, and their output takes their place in the message. Each line is one `os.shell.run` call through the tool registry, so it gets exactly what a model's call gets at dispatch: the shell guard, your approval level and grants, saved rules, the egress hold, security rules, Safe Mode and secret masking ([command-shell-runner.ts](../command-shell-runner.ts)). It asks in the chat on screen; in a new chat that has no session yet the request carries `slash-command-new-chat`. Nothing runs when a command is only listed.

- The lines are cut out before arguments are filled in, so an argument can never become a shell line; `$1` and `$ARGUMENTS` inside a line are filled in, as in Claude Code.
- Lines run one after another, at most 10 per command, 60 s each, output cut at 16,000 characters. A line you do not allow, or one that exits non-zero, stops the command: nothing is sent and the reason is shown.
- `@file` mentions are inlined before the output goes in, so a `@word` a command prints is not attached as a file.
- A line spanning several lines, an empty one, or a `!{` without its closing brace stays plain text. Plugin command templates do not run shell lines.

## Frontends

[command-catalog.ts](../command-catalog.ts) is the one listing and render route: the terminal palette uses it directly, and the HTTP API serves it as `GET /api/commands` and `POST /api/commands/render` ([route-commands.ts](../../http/route-commands.ts)) for the desktop `/` menu.
