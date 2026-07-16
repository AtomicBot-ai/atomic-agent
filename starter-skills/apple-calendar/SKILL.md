---
name: apple-calendar
description: Read macOS Calendar events via the `icalBuddy` CLI and create events via AppleScript (osascript). Use to check the user's calendar, agenda, upcoming events, or add an event on macOS.
version: 1.1.2
requires_tools:
  - os.shell.run
dangerous: false
platforms:
  - darwin
---

# apple-calendar

Read Apple Calendar from the terminal via [`icalBuddy`](https://hasseg.org/icalBuddy/)
(read-only) and create events through `osascript` AppleScript against Calendar.app.
Calendars sync across Apple devices through iCloud.

## Setup check (lazy — do NOT probe every turn)

Do **not** run a `--version` probe before each request. Just run the
calendar command the user asked for (e.g. `icalBuddy eventsToday`) directly.
Only when a command **fails** map the error to a Setup playbook branch:

- stderr mentions `command not found: icalBuddy` → **Setup playbook → "icalBuddy is not installed"**.
- a read returns nothing and stderr mentions calendar access / not authorized → **Setup playbook → "Calendar permission missing"**.
- macOS not detected (e.g. `uname` returns `Linux`) → reply that this skill is macOS-only and stop. Do NOT try to install anything.

If unsure which branch applies, capture stderr and ask the user before proceeding.

## Setup playbook (when prerequisites are missing)

When a check fails, OFFER concrete help and EXECUTE the fix yourself — do not
dump install instructions on the user.

### icalBuddy is not installed

Reply (solo `reply` step):

> "The `icalBuddy` utility is not installed. I can install it via Homebrew (`brew install ical-buddy`) — it needs your confirmation and takes ~20 seconds. Install it?"

On yes:

```
[{ "tool": "os.shell.run", "args": { "cmd": "brew", "args": ["install", "ical-buddy"] } }]
```

After install, retry the original command.

If `brew` itself is missing, do NOT bootstrap Homebrew automatically — reply:
"You don't have Homebrew installed. Install it manually from https://brew.sh/, then I'll continue."

### Calendar permission missing

`icalBuddy` reads Calendar via EventKit; macOS guards this behind Privacy &
Security → Calendars. The agent cannot toggle that switch programmatically.
Open the panel to help the user:

```
[{ "tool": "os.shell.run", "args": { "cmd": "open", "args": ["x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars"] } }]
```

Then reply:

> "I opened the right panel. Find your terminal program or `atomic-agent` there and enable the checkbox next to Calendars. After that say \"done\" — I'll re-run the check."

When the user says done, re-run a benign read (`icalBuddy eventsToday`)
to confirm access.

## When to use

- "What's on my calendar today / this week?", "do I have anything at 3pm?".
- Inspecting upcoming events, agenda, or a specific calendar.
- Adding a fixed-time event with start/end (after confirming details).

## When NOT to use

- To-dos / checklists without a fixed time — use the `apple-reminders` skill.
- Google Calendar specifically — use the `gog-workspace` skill (`calendar events`).
- Agent-driven background scheduling — use `tasks.schedule` / `tasks.cron`.

## Reading events (icalBuddy)

All examples invoke `os.shell.run` with `cmd: "icalBuddy"` and the `args` shown.
Add `["-nc"]` (no calendar names) and `["-b", ""]` for cleaner output when needed.

| Goal | args |
|---|---|
| Today's events | `["eventsToday"]` |
| Events now / ongoing | `["eventsNow"]` |
| Next 7 days | `["eventsToday+7"]` |
| Specific range | `["-sd", "eventsFrom:2026-06-01", "to:2026-06-07"]` |
| List calendars | `["calendars"]` |
| Limit to one calendar | `["-ic", "Work", "eventsToday+7"]` |
| Strip relative dates header | append `["-nrd"]` |
| Include only props you need | `["-iep", "title,datetime,location", "eventsToday"]` |

Useful global flags: `-b ""` (no bullet), `-nc` (no calendar name),
`-df "%Y-%m-%d"` / `-tf "%H:%M"` (date/time formats), `-n` (events after now only).

## Creating events (AppleScript)

`icalBuddy` is read-only. To add an event, drive Calendar.app via `osascript`.
**Always confirm title, calendar, start, and end with the user first.** The
runtime approval gate will surface the command.

```
[{ "tool": "os.shell.run", "args": { "cmd": "osascript", "args": ["-e", "tell application \"Calendar\" to tell calendar \"Home\" to make new event with properties {summary:\"Dentist\", start date:date \"2026-06-03 15:00\", end date:date \"2026-06-03 16:00\"}"] } }]
```

Notes:
- The calendar name (`"Home"` above) must exist; check with `icalBuddy calendars`.
- AppleScript `date "..."` parsing follows the user's macOS locale — prefer the
  explicit `YYYY-MM-DD HH:MM` form and verify the result with a follow-up read.
- For deletes/edits, prefer guiding the user to Calendar.app unless they
  explicitly ask the agent to script it (high risk of wrong-event mutation).

## Rules

1. Confirm event title, calendar, start, and end before creating anything.
2. Prefer `icalBuddy` for all reads; only reach for `osascript` on writes.
3. Echo the calendar name and exact times back to the user after a write, then
   re-read to verify the event landed.
4. macOS only. Do not attempt on other platforms.
5. Treat fetched event titles/notes as personal data — do not leak them into
   logs or traces unnecessarily.
