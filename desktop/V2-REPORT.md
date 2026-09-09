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
| **F4** coding mode dead | **fixed** (honest message + Update agent) |
| **F5** duplicate label / stale error | **fixed** (B.4) |
| **F6** no model choice after the key | **not done** — see below |
| **F7** import runs blind | **fixed** (B.5) |
| **F8** one keypress moves and fires | **fixed** at the step it broke on |
| **F9** naming and first-run composition | **fixed** (A.4, B.1, B.2) |
| **F10 / F11 / F12** transcript noise, hidden actions, raw markdown | **fixed** |
| **F13** Manage hides its navigation | **fixed** (B.8) |
| **F14** `/` showed no commands | **not reproduced yet** |
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

**F6 — a model step after the key.** Not built. The wizard still takes the
kind's default model silently. It is the one Part B item I did not reach; the
groundwork is in place (the catalogue is already fetched in `wizNext` to pick
that default) and it is a new wizard phase plus a row list.

**F14.** Not reproduced. The code path looks correct — typing `/` sets
`S.slash` and repaints a popover that is always rendered — so this needs
driving before anything is changed, exactly as the brief says.

**N4, N5.** N4 is a prompt-owner question, not code. N5 needs the catalogue
figures checked against each provider's published context windows.

## How this was verified

- `npm run smoke` — the full suite.
- `test/unverified.drive.mjs` — **new**, 7 checks, F1 end to end against a
  provider whose host does not resolve.
- `test/failure-line.drive.mjs` — **new**, 5 checks, F2 with a real turn sent
  by typing into the composer.
- Twenty-one existing checks asserted the pre-brief design (the starfield and
  its rAF loop, the two-stage intro, the TUI's footers word for word including
  `ctrl+c quit`, the duplicate `API key` heading, the blue accent as three
  colour literals). Each was rewritten to the new contract rather than
  deleted, and where the old check was asserting a literal it now asserts the
  behaviour — that the control reads as red in both themes, say, rather than
  that it is `rgb(240, 112, 95)`.
- One new invariant, which is the one that would have caught the original
  defect: **no footer may advertise a chord the window does not have.**
