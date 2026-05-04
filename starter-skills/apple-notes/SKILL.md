---
name: apple-notes
description: Manage Apple Notes via the `memo` CLI on macOS — create, view, search, edit, export.
version: 1.1.0
requires_tools:
  - os.shell.run
dangerous: false
---

# apple-notes

Drive Apple Notes from the terminal via [`memo`](https://github.com/antoniorodr/memo). Notes sync across Apple devices through iCloud.

## Setup health check (run first, every session)

Before any operation, verify state with **one solo step**:

```
[{ "tool": "os.shell.run", "args": { "cmd": "memo", "args": ["--version"] } }]
```

Outcome map:
- `exit 0` + version string → setup is healthy, proceed with the user's request.
- `exit != 0` and stderr mentions `command not found` / `memo: command not found` → enter **Setup playbook → "memo is not installed"**.
- `exit != 0` and stderr mentions `osascript` / "Not authorized to send Apple events to Notes" → enter **Setup playbook → "Automation permission denied"**.
- macOS not detected (e.g. `uname` returns `Linux`) → reply that this skill is macOS-only and stop. Do NOT try to install anything.

If unsure which branch applies, capture the actual stderr and ask the user before proceeding — never assume.

## Setup playbook (when prerequisites are missing)

When a check fails, the agent's job is to OFFER concrete help and EXECUTE the fix itself — not to dump install instructions on the user. Use this dialogue shape:

1. State plainly what is missing (one short reply).
2. Offer the most direct remediation the agent can perform via tools.
3. Wait for the user's yes/no reply.
4. On yes, execute the fix (the runtime approval gate will surface the command for confirmation).
5. Re-run the health check; only then proceed with the original request.

### memo is not installed

Reply (solo `reply` step):

> «Утилита `memo` не установлена. Я могу поставить её сам через Homebrew (`brew install antoniorodr/memo/memo`), это потребует подтверждения и ~30 секунд. Поставить?»

If user agrees, execute as **two consecutive solo steps**:

```
[{ "tool": "os.shell.run", "args": { "cmd": "brew", "args": ["tap", "antoniorodr/memo"] } }]
```

```
[{ "tool": "os.shell.run", "args": { "cmd": "brew", "args": ["install", "antoniorodr/memo/memo"] } }]
```

After both succeed, re-run the health check before doing anything else.

If `brew` itself is missing (`exit != 0`, `command not found: brew`), do NOT attempt to install Homebrew automatically — that requires `sudo` and a network curl-pipe-bash. Reply with: «У вас не установлен Homebrew. Я не могу поставить его автоматически — это требует sudo и интерактивной установки. Ставить вручную с https://brew.sh/, потом я продолжу.»

### Automation permission denied

`memo` talks to Notes.app via AppleScript; macOS guards this behind Privacy & Security → Automation. The agent cannot toggle that switch programmatically. Help the user navigate there:

```
[{ "tool": "os.shell.run", "args": { "cmd": "open", "args": ["x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"] } }]
```

Then reply:

> «Я открыл нужную панель. Найдите там вашу терминальную программу или `atomic-agent` и включите галочку рядом с Notes. После этого скажите "готово" — я повторю проверку.»

When user says готово / done, re-run the health check (`memo --version` followed by a benign `memo notes -s __probe__` to trigger the OS prompt if still pending).

## When to use

- The user asks to create, view, search, edit, move, or export Apple Notes.
- The user wants notes that sync to their iPhone / iPad / Mac via iCloud.

## When NOT to use

- Markdown-native vault management — use the `obsidian` skill instead.
- Agent-internal scratch notes that don't need to leave the agent — use the `memory.notes.store` tool.
- Bear / other note apps — `memo` only talks to Apple Notes.

## Common operations

All examples invoke `os.shell.run` with `cmd: "memo"` and the `args` array shown.

### View

| Goal | args |
|---|---|
| List all notes | `["notes"]` |
| Filter by folder | `["notes", "-f", "Folder Name"]` |
| Fuzzy search | `["notes", "-s", "query"]` |

### Create

| Goal | args |
|---|---|
| Open interactive editor | `["notes", "-a"]` |
| Quick add with title | `["notes", "-a", "Note Title"]` |

### Edit / delete / move

| Goal | args |
|---|---|
| Pick a note to edit (interactive) | `["notes", "-e"]` |
| Pick a note to delete (interactive) | `["notes", "-d"]` |
| Move a note to another folder (interactive) | `["notes", "-m"]` |

### Export

| Goal | args |
|---|---|
| Export to HTML/Markdown | `["notes", "-ex"]` |

## Limitations

- Cannot edit notes that contain images or attachments (Apple's AppleScript surface limitation).
- Interactive subcommands (`-a` without title, `-e`, `-d`, `-m`, `-ex`) need a real TTY. They will hang or error from a non-interactive shell — prefer the explicit-title form (`-a "Title"`) when scripting.
- macOS only. Do not attempt on other platforms.

## Rules

1. Confirm content and target folder with the user before creating or modifying a note.
2. Prefer Apple Notes when the user wants cross-device iCloud sync; otherwise route to `obsidian` (vault) or `memory.notes.store` (agent memory).
3. Never paste user note bodies into traces or logs without checking — Notes can contain personal data.
