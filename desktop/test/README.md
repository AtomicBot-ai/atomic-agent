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

`launch` also decides WHICH agent the window talks to. `resolveBinary`
prefers `~/atag-agent/bin/atag` and then the released install, so a driven
run would otherwise exercise whatever agent happens to be on the machine —
useless for proving a change to `src/`, where most of a cloud turn lives.
When `dist/cli/index.js` exists at the repo root (`npm run build` there),
the harness writes a shim into the run's state directory and names it in
`ATOMIC_AGENT_BIN`, so the app runs the agent from THIS checkout. Nothing
on the machine is repointed; a terminal `atag` still runs what was
installed. An explicit `ATOMIC_AGENT_BIN` wins, and with no local build the
run falls back to the installed agent as before.

## The scenarios

| file | what it drives | command |
| --- | --- | --- |
| `scenarios/01`…`07` + `run-all.mjs` | seven end-to-end human errands: build a website, write a document, arrange files, hold a conversation, answer an approval, survive a Force Quit, and be told what went wrong when the agent will not answer | `npm run scenarios` |
| `onboarding-mouse.mjs` | the whole first-run wizard with the mouse, plus a resting-state design review of every screen | `npm run drive:onboarding` |
| `drive-selector.mjs` | the composer's parameter controls across the three backends (`composerSwitchKindsFor`), and the pane Settings › LLM opens on | `npm run drive:selector` |
| `cloud-setup.drive.mjs` | the cloud providers end to end against the real OpenRouter and AI/ML API | `npm run drive:cloud` |
| `integration.drive.mjs` | **the four lanes in one window**: first run with the mouse, a cloud provider with a real key, a message and a reply, local, back to cloud, a second provider added from the composer chip, a model switch, and a reply from the model chosen last | `npm run drive:integration` |

`integration.drive.mjs` is the pass that has to hold once the lanes are
merged, and it is deliberately the ordinary arc rather than a corner: it
crosses every seam in one session, in the order a first afternoon crosses
them. It calls nothing — no `window.__*`, no config write, no seeded state
beyond the `.env` a person would already have — so a step that cannot be
reached with the pointer is reported as the finding it is.

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
- **A backend switch is not instant — wait for the word, not a clock.** Leaving
  the custom route for cloud took ~30 s on this machine: the strip paints the
  route the operator clicked (`SWX.want`) while the provider and model beside
  it are still the old route's, and the send button stays locked the whole
  time. `drive-selector.mjs` waits for the backend control to actually read the
  route it clicked (`onRoute`) and then for three identical reads of the strip,
  because two was not enough — the model slot changes once more when the
  local-models snapshot lands.

- **The scroll-into-view wheel is an input.** `clickSel`/`clickText` send a
  real `mouseWheel` to bring a target into view before pressing it, and the
  first-run splash answers a wheel notch exactly as it answers a key or a
  press — "press any key" is kept on four channels. So `clickSel('#ob-sky')`
  was two inputs on a two-stage screen, and one call walked the wizard from
  the splash past the backend choice and into the provider list, where the
  caller then waited twenty seconds for a screen it had already gone by.
  Pass `scroll: false` for anything on a screen that counts inputs.
- **A pane that is still fetching is not an empty pane.** The model pane
  draws `reading the catalogue…` over an empty list while `selLoadModels`
  is in flight. Read it the instant the popover appears and you will report
  "0 rows" about a pane that fills correctly a second later —
  `integration.drive.mjs` waits for that line to go, and prints the pane's
  own `.cap` text when the list really is empty.
- **A model your key cannot pay for is not a broken app.** Picking the first
  row that is not the active one landed on `anthropic/claude-opus-5-fast`,
  and OpenRouter answered `402 … you can only afford 18` tokens. That is a
  true statement about the account and a useless one about the window, so
  the integration pass prefers a small model by name and then holds the
  contract that matters: the turn answers, or it names the provider and the
  reason. Never a bare transport error.

## The red that was not ours

Steps 14–16 are the switch-after-setup half: a different cloud model is
picked from Settings and has to answer for real, and then a model the key
cannot pay for is picked on purpose, to pin down what the operator is told
when a provider refuses.

That last step is the one that earned its keep. Step 15 used to be a known
red — `turn failed [transport]: fetch failed`, with the note that the fault
was somewhere in the agent. It was: `resolveFallbackChain` appends the
configured llama-server to the tail of every chain, whether or not a local
model was ever downloaded, and `runWithFallback` rethrew the LAST failure.
So OpenRouter's `402 … requires more credits, or fewer max_tokens` — an
instruction the operator could have acted on in a minute — was replaced by
a socket error from a daemon they never started. Both halves are fixed in
`src/llm/`, and step 16 is what keeps them fixed: it accepts an answer or a
refusal, but never a bare transport error that names neither provider nor
reason.
