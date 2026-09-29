# Atomic Agent TUI

Atomic Agent has two front ends. Use the CLI for simple sessions, automation, and debugging. Use the TUI for an interactive control console: approvals, logs, models, skills, tasks, memory, MCP, channels, and traces.

```bash
atomic-agent run --cwd /path/to/work
atomic-agent tui --cwd /path/to/work

atomic-agent skill list
atomic-agent task list
atomic-agent trace list --limit 10
```

## Slash Commands

- `/help` lists every command.
- `/tools` lists the built-in tool families.
- `/model` jumps to the LLM panel and reopens the model picker for the active cloud provider. It also switches models mid-session.
- `/privacy` shows what leaves the machine. `/privacy analytics off` turns analytics off.
- `/context` opens the context breakdown (see below).
- `/mode` opens the coding modes menu. `/mode <name>` sets a mode directly.
- `/theme` lists the palettes. `/theme <name>` switches.
- `/mouse off` hands text selection back to the terminal.

The chat log scrolls with PgUp / PgDn (fn+arrows on macOS).

## Context Readout

The chip at the right of the composer shows a bar and a line such as `8/20 tasks · 39.9k/48k cap · 262k`. That is the transcript measured against the ceiling it is packed to, with the model's context window as the last figure, so you can see whether there is room for what you are about to send.

### Tasks, Not Tokens

History is limited in tasks, not tokens. One task is a thing you asked plus everything the agent did answering it. `agent.conversationMaxPairs` (1-1000, default 200) sets how many tasks the prompt carries.

Tokens are the wrong unit to steer with, because nobody thinks in them. They are still the ceiling underneath: one task can run twenty tool calls, and no task count keeps a prompt inside the window on its own.

### When History Is Dropped

Once history has been dropped, the chip says so in words (`· 3 tasks lost`) and turns violet. That is the point where the agent stops knowing things it knew a minute ago, and answers quietly start getting less consistent.

Cloud models take their window from the model catalogue, so the gauge is drawn against a real scale there too. When nothing has set a scale yet, the chip shows only the running total.

### The Breakdown and the Task Selector

Click the chip (or run `/context`) for the breakdown. It holds the one control that matters: a selector for how many tasks the next prompt carries, with a button on either side of the number (`-` and `+` from the keyboard). Every figure above it (the total, the percentage, the `conversation` row, the free space) recalculates as you move it, so you see the cost of the choice while you make it rather than one turn later. Each step applies immediately; there is nothing to confirm.

### The Token Ceiling

`agent.conversationMaxTokens` still exists as the ceiling underneath. Its default, `0`, fills whatever the window leaves (64k when the window is unknown). Set a number to pin a tighter ceiling, for example on a metered cloud model. You do not have to think about it: the task count is the limit you steer with, and the token cap only intervenes when a single task is large enough to threaten the window on its own.

## Coding Modes

A chip at the right end of the composer's bar says which rules are in force. Click it, press `ctrl+g M`, or run `/mode` to open a menu of the four modes, each with a line saying what it does. ↑↓ moves, Enter applies, Esc cancels. `/mode <name>` sets one directly without the menu.

| Mode | What it does |
|---|---|
| `default` | Approvals follow your configured approval level (`agent.approvalLevel` in `config.json`). |
| `plan` | Read-only. Every tool that would change something is refused, with a note telling the agent to present a plan instead. Reading, searching, and fetching still work. |
| `auto` | File writes inside this workspace stop asking; everything else still does. |
| `bypass permissions` | Nothing asks, for this session. Hardline shell-guard rules still block. |

### Plan Mode Handoff

When the plan lands, three buttons appear under the plan itself, beside its `[copy]` row: run it in `auto`, run it in `bypass permissions`, or dismiss it. Typing instead keeps you in plan mode and revises the plan. The composer says so while the offer is up.

### Modes Are Session State

All four modes are session state, and none are written to `config.json`. A `bypass` that survived a restart would be a standing grant nobody remembers making. `default` restores the level you actually configured, so a session that passed through `bypass` and back lands where it started. The cycle order keeps `plan` and `bypass` two presses apart in either direction.

## Answering an Approval Prompt

The prompt draws its verbs as buttons. Click one, or use its chord:

| Chord | Action |
|---|---|
| `ctrl+y` | Approve the call. |
| `ctrl+d` | Deny. |
| `ctrl+f` | Grant its category for the session. |
| `ctrl+b` | Retarget a write (`os.fs.write`) or grant a command shape (`shell`). |
| `esc` | Abort the run. |

Every decision is a chord and never a bare letter, because the input field below stays live: typing "yes, but put it somewhere else" must be a message, not a verdict.

### Write It Somewhere Else (`ctrl+b` on a Write)

On an `os.fs.write` prompt, `ctrl+b` turns the target path into an editable field, prefilled with the full path. Type any other target (`~` works, missing folders are created) and Enter confirms it. The new path is re-checked against the approval ladder first:

- A target on the same rung as the one you approved is written.
- A target on a different rung (workspace to home, say) asks once more.
- A target that is the agent's own `config.json` or `.env` is refused.

### Grant a Command Shape (`ctrl+b` on a Shell Call)

On a `shell` prompt, `ctrl+b` grants the command's shape for the session (`git`, `npm`) instead of the whole category. The exception is `bash -c`-style interpreters: there the binary name hides what actually runs, so no shape grant is offered.

The retarget and the shape grant share `ctrl+b` because they can never both be on screen: one is `os.fs.write` only, the other `shell` only.

### Just Type

The input field stays live under the prompt, so you can answer the agent in words, for example "put the site in ~/Documents/apple-site and use an inline SVG". Enter cancels the pending call with your message as its reason (the model reads it as the tool result) and folds the same text into the running turn, so the run keeps going instead of dying.

The chords keep working while you type, so you can start a message, change your mind, and approve without clearing it first. `esc` is the one exception: with a draft in the buffer, it clears the draft rather than aborting the run.

## Themes

The TUI defaults to the `classic-dark` palette (`classic-light` when it detects a light terminal): an indigo rail, raised `+ new` / `≡ Menu` / `send →` controls, the session title in the top bar, `AGENT` / `YOU` labels on the transcript, and green tool results.

Five more palettes ship with it: `classic-light`, `toxic-green`, `khorne-red`, `darky-dark`, and `moon-yellow`. `/theme` lists them, `/theme <name>` switches, and the choice persists.

All six are designed for Atomic Agent rather than transcribed from upstream terminal themes, and every colour pair the UI paints is held to WCAG AA contrast. Configs naming a retired theme are rehomed to the nearest surviving palette rather than silently reset.

## Small Windows

The layout degrades as the window shrinks: the right rail drops at 100 columns, the splash art steps down through three sizes, and the chrome grows under 60 columns. The floor is 40x16.

Below the floor, the TUI stops drawing the normal UI, because a frame taller than the terminal would paint over itself rather than fit. Instead it draws a single card saying what size it needs and what it has, on the main screen and the first-run screen alike, and goes back to the real UI as soon as the window is dragged big enough.

## Mouse and Text Selection

### Clicking

The TUI is clickable:

- the breadcrumb (which opens the menu, the same as Esc on an idle prompt)
- sidebar sessions and tasks
- every list row (skills, tasks, memory, MCP, models, providers)
- the session, theme, and slash pickers
- approval buttons and tool cards
- the buttons under a chat message: `[copy]`, `[try again]`, and `[switch back]` on a notice about a turn left running in another thread
- the prompt itself: clicking in the input places the caret

A click selects a row, a second click on the selected row opens it, and the wheel scrolls the chat or walks the focused panel.

### Selecting Text

While mouse reporting is on, the terminal hands clicks to the app, so its own plain drag-to-select is unavailable. That is a terminal-level constraint, not a choice.

To select text, just drag over it. A drag that starts on plain text (a chat message, panel prose, empty rail space) pauses the mouse for 10 seconds and says so in chat. Drag again to select, then copy the way you normally would. The pause ends on its own and clicks come back. This works in every terminal, with no modifier to remember.

Some terminals also offer an instant path:

- A Shift-modified drag bypasses reporting natively on kitty, WezTerm, GNOME Terminal, and Windows Terminal.
- iTerm2 reserves Option for the same thing.

There the selection happens immediately, no pause needed. Where the app sees the shifted or alt-modified press instead (Apple Terminal), it opens the same 10-second pause.

### Turning the Mouse Off

To hand selection to the terminal permanently:

- `/mouse off` in the app
- `atomic-agent tui --no-mouse` for one run
- `"tui": { "mouse": false }` in `<stateDir>/config.json`

With mouse off, wheel scrolling still works through the terminal's alternate-scroll mode.

If a terminal (or an ssh hop) answers the tracking request with reports the app cannot decode, the TUI turns mouse support off by itself for that session, with a chat notice, instead of letting coordinates spill into the composer.

## Cloud Providers

### Model Catalog

Cloud provider setup pulls each provider's full live model catalog, hundreds of models, instead of a short hardcoded list. OpenAI-compatible servers are asked for their own `/v1/models`. The picker filters as you type, and `/model` switches models mid-session.

### Key Verification

A cloud key is checked before it is saved. The key screen refuses an empty key, and finishing the wizard asks the provider for a one-token completion from its cheapest model. A key that is rejected, or attached to an account with no balance, never reaches `.env` and never becomes the active provider.

A provider that cannot be reached at all still saves, with a line saying the key went unverified, so an offline or proxied machine stays configurable. Local servers have no account to check and are left alone.

## When a Turn Ends

A turn that fails, or finishes after running 30 seconds or more, raises a desktop notification (macOS, and Linux with `notify-send`) plus a terminal notification and bell, so you can walk away. Tune it with `tui.notify.enabled` and `tui.notify.minDurationMs`. Each session is also named from its first prompt after the first reply, so the rail and header show what the thread is about; `agent.nameSessions: false` keeps the raw prompt.

## herdr

Run inside a [herdr](https://github.com/herdrdev/herdr) pane and the TUI labels the pane itself: working while a turn runs, blocked while an approval or a plan hand-off waits on you, idle otherwise, and it releases the label on exit. It turns on by itself when herdr's pane environment is present; nothing to configure.
