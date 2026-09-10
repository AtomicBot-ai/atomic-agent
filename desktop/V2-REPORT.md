# Atomic Agent desktop — v2 pass

What changed, what I drove, and what I could not fix.

---

## Part A — the visual system

Every screen is drawn through one token block. Both palettes (Paper and Ink)
are declared as `--p-*` / `--i-*` and the live tokens alias one set, which is
what lets a surface adopt the opposite palette without a colour literal
outside the block.

- **Zero hex literals** in `styles.css` outside `:root` and its theme blocks,
  and zero in `renderer.js`. (DoD item 6.)
- Radius 0 by default, `2px` only on interactive fills. 80 radius declarations
  were flattened; the only round things left are five genuine status dots and
  a spinner ring.
- **Inter and DM Mono are vendored** (13 faces, 496 KB, latin/latin-ext/
  cyrillic). `index.html` had been loading them from `fonts.googleapis.com`
  through a CSP hole that permitted an external stylesheet; the CSP is closed
  to `'self'` and the app now renders identically with no network.
- The app's 1,400 existing rules were written against the old token names, so
  those names are kept as a bridge and each is pointed at the system
  *semantically*: no washes (selection is a red rule over panel), no shadows
  (a hairline separates, in both themes), no success green.
- Component grammar added and used: button (three ranks), annunciator, legend
  plate, readout, data plate, row list, table, checklist card, guarded action.

**One deliberate reversal to flag:** the intro's starfield is gone. It was
asked for explicitly in an earlier round ("small stars… pulsating… space") and
this brief rules it out by name. I followed the brief. It was also the only
part of the app doing continuous work before the user had done anything.

**A second, smaller one:** the bottom-left Settings entry is now a *default*
button rather than a red-filled one. The earlier ask was for it to look like
"the normal blue button"; in this system a filled red is the primary action of
the screen, and a permanent nav control in the corner of every screen is not
that. The ask's intent — a plain button with no keycaps and no icon — is kept.

## Part B — screen by screen

- **B.1 Splash.** A title card: mark, product name at display size, one 3px
  red rule, the build (`0.5.5 · macOS arm64`), and one 11px line saying how to
  leave. It sizes to the window. One input dismisses it — it used to take two,
  because the first finished a typewriter reveal that no longer exists.
- **B.2 Setup.** A checklist card: `01 SETUP / 02 DATA`, a 24px title, body
  copy at reading size capped at 62 characters, and the three routes as rows
  with one line of consequence each.
- **B.3 Provider list.** A row list, not a wall of fourteen identical boxes:
  name over endpoint in mono, a lit `CONFIGURED` cell on the ones already set
  up, the two we recommend above a hairline and the rest under `MORE
  PROVIDERS`.
- **B.4 API key.** One label. The screen is titled in the 11px style, the
  provider is the subhead, naming the field is the placeholder's job, and the
  error clears on the first keystroke in it.
- **B.5 Import.** The two verbs are buttons on the action bar, ranked primary
  and quiet, instead of underlined rows that read as links to nowhere.
  `scanning the sources…` is a live readout (`SCANNING · 2 of 4 · claude-code`).
  Failures are inspectable: `WHAT FAILED (n)` opens a table of item, source and
  reason, and `RETRY FAILED` re-runs only the sources that failed.
- **B.4 (F6).** A model step follows the key, always: the provider's
  catalogue as a row list with our default preselected and marked `DEFAULT`,
  a search box once there are more than eight, and `Use default` one button
  away. Both wizards render it from one function.
- **B.6 Chat.** App actions left the transcript for a status strip above the
  composer and the console drawer. Markdown renders. The last message keeps
  its Copy and Send-again controls, with their names on them. The empty state
  is a data plate — workspace, provider, model, build.
- **B.7 Composer.** The control row is a legend plate: each control named
  above it in the 11px style, values in machine type.
- **B.8 Manage.** The tab strip wraps rather than scrolling (a strip that
  cannot overflow cannot hide its own navigation). `scrollbar-gutter: stable`
  so the scrollbar never sits on the text. One close control with a label.
  The diagnostics line is a data plate at the foot, carrying build, agent
  binary and state.

## Part C — the defects

| | state |
|---|---|
| **F1** unchecked key sold as ready | **fixed**, 7 driven checks |
| **F2** failure names nothing | **fixed** app-side, 5 driven checks; agent-side trace fields not done |
| **F3** turn declared dead while retrying | **partly** — see below |
| **F4** coding mode dead | **fixed properly** — the agent ships in the DMG |
| **F5** duplicate label / stale error | **fixed** (B.4) |
| **F6** no model choice after the key | **fixed**, driven |
| **F7** import runs blind | **fixed** (B.5) |
| **F8** one keypress moves and fires | **fixed** at the step it broke on |
| **F9** naming and first-run composition | **fixed** (A.4, B.1, B.2) |
| **F10 / F11 / F12** transcript noise, hidden actions, raw markdown | **fixed** |
| **F13** Manage hides its navigation | **fixed** (B.8) |
| **F14** `/` showed no commands | **not a bug** — see below |
| **N1 / N2** trace writer | **not done** — agent-side |
| **N3** no log on disk, dead debug bundle | **fixed** |
| **N4 / N5** | **not done** — see below |

### Bugs found on the way that were not in the brief

Driving F1 turned up three defects in the same few lines, all now fixed:

1. **A custom endpoint could not be saved at all.** The provider id was built
   from the URL keeping every dot, so `https://api.example.com/v1` became
   `custom-api.example.com-v1` and the write came back `expected kebab-case id
   matching ^[a-z][a-z0-9-]{0,31}$`. That is every realistic URL.
2. **Re-entering a key for an existing provider dropped its `baseUrl`.** The
   entry is rebuilt from the preset row, and the two built-in kinds carry no
   URL of their own, so a provider configured against a custom endpoint
   silently started talking to the vendor's default host.
3. **"Try again" lost track of which provider it was editing.** `WIZ.forId`
   was cleared on the way *into* the first attempt, so a retry rebuilt the
   entry from the preset and dropped the endpoint again.

Building the model step turned up two more, both mine and both found by
driving rather than by reading:

4. **The model step's buttons did nothing inside first run.** The onboarding
   `act()` override swallows every verb it does not name while the flow is
   open. A verb added to the wizard and not added there is simply inert —
   which is the same shape as the defect the operator once reported as "when
   I click on next, nothing happens". Both new verbs and the unchecked-key
   offer are named now.
5. **A 37-model catalogue pushed the step's own buttons off the screen.** The
   popover is a flex column with a fixed max-height whose `.selbody` is the
   scroller; the step handed it a bare block instead, so nothing scrolled and
   "Use this model" was drawn 90px below the last visible pixel.

And one regression I introduced and then caught: **the hover flicker came
back**. The checklist header's phase indicator was called `.ob-phase`, which
is what the download progress ROW has been called for longer. My rule sits
later in the file, so it landed on that row — Inter instead of mono,
uppercase, 0.12em of tracking — making it wide enough to wrap. The row is
re-read on every CLI sample and its estimate changes length, so it gained and
lost a line as the download ran, everything below it moved, and a pointer
parked on the offer card kept losing `:hover`. That is exactly what the
tester saw. Renamed, and the progress row is now pinned so it cannot change
its own height whatever the estimate says.

I only knew it was mine because I ran the same driver against the commit
before Part A and it was green there.

And one in the harness: `drive.mjs` judged whether a control was on screen by
the *window's* height, so a row clipped inside a pane with its own scrollbar
looked visible and was clicked at a point the pane was not painting — the
press landed on whatever was behind it. It now scrolls whatever actually
clips the target. This was hiding real defects, not just tripping tests.

## What I could not fix, and why

**F3 — the waiting readout.** The brief asks for `WAITING · AI/ML API ·
ATTEMPT 5 · NEXT TRY 30s` while `provider_waiting` frames arrive. **This
branch's agent emits no such frames** — there is no `provider_waiting` in
`src/` at all — so the window has no way to know a retry is in flight. What
is done instead: the failure line now says how long the turn waited, and the
existing busy strip already shows elapsed seconds and a Stop button while a
turn runs.

Worth knowing before that work is scheduled: driven against a host that does
not resolve, **this agent gives up in one second — it does not retry**. The
95-second park in the tester's trace came from a released agent hitting a host
that *did* resolve and then failed. So F3 needs the agent-side telemetry first
(the same work F2's "agent side" bullet asks for), and the desktop half is
about twenty lines once those frames exist.

**F2 agent side, N1, N2.** Putting `providerId`, host and status on the trace
rows, fixing `status: "pending"` on finished sessions, and stamping a run id
so `seq` cannot collide are all changes to `src/` — the agent. The desktop
spawns the user's *installed* `atag`, so none of them would reach the DMG
without also shipping a new agent. Worth doing; out of scope for a desktop
pass.

**F14 — closed as not-a-bug, with evidence.** Reproduced first, as the brief
asks: typing `/` into the composer with a real key event opens the popover
with 33 commands in it, in both themes, not clipped by the composer and not
off the top of the window (`{popover:true, rows:33, top:614, bottom:806,
clippedByComposer:false}`). Nothing was changed. The screenshots are
`dark-6-slash.png` and `light-6-slash.png`.

**N4.** A prompt-owner question, not code.

**N5 — traced, not fixed.** The desktop does not compute that number: it
takes `contextUsage.contextWindow` from the agent and formats it. The figures
the tester saw are hardcoded in the agent's own catalogues —
`anthropic/claude-opus-5` is `contextWindow: 1_000_000` in
`src/llm/provider/openrouter/openrouter-frontier-chat-models.ts:21`, and
`openai/gpt-5.5` is `1_050_000` in the AI/ML API catalogue (which is where the
1.1M on screen comes from, rounded). So the question is whether those two
literals are right, which is a fact about the models rather than a bug in
either app — but it is one edit in one file when someone confirms them.

**"No green" is enforced as a colour, not yet as a shape everywhere.** The
token is gone — `--success` resolves to ink, so nothing in the app draws a
green tick any more — but the places that used to rely on green to mean
"done" (a downloaded model, a configured source) now read as ordinary text in
some spots rather than as a filled square and the word DONE. The provider
list and the model step carry proper annunciators; the model-download rows do
not yet.

## Synced to v0.5.7, and three TUI gaps closed

The branch was 204 commits behind main. Main never touches `desktop/`, so
the merge came down to 13 shared files and two conflicts — both "each side
added something", both kept. Two things a clean text merge hides:

- `effectiveToolDescriptors` became late-bound in main so a live MCP add is
  visible without a restart; `previewPrompt` was reading it as a value.
- Both branches had written an OpenAI error humaniser and they disagreed
  about 402. Main's explained the mechanism; this branch's insisted a 402
  must not discard the provider's own sentence, because OpenRouter's reads
  "This request requires more credits, or fewer max_tokens. You requested up
  to 8192 tokens, but can only afford 7181" — an instruction with the actual
  numbers in it. A 402 carries both now, and the two tests that each encoded
  one side moved to the merged contract.

**F3 is done, and the sync is what unblocked it.** The agent has parked
turns on a provider outage for a while and told the TUI about it;
`provider_waiting` and `provider_recovered` stopped at the loop and reached
no other host. The SSE forwarder carries both now (extensions opt-in), and
the composer shows `WAITING · <provider> · attempt n · next try 30s` with a
Stop, and the reason in words rather than undici's.

Measured against the TUI's menu registry (48 nodes), what was missing:

| gap | state |
|---|---|
| Run mode incl. **fusion** | **added** — Settings › LLM; the worker count appears only when fusion is the mode running |
| `/report` | **added** as the desktop's own version |
| `go.run` / `go.observe*` / `go.debug` | deliberately absent — Go and Observe were removed on request |
| **Swarm** | **not done** |
| **Integrations** | **not done** |

Swarm and Integrations are TUI-only surfaces: no HTTP route, no CLI
subcommand, ~1,800 and ~1,300 lines reaching the runtime directly. Bringing
them over means designing an agent-side API for them first. That is agent
work, and guessing at the contract is how you ship a pane that looks right
and writes the wrong config.

## The DMG carries its own agent

F4's preferred fix, and the one that makes the artifact publishable: the app
now ships the agent it was built against, in `Resources/agent`, and a
packaged build prefers it over anything installed. Nothing else needs
installing, and the pair can never be version-skewed.

That is what actually fixes the coding-mode chip. It was greyed out with four
dead stances and a caption naming an internal route because the agent the app
found — a released install — has no `/api/coding-mode`. Driven from a copy of
the app **outside this checkout**, on a state directory that has never been
used, the agent connects and reports `supported: true`.

`ATOMIC_AGENT_BIN` still wins over the bundled agent, so a driven test can aim
the app at one build. Nothing repoints `~/.local/bin/atag`.

Two things nearly shipped broken here, and the packaged suite is what caught
them:

- `better-sqlite3` stays external to the SEA, and the copy in the repo's
  `node_modules` is built for Node 22 while the SEA embeds Node 25. Shipping
  that gives `NODE_MODULE_VERSION 141` vs `127` the moment the agent opens
  its profile store.
- **electron-builder silently drops any `node_modules` subtree inside
  `extraResources`.** The agent shipped without its native module, its
  anchored `createRequire` walked up out of the bundle, found the checkout's
  copy, and `atag serve` died — reported as `agent connected — state=error`
  on check 8. The agent is copied by the `afterPack` hook instead, and the
  hook asserts the native module survived, so an incomplete agent fails the
  build rather than the app.

Rebuilding the agent needs Node ≥ 25.7 (`BUNDLING.md`), which is what CI
pins. The pipeline is `npm run build && npm run bundle:sea && npm run
bundle:fetch-assets && npm run bundle:build-binary && npm run bundle:package`
at the repo root, and then `better_sqlite3.node` must be the one built
against that same Node.

## What is still not signed

The build is **ad-hoc signed and not notarised**. macOS refuses the first
launch and says it cannot check the app for malicious software; the
recipient has to right-click → Open once (the DMG carries a `READ ME
FIRST.txt` that says so). This also means the microphone grant does not
survive a rebuild, because macOS keys that permission to the code signature
and an ad-hoc signature changes every time.

A paid Apple Developer ID is the only thing that fixes either. Everything
else in this report is done; this one is a purchase, not a patch.

## One operational trap worth knowing about

The shared smoke fixture's `config.json` carried `version: 51`. Every agent
on this machine — this checkout's `dist/cli/index.js` and the installed
`~/atag-agent/bin/atag` alike — is `USER_CONFIG_VERSION = 49`, and the write
path refuses anything higher outright:

    config set failed: version 51 is newer than this build understands (49)

Reads still work, which is why it stayed invisible: the app boots, the
transcript fills, and only the checks that WRITE config fail — the MCP tab,
the LLM tab's External save, the Hugging Face add. Thirty-three of them, none
about the app.

Something newer than either agent here touched that directory at some point.
The repair is to pin `version` back to 49 in the file and let the agent
migrate forward from there; a backup of the v51 file is beside it. Worth
knowing because it will happen again the moment a newer agent opens a shared
fixture, and the failure it produces points at the UI rather than at the
config.

I also spent a run on the wrong theory here — that the drivers' agent shim
had upgraded the file — before checking that the shim's own agent is 49 too.

## How this was verified

- `npm run smoke` — the full suite.
- `test/unverified.drive.mjs` — **new**, 7 checks, F1 end to end against a
  provider whose host does not resolve.
- `test/failure-line.drive.mjs` — **new**, 5 checks, F2 with a real turn sent
  by typing into the composer.
- `test/model-step.drive.mjs` — **new**, F6 against a real provider catalogue:
  the step appears, our default is preselected and marked, and the model
  actually clicked is the model written to `config.json`.
- `test/visual.drive.mjs` — **new**, the screenshot set at 1470×923 in both
  themes, walked with trusted events, and F14's reproduction.
- Twenty-one existing checks asserted the pre-brief design (the starfield and
  its rAF loop, the two-stage intro, the TUI's footers word for word including
  `ctrl+c quit`, the duplicate `API key` heading, the blue accent as three
  colour literals). Each was rewritten to the new contract rather than
  deleted, and where the old check was asserting a literal it now asserts the
  behaviour — that the control reads as red in both themes, say, rather than
  that it is `rgb(240, 112, 95)`.
- One new invariant, which is the one that would have caught the original
  defect: **no footer may advertise a chord the window does not have.**
- The fonts are asserted to actually LOAD, not merely to be asked for: on a
  `file://` page a CSP of `font-src 'self'` can be an opaque origin, which
  would drop the faces silently and fall back to Helvetica. `document.fonts`
  says both are loaded.
- `npm run smoke` — **498 checks, 0 failures**, on the repaired fixture.
- The **packaged app**, installed from the DMG the way a recipient does and
  run on its own bundled agent — **501 passed, 0 failed, 2 skipped**. Both
  skips are honest: a source-file scan (a packaged app ships only compiled
  output) and the live-pasteboard round trip (macOS refuses a clipboard
  write to an unfocused app, and asserting against the operator's own
  clipboard would be asserting something this suite does not own).

### The ABI trap, twice

The first DMG of this round mounted, installed, launched — and its agent
died the moment anything opened a database: `NODE_MODULE_VERSION 141`.
`better-sqlite3` is native, the SEA embeds its own Node 25 (ABI 141), and
the copy in the repo's `node_modules` is built for whichever Node ran `npm
install` (22, ABI 127). Nothing about that is visible at startup, which is
what makes it dangerous: it looks like a finished artifact.

The bundled module is built against the SEA's Node now, in a throwaway
directory — rebuilding it in place would fix the DMG and break `npx vitest`,
which runs on 22. And the afterPack hook no longer asks whether the file is
present; it runs the bundled agent against a temp state dir so sqlite
actually opens, and fails the build otherwise. I confirmed the gate
discriminates by restoring the wrong module and watching the build refuse
it.

Rebuilding the agent at all needed Node ≥ 25.7 (this shell has 22), so the
first build would otherwise have shipped an agent predating both the merge
and the F3 forwarding.
- `drive:onboarding` 60/60 (one honest skip: that run has no
  `OPENROUTER_API_KEY` for the empty-box case). `drive:wizard` 16/16.
  `drive:hover` 22/22. `drive:models` 29/29.
- F8 is asserted on four screens: an arrow moves the selection and commits
  nothing on `choose`, `local_pick` and `import_pick`, and on `import_done`
  — the one that broke — an arrow does not finish the flow.
- Five drivers were themselves out of date with the app and were updated
  rather than worked around — most importantly `passIntro`, shared by three
  of them, which dismissed the splash by clicking the star field's canvas.
  With the canvas gone its loop broke immediately, clicked nothing, and every
  caller sat on the intro until it timed out.
- **`drive:selector` fails 3 checks, and it failed 9 on the commit before
  Part A.** Those are pre-existing, on that state directory; my build gets
  further. I have not chased them.
