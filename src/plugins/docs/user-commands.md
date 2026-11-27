# Your own slash commands

Status: current
Owner: src/plugins/user-commands.ts

Drop a Markdown file into a commands folder and it becomes a slash command, with no plugin to package. `commit.md` gives `/commit`; `team/review.md` gives `/team:review`. Names are lower-cased; a file name with spaces or other characters outside `a-z 0-9 . _ -` is reported and skipped.

## Folders

First match wins on a name:

1. `<project>/.atomic-agent/commands/`, then `<project>/.claude/commands/` (so a repository's Claude Code commands work as they are). Each project command file is its own item in the [project folder trust](../../skills/docs/project-trust.md) question, trusted for its exact text (ATO-2531): a new file, or a trusted file someone edits, does not appear and does not run until the question asks about it again and you say yes. Trusting a skill or `AGENTS.md` does not trust the commands. A project command that is not trusted does not hide a profile command with the same name.
2. `<stateDir>/commands/`, the profile folder (`~/.atomic-agent/commands/` by default), for commands you want everywhere.

Plugin commands come after both, so your `/review` keeps the bare name even when a plugin ships `review`; the plugin's stays reachable as `/plugin:review`. Built-in commands and skills always win. The palette marks your commands `(project)` or `(profile)`. When a file does not load as written, the terminal says so once in the chat, naming the file and the reason (ATO-2773): a file named like a built-in (`help.md`) is skipped with "rename the file", as are a bad file name and a file over 128 KiB; a front matter block that does not parse (with its line), never closes or is not `key: value` lines keeps the command but drops its description and argument hint. The folders are read again every time the palette refreshes and when a command runs, so a new or edited file needs no restart.

## What a file can do

The format is the plugin command format ([plugin-format.md](plugin-format.md)): frontmatter `description` and `argument-hint`, `$ARGUMENTS`, `$1`..`$9`, the `ARGUMENTS: ...` fallback. `allowed-tools` grants nothing and `model` is ignored.

On top of that, `@path` (Claude Code) and `@{path}` (Gemini CLI) inline a file, exactly as an `@file` you type in the terminal composer: only files inside the session's working folder, with the same size caps, listed in a block after your message. A word after `@` that names no file stays plain text.

Nothing in a template is executed: `` !`command` `` and `!{command}` stay plain text. The terminal is the only frontend that lists these commands for now.
