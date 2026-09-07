# Driven tests

`npm run smoke` drives the renderer through `window.__*` hooks, which call
the app's own internal functions. That is fast and it covers a great deal,
but a hook that skips the event handler proves nothing about what a person
experiences: a wizard row whose click listener never fires still passes
every hook-driven check, because the hook called the function the click was
supposed to reach. That is how ~490 green assertions coexisted with a
first-run screen whose `Next` button was wired to nothing.

The files here are the other half. They drive the real app over the Chrome
DevTools Protocol with **real input events** — `Input.dispatchMouseEvent`
and `Input.dispatchKeyEvent`, the same trusted-event path a hand takes.
`Runtime.evaluate` is used only to OBSERVE: read text, classes, geometry.
If a step can only be performed by calling an internal function, that is a
bug in the app, not a licence to call the function.

## `drive.mjs`

The harness. `launch({stateDir, port})` starts the built app on a state
directory of your choosing and attaches; the returned object carries:

| helper | what it does |
| --- | --- |
| `clickSel(sel)` / `clickText(text, opts)` / `clickAt(x, y)` | a real mouse press and release at the element's centre |
| `type(sel, text)` | clicks the field, then real `char` events |
| `clear(sel)` | empties a field with real Backspaces, and fails if it will not empty |
| `press(key)` | Enter, Escape, Tab, arrows, Backspace |
| `waitFor(expr)` | poll a page expression until it is truthy |
| `snapshot()` / `screenshot(path)` | what is on screen |
| `check` / `step` / `report` | the tiny assertion vocabulary the scenarios print |

Two rules the harness enforces for you, both learned the hard way:

* it refuses a debugging port that already has a CDP endpoint on it — a
  leftover app from an earlier run keeps the port, and attaching to the
  corpse looks exactly like a hung app;
* **one client at a time.** Chromium gives a page target to a single
  debugger session, so attaching a second socket to peek at a run in
  flight silently detaches the first and the scenario hangs where it
  stood. Watch a run through its log, never by attaching.

## `cloud-setup.drive.mjs`

The cloud providers, end to end, against the real OpenRouter and AI/ML API.
It reproduces the operator's own path — choose **Local models** first, then
add a cloud provider from inside the setup — types a wrong key and requires
the wizard to refuse it, types the right one, sends real messages on both
providers, and switches provider and model afterwards, requiring a real
reply from each newly selected model.

```sh
ATAG_DRIVE_STATE_SEED=/dir/with/a/.env \
ATAG_DRIVE_PORT=9402 \
npm run drive:cloud
```

`ATAG_DRIVE_STATE_SEED` names a directory containing a `.env` with
`OPENROUTER_API_KEY` and `AIMLAPI_API_KEY`. It is only ever read: the run
gets its own fresh state directory under the OS temp dir with a copy of
that `.env` in it, so a first run is genuinely a first run and no existing
installation is touched. Set `ATAG_DRIVE_KEEP=1` to leave that directory
behind for inspection. Keys are typed into the wizard and never logged —
no check prints a field's value, only its length.

This costs a handful of tokens on both services every run, so it is a
deliberate command rather than part of `npm run smoke`.

### One known red

Step 15 — the first turn after switching to a different cloud model —
fails in most runs with `turn failed [transport]: fetch failed`, which the
app reports honestly on screen and the session trace confirms (two `error`
frames, `turn_finished reason:failed`, no `llm_completion`). The same key
and model answer a plain curl, and the two turns before it succeed on the
same agent, so the fault is in the agent's own request on the first turn
after the switch (`src/agent/step-executor.ts`), outside this desktop
tree. The check stays red on purpose: it names a turn the operator cannot
run.
