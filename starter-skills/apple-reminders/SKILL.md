---
name: apple-reminders
description: Manage Apple Reminders via the `remindctl` CLI on macOS — list, add, complete, delete, manage lists.
version: 1.2.1
requires_tools:
  - os.shell.run
dangerous: false
platforms:
  - darwin
---

# apple-reminders

Drive Apple Reminders from the terminal via [`remindctl`](https://github.com/steipete/remindctl). Reminders sync across Apple devices through iCloud.

## Setup check (lazy — do NOT probe every turn)

Do **not** run a `remindctl status` probe before each request. Just run the
`remindctl` command the user asked for directly. Only when a command
**fails** map the error to a Setup playbook branch:

- stderr contains `command not found: remindctl` → **Setup playbook → "remindctl is not installed"**.
- output says permission `denied` / `not determined` / `restricted` → **Setup playbook → "Reminders permission missing"**.
- macOS not detected → reply that this skill is macOS-only and stop. Do NOT try to install anything.

If unsure which branch applies, capture stderr and ask the user before proceeding.

## Setup playbook (when prerequisites are missing)

When a check fails, the agent's job is to OFFER concrete help and EXECUTE the fix itself — not to dump install instructions on the user. Use this dialogue shape:

1. State plainly what is missing (one short reply).
2. Offer the most direct remediation the agent can perform via tools.
3. Wait for the user's yes/no reply.
4. On yes, execute the fix (the runtime approval gate will surface the command for confirmation).
5. Retry the original request; only then proceed.

### remindctl is not installed

Reply (solo `reply` step):

> «Утилита `remindctl` не установлена. Могу поставить её через Homebrew (`brew install steipete/tap/remindctl`) — потребуется подтверждение и около 20 секунд. Поставить?»

On yes:

```
[{ "tool": "os.shell.run", "args": { "cmd": "brew", "args": ["install", "steipete/tap/remindctl"] } }]
```

After install, retry the original command.

If `brew` itself is missing, do NOT attempt to bootstrap Homebrew — reply: «У вас не установлен Homebrew. Поставьте его вручную с https://brew.sh/, потом я продолжу.»

### Reminders permission missing

Unlike Notes Automation, `remindctl` has its own CLI command to request the permission — the agent CAN do it directly. Offer + execute:

> «У `remindctl` нет разрешения на доступ к Reminders. Запросить сейчас? Появится системный диалог, в нём нажмите "Allow".»

On yes:

```
[{ "tool": "os.shell.run", "args": { "cmd": "remindctl", "args": ["authorize"] } }]
```

Then re-run `remindctl status` to verify. If it still says `denied`, fall back to opening System Settings:

```
[{ "tool": "os.shell.run", "args": { "cmd": "open", "args": ["x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders"] } }]
```

…and ask the user to flip the toggle for the terminal/agent process, then re-check.

## When to use

- The user mentions "reminder" or "Reminders app".
- Creating personal to-dos with due dates that should appear on their iPhone / iPad.
- Listing or completing items in an Apple Reminders list.

## When NOT to use

- Scheduling agent-driven background work — use the `tasks.schedule` / `tasks.cron` tools.
- Calendar events with a fixed start/end time and attendees — use a calendar skill.
- Project / engineering task management — use GitHub Issues, Notion, etc.
- If the user says "remind me" but actually means an in-agent alert, clarify before reaching for `remindctl`.

## Common operations

All examples invoke `os.shell.run` with `cmd: "remindctl"` and the `args` array shown. Add `["--json"]` to any read command for machine-readable output.

### View

| Goal | args |
|---|---|
| Today | `["today"]` (or just `[]` — `today` is the default) |
| Tomorrow | `["tomorrow"]` |
| This week | `["week"]` |
| Past due | `["overdue"]` |
| Everything | `["all"]` |
| Specific date | `["2026-01-04"]` |
| JSON output | append `"--json"` to any of the above |
| TSV output | append `"--plain"` |
| Counts only | append `"--quiet"` |

### Manage lists

| Goal | args |
|---|---|
| List all lists | `["list"]` |
| Show items in a list | `["list", "Work"]` |
| Create a list | `["list", "Projects", "--create"]` |
| Delete a list | `["list", "Work", "--delete"]` |

### Create reminders

| Goal | args |
|---|---|
| Quick add | `["add", "Buy milk"]` |
| Add with list and due | `["add", "--title", "Call mom", "--list", "Personal", "--due", "tomorrow"]` |
| Add with explicit datetime | `["add", "--title", "Meeting prep", "--due", "2026-02-15 09:00"]` |

### Complete / delete

| Goal | args |
|---|---|
| Complete one or more by id | `["complete", "1", "2", "3"]` |
| Delete by id | `["delete", "4A83", "--force"]` |

## Date formats

Accepted by `--due` and date filters:

- Relative: `today`, `tomorrow`, `yesterday`
- Date: `YYYY-MM-DD`
- Date+time: `YYYY-MM-DD HH:mm`
- ISO 8601: `2026-01-04T12:34:56Z`

## Rules

1. When the user says "remind me", clarify: Apple Reminders (syncs to phone) vs an agent-driven alert (`tasks.schedule` / `tasks.cron`).
2. Always confirm reminder content, list, and due date with the user before creating or completing.
3. Prefer `--json` whenever you need to parse the output programmatically; the human-formatted view changes between releases.
