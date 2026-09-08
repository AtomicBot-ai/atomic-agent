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
