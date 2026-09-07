# desktop/test — driving the app the way a person does

`npm run smoke` drives the renderer through `window.__*` hooks, which call
internal functions directly. That is fast and it covers a great deal, but a
hook that skips the event handler proves nothing about what a person
experiences: a wizard row whose click listener never fires still passes every
hook-driven check, because the hook called the function the click was supposed
to reach. That is how ~490 green assertions coexisted with a first-run screen
whose `Next` button was wired to nothing.

The files here are the other half. Everything they do goes through the Chrome
DevTools Protocol's `Input` domain — `Input.dispatchMouseEvent` produces a
TRUSTED click, `Input.dispatchKeyEvent` / `Input.insertText` trusted typing —
so the app cannot tell them apart from a hand. `Runtime.evaluate` is used for
LOOKING ONLY: text, classes, geometry, screenshots. If a step could only be
performed by calling an internal function, that is a bug in the app, not a
reason to call the function.

## The drivers

Four lanes wrote a driver against the same protocol in the same week and
arrived at four shapes that cannot be folded into one exported name without
changing what somebody's scenarios assert (`waitFor` takes a selector in one
and an expression in another; `press` takes an options object in one and an
array of modifiers in another; `snap` describes the onboarding surface in one
and the whole app in another). Rather than rewrite four proven scenarios
against a fifth API nobody has driven, the integration keeps them side by side
and each scenario imports the driver it was proved against.

| file | who uses it |
| --- | --- |
| `drive.mjs` | **the canonical one — write new scenarios against this.** `launch`, `clickText`, `clickSel`, `type`, `typeSecret`, `press`, `waitFor`, `snap`, `lastReply`, `replies`, `screenshot`, `close`. Used by `harness.mjs` and everything under `scenarios/` |
| `drive-ux.mjs` | `onboarding-mouse.mjs` — adds `hover`, `moveAway`, `clearField`, `focusInfo`, `waitStep`, and an onboarding-shaped `snap()` |
| `drive-selector-lib.mjs` | `drive-selector.mjs` — adds `tape()`, and the port-quiet / kill-the-group discipline that lane learned the hard way |
| `drive-cloud-lib.mjs` | `cloud-setup.drive.mjs` — adds `check` / `step` / `report`, a transcript reader that knows rows are `#scroller .col720 > .turn` (there is no `#log`), and a reply matcher that waits for assistant PROSE so a `Reasoning · 1 steps` card is not mistaken for the answer |

## The scenarios

| file | what it drives | command |
| --- | --- | --- |
| `scenarios/01`…`05` + `run-all.mjs` | five end-to-end human errands: build a website, write a document, arrange files, hold a conversation, answer an approval | `npm run scenarios` |
| `onboarding-mouse.mjs` | the whole first-run wizard with the mouse, plus a resting-state design review of every screen | `npm run drive:onboarding` |
| `drive-selector.mjs` | the composer's parameter controls across the three backends (`composerSwitchKindsFor`), and the pane Settings › LLM opens on | `npm run drive:selector` |
| `cloud-setup.drive.mjs` | the cloud providers end to end against the real OpenRouter and AI/ML API | `npm run drive:cloud` |

## Running one

```sh
cd desktop && npm run build
ATOMIC_AGENT_STATE_DIR=/tmp/some-throwaway-state \
  node test/drive-selector.mjs --port 9403 --state /tmp/some-throwaway-state --shots /tmp/shots
```

`--state` is required and never defaults: the desktop's own default state
directory is the operator's live app data. `drive.mjs` refuses outright to
launch against `~/.atomic-agent` or `~/.atomic-agent-desktop`.

`cloud-setup.drive.mjs` is driven by environment instead:

```sh
ATAG_DRIVE_STATE_SEED=/dir/with/a/.env ATAG_DRIVE_PORT=9402 npm run drive:cloud
```

`ATAG_DRIVE_STATE_SEED` names a directory containing a `.env` with
`OPENROUTER_API_KEY` and `AIMLAPI_API_KEY`. It is only ever read: the run gets
its own fresh state directory under the OS temp dir with a copy of that `.env`
in it, so a first run is genuinely a first run and no existing installation is
touched. `ATAG_DRIVE_KEEP=1` leaves that directory behind for inspection. Keys
are typed into the wizard and never logged — no check prints a field's value,
only its length. It costs a handful of tokens on both services every run, so
it is a deliberate command rather than part of `npm run smoke`.

Give every concurrent run its own debugging port.

## Traps, each of which cost somebody a run

- **Kill the whole tree.** `npx electron .` is three processes; `SIGTERM` to
  the first leaves the window up holding the debug port, and the next
  `launch()` silently attaches to the OLD window and reports yesterday's
  screen. The drivers now kill the process group, wait for the port to go
  quiet, and refuse to launch onto a port that already answers.
- **One debugger client at a time.** Chromium gives a page target to a single
  debugger session, so attaching a second socket to peek at a run in flight
  silently detaches the first and the scenario hangs where it stood. Watch a
  run through its log, never by attaching.
- **Never press Escape to close a popup.** Escape in this app opens the Manage
  menu — the user asked for that — and the settings window it raises then
  covers the composer, so the next click lands on the overlay and reports
  "covered by DIV". Click the popup's own Done button, as a person does.
- **Wait for the screen to stop moving.** The composer paints the route the
  operator clicked before the write lands (`SWX.want`), and a fresh window
  draws its chips from defaults until the first `/api/config` answer arrives.
  Read either one too early and you are reading a screen nobody will ever see.
  `drive-selector.mjs` waits for the transcript's `connected to atomic-agent`
  line, then for two identical reads of the strip with no lock and no
  `switching…`.
- **Read a resting style with the pointer parked elsewhere.** A click leaves
  the mouse on the button it pressed, so `:hover` is still applying and a
  border that exists only on hover measures as a border that is always there.
  `drive-ux.mjs` has `moveAway()` for exactly this.
- **Escape a backslash properly inside a template literal.** A label reader
  written as `` `…replace(/\s+/g,' ')…` `` loses the backslash and becomes
  `/s+/`, which replaces the letter s: the transcript then reports
  `"Skip  etup for now"` and lies to you about what is on screen.

## One known red

`cloud-setup.drive.mjs` step 15 — the first turn after switching to a
different cloud model — fails in most runs with `turn failed [transport]:
fetch failed`, which the app reports honestly on screen and the session trace
confirms (two `error` frames, `turn_finished reason:failed`, no
`llm_completion`). The same key and model answer a plain curl, and the two
turns before it succeed on the same agent, so the fault is in the agent's own
request on the first turn after the switch (`src/agent/step-executor.ts`),
outside this desktop tree. The check stays red on purpose: it names a turn the
operator cannot run.
