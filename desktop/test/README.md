# desktop/test — driving the app the way a person does

`npm run smoke` drives the renderer through `window.__*` hooks, which call
internal functions directly. That is fast and it is blind: a hook proves the
function works and says nothing about whether a person clicking the thing on
screen ever reaches it. A row whose click handler is missing passes every hook
check and is broken for every user.

The files here close that gap. Everything they do goes through the Chrome
DevTools Protocol's `Input` domain — `Input.dispatchMouseEvent` produces a
TRUSTED click, `Input.insertText` trusted typing — so the app cannot tell them
apart from a hand. `Runtime.evaluate` is used for LOOKING ONLY: text, classes,
geometry, screenshots. If a step could only be performed by calling an internal
function, that is a bug in the app, not a reason to call the function.

## Files

| file | what it is |
| --- | --- |
| `drive.mjs` | the driver: `launch`, `clickSel`, `clickText`, `type`, `press`, `fill`, `waitFor`, `snap`, `screenshot`, plus a `tape()` that prints a scenario as a transcript |
| `drive-selector.mjs` | the composer's parameter controls across the three backends (`composerSwitchKindsFor`), and the pane Settings › LLM opens on |

## Running one

```sh
cd desktop && npm run build
ATOMIC_AGENT_STATE_DIR=/tmp/some-throwaway-state \
  node test/drive-selector.mjs --port 9403 --state /tmp/some-throwaway-state --shots /tmp/shots
```

`--state` is required and never defaults: the desktop's own default state
directory is the operator's live app data.

## Three traps this cost a run each to learn

- **Kill the whole tree.** `npx electron .` is three processes; `SIGTERM` to the
  first leaves the window up holding the debug port, and the next `launch()`
  silently attaches to the OLD window and reports yesterday's screen.
  `drive.mjs` now kills the process group, waits for the port to go quiet, and
  refuses to launch onto a port that already answers.
- **Never press Escape to close a popup.** Escape in this app opens the Manage
  menu — the user asked for that — and the settings window it raises then
  covers the composer, so the next click lands on the overlay and reports
  "covered by DIV".
- **Wait for the screen to stop moving.** The composer paints the route the
  operator clicked before the write lands (`SWX.want`), and a fresh window
  draws its chips from defaults until the first `/api/config` answer arrives.
  Read either one too early and you are reading a screen nobody will ever see.
  `drive-selector.mjs` waits for the transcript's `connected to atomic-agent`
  line, then for two identical reads of the strip with no lock and no
  `switching…`.
- **A backend switch is not instant — wait for the word, not a clock.** Leaving
  the custom route for cloud took ~30 s on this machine: the strip paints the
  route the operator clicked (`SWX.want`) while the provider and model beside
  it are still the old route's, and the send button stays locked the whole
  time. `drive-selector.mjs` waits for the backend control to actually read the
  route it clicked (`onRoute`) and then for three identical reads of the strip,
  because two was not enough — the model slot changes once more when the
  local-models snapshot lands.
