# Atomic Agent Desktop

An Electron client for atomic-agent. It supervises one `atag serve` process on
loopback and drives it from a native macOS window: menu bar, sidebar of
destinations, streaming transcript with tool cards, inline approval prompts, a
command palette, and a settings window.

```bash
cd desktop
npm install
npm start
```

`npm start` builds and launches. `npm run dev` adds detached DevTools.
`npm run smoke` runs the whole thing headlessly and asserts it works (below).

## How it talks to the agent

One child process, one transport. The main process spawns

```
atag serve --host 127.0.0.1 --port <ephemeral> --api-key <random per launch>
```

with `cwd` set to the chosen workspace, waits for `/health`, and speaks HTTP to
it. The port is ephemeral, the bind is loopback-only, and the bearer token is
generated per launch, so nothing outside this app can reach the agent.

| Surface | Route |
|---|---|
| Liveness, llama-server reachability | `GET /health` |
| Paths, tool inventory, agent config | `GET /api/capabilities` |
| The user config file, verbatim | `GET /api/config` |
| Installed skills | `GET /api/skills` |
| Durable tasks | `GET /api/tasks` |
| Persisted sessions | `GET /api/sessions` |
| Deleting one session | `DELETE /api/sessions/{id}` |
| One turn of the agent loop | `POST /v1/chat/completions` (SSE) |
| Approval requests | `GET /api/events` (SSE) |
| Approval verdicts | `POST /api/approval/resolve` |
| Steering the turn already running | `POST /api/sessions/{id}/steer` |
| What a turn accepted but never read | `GET` / `DELETE /api/sessions/{id}/steer` |

The turn stream is sent with `X-Atomic-Extensions: 1`, which upgrades it from
plain OpenAI chunks to atomic's named frames — `session_id`,
`reasoning_progress`, `tool_progress`, `steer_undelivered`, and the error
frame — so the transcript can draw real tool cards and a reasoning disclosure
instead of a wall of text. Every one of those exists *only* because of that
header; a second streaming caller that forgot it would get silence with no
error to debug. One extension frame arrives **unnamed** and has to be matched
on its body instead: `{"object":"atomic.steer_applied", …}`.

**Mid-turn steering.** A message typed while a turn is running is offered to
that turn over `POST /api/sessions/{id}/steer`, and the route's answer is the
only fact consulted — not the window's own busy flag, which an approval and an
abort both clear while the agent is still working. Accepted, it is announced
in the TUI's words (`steering the running turn — the agent reads it at the
next step`) and appears in the transcript. Refused, it is parked *ahead of*
ordinary backlog (the TUI's `steeredAhead` watermark) and says so; with 20
already parked it is handed back to the editor rather than eaten. A message
the turn accepted and then never read comes back on `steer_undelivered`, is
pushed to the front of the queue and acked with the DELETE, because `steer`
already answered "yes" to it and dropping it would lose something the user
watched being accepted. That frame only reaches a window that was attached
to the turn, so opening a session also runs the **GET** leg once — a
reconnect, an agent restart or a session opened after the fact would
otherwise leave those messages parked on the server forever. It is skipped
for a turn this window is streaming, where the frame will carry them, so the
two paths cannot both queue the same message.

**The context gauge is the agent's own.** `GET /api/sessions/{id}` carries
`contextUsage` — the last turn's whole window occupancy: every section, both
conversation caps, the per-pair costs and the physical window — so the panel
reads it instead of scanning the trace, and can say which limit is trimming
the transcript (`conversationBoundBy`) instead of guessing. The pre-message
preview (`POST /api/context-preview`), the trace scan and the projection stay
behind it, for a session that has never finished a turn and for agents that
persist no such field. That order matters now that the desktop prefers a
locally built agent: the preview builds the next prompt *before recall*, so
it reads low against what the last turn really occupied — 7.4k where the
session's own record said 10.0k — and the smaller number is the projection,
not the occupancy. The snapshot is committed only past the refresh's
staleness guard, so a slow refresh for the session the user just left cannot
draw its trimming verdict over the numbers of the session they are on. A
prompt-derived window is released when the active `<providerId> <chatModel>`
changes, so the gauge never draws a new model against the old model's scale.

**The session's model stamp.** The same row carries `metadata.llm` — the
provider and model that session last ran on. It is reported and never applied:
`atag serve` pins its provider at boot, so switching costs a config write plus
a child restart, and a restart aborts every turn this process is streaming,
including ones in chats the user is not looking at. The offer is refused
outright while anything is running. When the stamped provider is gone the
window says so in the TUI's words and keeps the current model. The comparison
is the agent's own: the FULL model id against the provider entry's
`defaultChatModel ?? model`, the pair 0.5.5's `planModelRestore` tests — not
the chip's display label and not the basename, which would read
`openai/gpt-4.1` and `azure/gpt-4.1` as the same model.

**Why not the NDJSON sidecar.** `dist/sidecar/main.js` exists only in a source
checkout, and the shipped single-file binary has no `sidecar` subcommand. A
desktop app has to work against what people installed. The sidecar also has no
config, tasks, sessions or models commands, so it could not fill the window on
its own — and running a sidecar *and* a server over one state directory would
start two task schedulers against the same cron jobs.

## Process model

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.
- The renderer gets exactly one global, `window.atomic`, built in
  `preload/preload.ts`. No `ipcRenderer`, no `require`.
- CSP: `default-src 'none'`, `script-src 'self'`, `connect-src 'none'` — the
  renderer cannot reach the network at all; every byte arrives over IPC.
  `style-src` allows inline styles because the renderer composes HTML strings;
  all interpolated values go through `esc()`.
- `will-navigate` is cancelled and window-open requests are handed to the
  system browser.
- `before-quit` stops the child and waits for it, escalating to `SIGKILL`,
  so quitting never leaves an orphan holding the port.

## What is real and what is not

Real, driven by the running agent:

- connection state and working directory
- the transcript: your message in a bubble on the right — text-width, capped
  at 480px, with the outgoing-tail corner, the way a chat app draws your own
  side — then the streamed reply, reasoning, and tool cards on the left with no
  glyph beside them. Neither side carries a per-message marker any more; the
  agent's mark appears once, at the end of a turn that has finished, on the
  reply that closes it. A turn is the span from one of your messages to the
  next, and the mark is withheld while the window is streaming, while a turn
  waits on an approval, and for a turn that ends in an abort or a failure.
  Not every system row counts as that ending: the session model stamp, the
  parked-steer recovery and the `steer_undelivered` notice are notes about the
  session appended after a turn that really did finish, they carry `note:true`,
  and the mark steps over them — otherwise reopening a session with a model
  stamp deleted the full stop of the last turn in it, which is the one turn you
  are looking at. A
  turn running under some other origin has no stream here and therefore no
  mark — 0.5.5 exposes no turn controller, the same limit the pulsating sidebar
  dot carries. The visible cost of dropping the per-message glyph is that the
  gap between a turn starting and its first delta is now an empty row: what
  says the agent has begun is the composer's status strip (`Thinking`, the
  elapsed timer and the Stop button), not a mark in the transcript.
  Tool cards, reasoning blocks and approvals keep their own
  check/warn/running glyphs: those describe a call's result, not a message.
  A tool card's args come off the stream (`tool_progress.label`); its result and
  status are filled in from `GET /api/sessions/{id}` once the turn has been
  saved — the stream never carries results, the session store does. The
  duration is the agent's own: the trace row a tool writes when it finishes
  (`tool_invocation.ts`) minus the model completion of that step
  (`llm_completion.ts`), which is the same interval the TUI's live card
  shows. While a call is running the card shows the wall time this window
  observes and the tooltip says so; a session without a trace shows no number
  rather than a zero (the TUI prints 0ms for a reopened session — the store
  stamps one `at` on a call and its result). Durations print as `<n>ms`,
  as the TUI does — also in the inspector's Steps tab, which used to print
  `1.9s` and now prints `1922ms`, and shows the same empty cell (with the
  same tooltip) as the card for a finished call with no trace row, never
  `…`. Long args, summaries and results wrap inside the card;
  nothing widens the transcript. Three or more consecutive calls to the same
  tool fold into one line.
- file paths and URLs in replies: files are chips that open in the default
  app, with a right-click menu (Open · Show in Finder · Copy Path · Save As…);
  URLs open in the browser. A mentioned path only becomes a chip when it
  carries a 1–6 character extension, so a bare `/path/to/Makefile` or a
  directory stays plain text
- files a turn actually wrote — `os.fs.write`, `os.fs.edit`, `os.fs.patch`
  with `apply: true`, `os.fs.archive.extract` — are attached under the reply
  as a `Saved to <path>` line per file plus a chip. The paths come from the
  session store: the call's own args and the tool's own result line (`wrote N
  bytes to …`, the patch report's `✓ <file>` lines, `extracted … to <dir>`),
  each confirmed with `fs.stat` before it is drawn, so a chip is never shown
  for a file that is not there. The strip is cached per turn by the set of
  paths it collected, and a later `os.fs.trash` naming one of them expires that
  cache — a file deleted after the chips were drawn stops being called saved
  instead of keeping a line for something the filesystem no longer holds. A
  card whose status reconciliation never learned (the store did not describe it
  within ~6 s, so the window marked it finished-but-unknown) is never a source
  for the strip: `fs.stat` only proves the file is there now, not that this
  turn wrote it. Nothing else feeds the strip: a path the reply
  merely mentions is an inline chip, not a saved file, and shell redirects are
  not inferred — `os.shell.run` and `skill.run_script` name nothing they wrote,
  so guessing from a command string is out. (`os.fs.trash` deletes and never
  attaches; `memory.*` writes the agent's own store, and `os.git.*` on this
  agent is blame/branch/diff/log/show/status only — those four are the whole
  list of file-producing tools.)
- approval prompts, resolved over `/api/approval/resolve`
- installed skills, durable tasks, and sessions — named by their first
  message and opened in full from the sidebar
- **The sidebar is two lists: Tasks, then Chats.** No nav rows, no group
  headers, no "N turns" second line. Tasks is every task the agent holds,
  ordered as the TUI's rail orders it (running, queued, blocked, failed,
  cancelled, completed, then newest first) with `N running` counted over the
  whole list; Chats is the sessions in this workspace with at least one saved
  turn, pinned first and newest first. Both lists ask the agent for its whole
  ceiling — `?limit=200` on sessions, `?limit=500` on tasks — so **Load more**
  pages over the real list rather than over a page the server already cut
  (without a limit `GET /api/sessions` serves 25). A workspace with more than
  200 sessions is cut by the route, not by this window. Each list shows 15
  rows and then a **Load more** button; the lists keep their scroll position
  across renders, so paging does not scroll the new rows away. Each row is one
  line with a dot on the left: *pulsating* = a turn is running there (driven
  by the turn stream's own frames, so an approval or an abort cannot make a
  live turn look finished); *filled* = it wants you — an approval is waiting,
  its last turn failed or stalled, or it has changed since you last opened it;
  *empty* = executed and read. Opening a row marks it read. A waiting approval
  keeps filling its row across a chat switch or a new session — the card
  leaves this view, but the agent is still blocked on the gate; only a verdict
  or the turn's own end clears it. A queued task that has not run yet is drawn
  empty and its tooltip says so — it has not executed, so there is nothing to
  have read. An empty Chats list says `(no sessions yet)`, the TUI's own
  string; an empty Tasks list says `(no tasks yet)` rather than the TUI's
  `(no active tasks)`, because this list is every task the agent holds and not
  the rail's running/pending/recurring projection — "no active tasks" would be
  a claim about a different list. Chats can be pinned and unpinned from the row's hover button or
  its right-click menu (Pin/Unpin · Delete…), and **Delete really deletes**:
  `DELETE /api/sessions/{id}`, not a splice that the next load undoes.
  Each list header carries a **+** on its own line: the one on Chats starts a
  new chat, the one on Tasks opens Settings › Tasks with the create form up,
  and on the Tasks header `N running` sits to the left of it. The head row —
  the lockup and the workspace chip — carries no plus at all; the user asked
  for it there and nowhere else. The dot on a row is a 6px ring seated on the
  label's optical centre rather than on its line box.
  Pinning and the read stamps live in Electron's `userData/prefs.json` — per
  machine, per viewer — because the agent has no route and no store field for
  either, and its `config.json` is the operator's file. On a machine that has
  never run this window every historical chat is therefore unread until it is
  opened; that is honest, not a bug. Skills left the sidebar (the user asked
  for it); ⌘3, the palette and View › Skills still open it, on Settings ›
  Skills. Collapsed — Setup › Hide or show the sidebar, or a window narrower
  than 1000px — the two lists stay as a column of dots, each row's tooltip
  naming it, so the rail is still a way back into a chat; the two list headers
  stay too, stripped to their **+**, because 52px does not hold a label or the
  counter and the rail would otherwise have no way to start anything. The
  toolbar's sidebar button glows in the accent (`.iconbtn.on`, the same
  treatment the Inspector and Console buttons use) while the sidebar is
  expanded, and *expanded* is the conjunction of both facts — the flag and the
  breakpoint — so the glow cannot lie on a narrow window. Below 1000px the
  media query pins 52px whatever the flag says, so the button is **disabled**
  there rather than left as a live control that does nothing, its tooltip
  reading `The sidebar is a rail on a narrow window`; ⌘ 0, which does not go
  through the button, answers with the same sentence. The tooltips in that
  corner are `Hide sidebar (⌘ 0)` and `Console (⇧ ⌘ Y)` — the spellings the
  shortcuts sheet ships, because a toolbar where one chord reads *⌘ 0* and its
  neighbour *Ctrl+Shift+Y* is worse than either spelling alone.
- **What the sidebar cannot know on 0.5.4.** `GET /api/sessions` never
  reports `running`: the store is written only when a turn ends, and no route
  exposes the turn controller. So the pulsating dot means "a turn started in
  *this window* is streaming", and a turn running for some other origin (a
  scheduled task, Telegram, another HTTP client) shows only when it raises an
  approval — which fills the row. Nothing is invented to cover the gap.
- **The transcript holds its pixel scroll position across renders**, which is
  a deliberate divergence from the TUI's bottom-anchored offset: the user
  asked for the scroll not to move when a card is folded or a re-render lands,
  so the desktop restores `scrollTop` instead of re-anchoring to the bottom.
  The sidebar's two lists are restored the same way and for the same reason.
- the model selector: backend, provider and model chips, each opening one
  pane, with the TUI's rows (cloud → local, `N providers ready` /
  `llama.cpp managed here`, provider rows `model` / `default model` /
  `no API key`, then the TUI's trailing rows — `Add a new provider · opens
  the wizard` and, on the local model pane, `Download more models… · opens
  the local models pane`). The model chip reads `download model` whenever
  the local route has nothing on disk, before it names the managed model,
  as the TUI's does. Switching backend, provider or model is the TUI's own
  decision logic (`activateCloud` / `activateLocal` / `selectChatModel` /
  `triggerLocalChatModel`) ported into `desktop/main/backend-switch.ts`:
  the same whole-file config writes as `src/tui/persist-llm-provider.ts`
  and `persist-user-local-models-config.ts`, the same daemon side effects
  (`atag models start|stop`, hybrid recall off after a stop), the same
  `runtime_info` lines in the transcript — followed by an `atag serve`
  restart, because the running agent pins its provider at boot and 0.5.4
  has no reload route. A switch is refused while a turn is running (the
  restart would abort it). Picking a cloud model applies and closes before
  the write confirms; picking a local model keeps the popup open until the
  daemon has answered.
- the TUI's pre-turn gate for the managed local route: with no local model
  selected, or one that is not on disk, the turn is refused with the TUI's
  text and the message goes back into the editor (`… (message returned to
  the editor)`); a message drained from the queue is dropped with a preview
  instead, as the TUI does; with a fallback chain the turn runs under the
  TUI's notice; a pull in flight shows its percent and bytes from the CLI's
  own progress line. When the disk snapshot itself cannot be read (`atag
  models list` failed) the turn is sent and the transcript says so — the
  TUI stats the disk directly and never has that case.
- first-run setup (cloud provider or local model, the TUI's two writes and
  copy). One desktop addition: choosing **Local models** on an install that
  already has a cloud `llm` block moves `llm.activeTextProvider` to
  `local-llama` (the pick goes through `selectLocalModel`, which is where the
  route moves and the daemon starts). The TUI's onboarding never calls
  `setActiveText` — its route lands on `local-llama` only because a fresh
  install has no `llm` block — so on the TUI the same choice on such an
  install leaves the cloud route active until the composer chip is used.
- the add-provider wizard: the TUI's kind list (nothing preselected) → key /
  base URL → verification by listing the provider's models under that key →
  saved, activated, and a default model picked
- the context gauge, measured from the agent's trace after each turn, with
  the TUI's one control: tasks per turn (`agent.conversationMaxPairs`, 1–100)
- the context BEFORE the first message. The TUI shows nothing until the loop
  emits `prompt_built` (its panel says "context · not measured yet"); the
  desktop instead draws a labelled projection from data the installed agent
  already produces: the turn-0 `prompt_captured.tokens.stablePrefix` of the
  newest trace built in this workspace, the draft counted with a port of the
  runtime's own `estimateTokens`, the window from the provider catalogue
  (`atag models search --json`) or llama-server `/props`, and
  `localModels.completionMaxTokens` as the reply reservation. The chip keeps
  a `~`, a hatched gauge and the word "projected", and the panel names the
  baseline session and its age, until the first turn's trace (or the branch
  route below) replaces it. No trace on the machine → the TUI's own
  "not measured yet" copy, chip hidden; no catalogue answer → "window
  unknown" — never 128k, never the 6000-token sanity constant.
- coding modes default / plan / auto / bypass, applied live through
  `/api/coding-mode` exactly as the TUI's `onCodingModeChanged` does — the
  runtime's ladder and plan flag move, `config.json` is untouched. The Privacy
  pane shows the persisted baseline read-only; the chip is the one approval
  surface, as in the TUI since PR #303. The route holds the chosen stance in
  the closure its GET and POST share, because `resolveCodingMode` is not
  injective and the live switches cannot be read back as the mode that set
  them. Inference survives as the boot seed only, so an agent started with
  `--no-approval` opens honestly — with the consequence that **at
  `agent.approvalLevel: 5` the seed reports `bypass`, so the chip opens red
  until a mode is chosen.** At that base `default`, `auto` and `bypass` are
  also behaviourally identical (the ladder is already at maximum and only
  `plan` changes anything), which the popover says in as many words; lower
  `agent.approvalLevel` to make the modes differ.
- **the plan hand-off bar**, a port of `src/tui/components/plan-handoff.tsx`.
  A plan-mode turn that finishes with a reply ends in three controls under that
  reply — `▶ run it · auto`, `▶ run it · bypass permissions`, and a quiet
  `✕ dismiss plan` — plus the TUI's own sentence saying the third option is
  still to type. Enforcement itself is the agent's and needed nothing here:
  `runPlanModeGate` refuses every mutating tool before dispatch, which is why a
  plan turn ends in a proposal rather than a run of commands. The two run
  buttons **await** the mode change and send only once the agent has confirmed
  it — stricter than the TUI, which dispatches both in one tick — and the
  message then goes through the ordinary submit path, so the bubble, the
  history, the busy gate and steering all behave. Dismiss deliberately stays in
  plan mode: rejecting a plan rejects that plan, not the act of planning, and
  dropping out of plan mode there would hand the agent its tools back at the
  moment you said no. The offer is retired by the next turn, by any mode change
  away from `plan`, by dismiss — and, unlike the TUI (whose `session_switched`
  reducer forgets to, so its bar re-attaches to another thread's transcript),
  by a session switch — including a switch made *while* a run button's mode
  POST is still in flight, which cancels the send and says which stance the
  ladder ended on. At `agent.approvalLevel: 5` the two run buttons resolve to
  the same stance, and the bar says so where the choice is made.
- **typed prose under an open approval is the verdict**, as in the TUI
  (`src/tui/submit-handler.ts`): the call is denied with your words as the
  model-visible reason, and the same text then goes into the running turn — in
  that order, awaited, because a steer that arrived first would be pushed at a
  turn still parked on the gate. The card's footer says so on screen.

Honestly degraded, and labelled as such in the UI:

- **Coding modes need an agent that has `/api/coding-mode`.** That route is
  added in this branch (`src/http/route-coding-mode.ts`); a binary without it
  answers 404 and the chip prints `mode —` rather than naming a stance the
  agent does not have. The same blank stands before the first GET has come
  back, and after one that failed: `default` is the seed this window starts
  on, not an answer, and at `agent.approvalLevel: 5` the live stance is
  really `bypass` — so the chip names a mode only once the route has
  confirmed one. The desktop prefers `~/atag-agent/bin/atag` for
  exactly this reason (see *Packaging* below). The plan hand-off rides on the
  same route, so a binary without it draws no bar at all: with no plan mode
  there is nothing to hand off from.
- **No session-wide approval grants, and no target-path retargeting.** The TUI
  offers both (`[s]` allow-category, `[a]` allow-shape, `edit target path…`)
  because it reaches the gate in process. On the wire, `ResolveBody` in
  `src/http/route-approval.ts` is `{approvalId, decision, reason}` and
  `parseDecision` maps the decision to a bare boolean — nothing can carry a
  grant scope or a `pathOverride`. So the card draws Approve / Deny / Abort and
  says why, rather than a button it cannot honour; the `s` and `a` keys that
  used to fire a grant-shaped verdict were removed for the same reason. Loosen
  the standing stance with the mode control in the composer instead.
- **Where the approval surface still diverges from the TUI's, field by field.**
  Three differences remain after the parity work above, none of them accidental:
  (a) the desktop's `kind` row adds `— auto-approves from level N`, which the
  TUI's modal has no counterpart for. It is kept because the desktop has no
  always-visible ladder next to the card, and the number is the agent's own.
  (b) the TUI closes its modal with a muted `esc abort run · ctrl+c stop
  everything` line; the desktop draws an **Abort run** button with an `⎋` keycap
  instead, and has no ctrl+c equivalent — there is no run to interrupt from a
  window that is not a terminal. (c) deny is `n` here and `ctrl+d` in the TUI.
  Both are guarded (the desktop's letter keys are dead inside any text field),
  and `n` is what the card's own keycap prints, so the key and the label agree.
- **A verdict the agent does not take is reported, not assumed.** `POST
  /api/approval/resolve` answers 404 with an `{error:…}` body for an
  `approvalId` the gate is no longer holding, and the IPC layer hands that back
  as a perfectly successful call. So the reply is read: only the route's own
  `{resolved:true, …}` counts as delivery, and anything else prints *could not
  deny that call with your message: …* and marks the card **Not denied — the
  agent never took the verdict**. The typed text is still sent into the turn
  either way.
- **The plan chords are dead inside the composer.** `ctrl+y` / `ctrl+b` /
  `ctrl+d` fire the bar's three verbs everywhere else, as in the TUI, but not in
  a text field: macOS binds all three inside a Chromium textarea (back a
  character, yank, delete forward), and a run in bypass-permissions mode is not
  something an ordinary editing keystroke may start. This is a deliberate
  divergence from the TUI, where Ink has no such bindings.
- **The plan hand-off is live-turn only.** It is raised off the turn's own
  terminal frame, so a plan-mode turn that finished in another chat, or under a
  scheduled task, leaves nothing to hang it on: the store records no "this turn
  ran in plan mode" fact (plan mode is process state, deliberately not
  persisted), and inferring one from the reply text would be fabrication. It
  therefore disappears on reload; the mode chip and a typed instruction are the
  fallback, exactly as before.
- **The exact pre-message breakdown needs `POST /api/context-preview`,** a
  route added in this branch (`src/http/route-context-preview.ts`): the
  runtime builds — never runs, never persists — the prompt the next turn
  would open with and reports it through the TUI's own
  `contextUsageFromPrompt`. The installed 0.5.4 answers 404, which the
  desktop caches per connection and falls back to the trace projection.
- **Session grants.** The HTTP API implements `allow-once` and `deny` only, so
  the card offers exactly those.
- **Subscription-CLI providers** (`claude-cli`, `codex-cli`) are not in the
  desktop wizard: their config shape is not one this client writes.
- **Settings is the TUI menu.** The bottom-left gear (and ⌘ , and Escape with
  nothing else on screen) opens the menu tree from
  `src/tui/menu/menu-registry.ts` with the Manage tabs on the right — minus the
  `Go` group and its `Observe` submenu, which the user asked to remove.
  Manage's eight children are a top-level `Manage` group instead, keeping their
  labels and chords, so the group list is Manage · Session · Model · Run ·
  Setup · Help · Danger zone. Nothing became unreachable (Run is ⌘1 and the
  palette; Feed/World/Reasoning are the inspector button, the palette and the
  slash verbs; Logs, LLM logs and the debug pane are ⌘⇧Y and the console's own
  Agent/LLM segment) — the smoke asserts each of those routes and each of the
  eight surviving chords rather than leaving it a claim — but six `ctrl+g`
  chords — r, f, w, e, o, L — are dead and silent. Escape is the LAST branch of
  the key handler: scroll-to-bottom, abort, the toast pop and every
  overlay/palette/slash/approval/per-tab Escape still outrank it, and a
  half-written composer draft is left alone. During first-run onboarding
  Escape is deliberately inert: the wizard has no cancel, so the key neither
  dismisses it nor stacks the menu on top of it.
  Menu verbs the desktop cannot do (new terminal window, mouse, debug
  bundle, queued messages, uninstall) keep their TUI label with a
  "not available in the desktop" note; `Steer the running turn` is live and
  puts the caret in the composer, which is where steering happens. The
  `ctrl+g <key>` chords in the menu
  column are bound: ctrl+g arms the prefix for 1.5 s, the next key runs that
  node. The diagnostics line prints the TUI's
  null form (`llm — · step —`, `kv —`) for the process metrics this window
  does not have; the tool counters come from the open session's store rows.
  The Privacy tab shows the effective `analytics.enabled` (the schema default
  when `config.json` has no key, read with `atag config get`), as the TUI does.
- **Tasks** create through `atag task create` (POST /api/tasks on 0.5.4 takes
  no schedule), cancel through `DELETE /api/tasks/{id}` and run-now through
  `POST /api/tasks/{id}/run`; the next-firings preview is the agent's own
  cron-parser. The firings feed is not exposed by the HTTP API and the tab
  says so.
- **Skills** list through `atag skill list` (the only surface that carries
  disabled skills), toggle through `atag skill disable|enable` (the running
  agent keeps its boot-time registry, so the tab offers a restart), remove
  through `POST /api/skills/uninstall`, and read a detail body from
  `GET /api/skills/{name}` — or `atag skill show` when the route answers 404
  for a disabled skill. The Skills Hub browses through `atag skill browse` /
  `skill search`, fetches a ClawHub card body from the registry's detail
  endpoint, and installs through `atag skill install` (a `dangerous` scan
  verdict shows the TUI's confirm with the CLI's line as its one finding).
- **Memory** reads `<stateDir>/memory.sqlite` read-only (`sqlite3`, falling
  back to `node:sqlite`) with the stores' own statements, named and
  parameterised in the main process — the agent has no memory route.
- **MCP** rows come from `mcp.servers` in `config.json` plus the
  `mcp.<name>.*` tools registered with the agent; there is no MCP status
  route, so an enabled server's state reads `—` (never an inferred up/down)
  and resources/prompts say they are not exposed. Add and remove rewrite
  `mcp.servers` through the whole-file `atag config set` and offer a restart.
- **LLM** is the TUI's four panes. Local rows come from `atag models list`
  minus the ids `models list-embeddings` lists (the chat route never picks an
  embedding model, and which models those are is a fact the CLI publishes —
  the desktop no longer guesses it from vendor words in the id) plus
  `models list-embeddings` itself for the embedding block, the route card's daemon line from
  `atag models status` (the local route's model too — the desktop has no
  `/props`); Enter downloads / selects / starts through `models pull`,
  `models use`, `models start|stop`, `s`/`d`/`E`/`B`/`U`/`G` through the
  matching `models` subcommands and `localModels.managed.autoUpdate`, `L`
  tails `<dataDir>/llama-server.log`.
- **`a add from hugging face`** is live. The installed agent exposes no way
  to add one — `atag models --help` has no `add`, there is no HTTP route,
  and the agent's own `resolveHuggingFaceGgufChoices` has callers only
  inside `src/tui` — so `desktop/main/huggingface.ts` is a vendored port of
  `src/local-llm/huggingface-{ref,api,fit,model-def,resolve}.ts` plus a trim
  of `download-file.ts`, with the source paths in its header. It is a copy
  because the desktop is a separate CommonJS project that compiles only its
  own two directories; it will drift when the agent's copies change, and the
  smoke's verbatim copy assertions are the only alarm. The reference is
  parsed and the repo listed in the MAIN process (the renderer's CSP is
  `connect-src 'none'`), the chosen file becomes a `LocalModelDef` from the
  ported `buildCustomModelDef` and is spliced into `localModels.customModels`
  with the whole-file `atag config set`, and the weights then come down
  through the existing `atag models pull <custom-id>` → `cli:pull` banner
  unchanged. Errors from the parser and from huggingface.co are shown
  verbatim, because they are written for this screen. The RAM line warns and
  nothing more: weights larger than physical memory still start, mapped from
  disk. `atag models pull` fetches **weights only**, so the projector of a
  vision repo is downloaded by this window afterwards, on the same banner
  with the TUI's `<name> (mmproj)` phase label, and auto-activation waits for
  it — `models start` appends `--mmproj` only when the file is already on
  disk, so starting the daemon first would give a silently text-only daemon.
  If the projector download fails or is cancelled the model is **not**
  activated at all: the weights are on disk and the pane says so, rather than
  starting a daemon that would serve a vision model text-only.
  The pick list follows the TUI's `MouseListRow` contract rather than the
  Local pane's model rows: the first click on a file selects it, a second
  click on the selected one starts the download — the rows above it activate
  on the first click, and a file list is the one place where that would be an
  expensive misclick.
  Removal needs nothing new: `atag models remove <custom-id>` deletes the
  files and drops the config entry, so the pane's `d` is the whole undo. The
  first-run wizard's step 2 carries the TUI's own pinned row,
  `Add a model from Hugging Face…`, which opens this same branch in
  Settings — one implementation, not two. Gated repos: a 401/403 listing adds
  one line when `HF_TOKEN` is *named* in `<stateDir>/.env` (never its value),
  because `atag models pull` reads that file and this window does not, so a
  gated repo can fail to list here and download fine.
- **Ollama is a provider here, never a download source.** atomic-agent has
  no Ollama download path of any kind — no registry client, nothing reading
  `~/.ollama`, no converter; the only Ollama code in the agent is two
  provider presets, a health-failure hint and a steer modal, with zero hits
  under `src/local-llm`. Offering "download from Ollama" would be a
  capability this window invented, so the Local pane carries one
  non-interactive line pointing at the thing that does work: `Cloud › n add
  provider › Ollama (local)`, `http://localhost:11434`. Importing a model
  Ollama already pulled is technically possible (its blobs are real GGUF)
  and deliberately not built: `ollama rm` would dangle the link, Ollama keeps
  the chat template in a separate manifest layer so an imported GGUF can be
  served under the wrong one, and the schema's mandatory `huggingFaceUrl`
  would have to be a placeholder. Cloud rows read `llm.providers` and show `key ok` /
  `missing key` from the key NAMES present in this process's env ∪
  `<stateDir>/.env` (never values); the text-model list is the provider's
  `atag models search --json` (no pricing in it, so the `price:` facet stays
  at `all`). Enter on a provider row and picking a text model move the route
  through the same `activateProvider` / `selectCloudModel` the composer chip
  and the wizard use (`desktop/main/backend-switch.ts`: whole-file `llm`
  write, key check, daemon stop on a cloud route, then the `atag serve`
  restart), so the tab reports the switch and never asks for a restart;
  a switch is refused while a turn is running. The embedding provider,
  removing a provider and every Fallback edit are whole-file writes of
  `llm.*` (0.5.4 has no `llm` leaf) and say the running agent needs a
  restart — `atag serve` keeps its boot-time registry, the TUI hot-reloads
  its own. The External pane probes the URL from the main process
  (`/health`, `/props`, `/v1/models`, the TUI's verdict lines and its
  Ollama/OpenAI-compatible steer) before it writes `localModels.url` +
  `mode`; when that moves the route to `local-llama` the same
  `activateProvider` restart applies. Fallover events are not on the HTTP
  API, so the Fallback status line says so instead of "on primary".
- **Telegram** shows config + `.env` facts only: `telegram.enabled`, the
  owner, and whether `TELEGRAM_BOT_TOKEN` is set. The token prompt writes
  the key through a port of `src/config/dotenv-writer.ts` (atomic rename,
  0600, quoting for whitespace/shell characters); `T`/`O`/`e` clear the
  token, unset the owner and flip `telegram.enabled`, each with the restart
  note. The channel state, bot identity and pairing live inside the serve
  process: the state reads `unknown`, and pairing says to use `atag tui`.
- **Import** is the TUI's Hermes/OpenClaw form over `atag import <source>
  … --dry-run` (preview) and `… --yes` (apply) — always exactly one of the
  two, never a bare run (which exits 0 on a non-TTY having written nothing).
  The CLI's report lines are parsed into the TUI's rows; "Nothing to import."
  is its own state. Runs are refused while a turn is running.
- Writing config goes through `atag config set`, never `PATCH /api/config`,
  which re-defaults every block it does not merge. Leaf keys use the dotted
  form; **`llm.*` has no dotted spelling in 0.5.4** (the CLI's key table is
  derived from defaults that carry no `llm` block, so
  `config set llm.activeTextProvider` fails with `unknown key`), so the
  backend, provider and model switches are whole-file writes
  (`atag config set '<json>'`) that mirror the TUI's persist helpers. The
  desktop's `configSet` refuses `llm.*` outright so the dead path cannot
  return.
- **Switching backend/provider/model restarts `atag serve`** — the running
  agent pins its provider at boot and 0.5.4 has no reload route; a switch is
  refused while a turn is running. The restart also happens when the file
  already names the chosen route but the agent booted on another one (the
  TUI or a hand edit moved the file while the window was open): main
  remembers the route each `atag serve` came up on and compares.
- **The `custom` (external llama.cpp URL) backend** is a state the composer
  can be in but not a switch it offers. `local` and `custom` are the same
  provider entry (`local-llama`); `localModels.mode` tells them apart, so an
  external route reads as `custom` on the chip and draws the third backend row
  active — with no model control, because on that route the model is whatever
  the operator's own server has loaded and this window has not probed
  `/props`. Choosing that row opens Settings › LLM › External rather than
  writing anything: pointing the route at somebody else's server means probing
  the URL first, and the External pane is the desktop's editor for it (it
  writes mode `external`, `localModels.url` and the `local-llama` provider url
  in ONE whole-file write, the port of the TUI's `persistUserLocalLlmUrl` —
  two leaf writes would leave the provider url, and so the address the runtime
  actually calls, on the old server). The first-run setup still offers two
  choices, not the TUI's three. Choosing `local` from an external route
  converts it to managed, exactly as the TUI's own local row does.
- **Voice input is Apple's on-device speech, and nothing else.** The
  microphone button sits in the composer, left of Send. Press it and speak;
  the words appear in a strip above the composer while you are still
  talking, and land in the draft at your caret when you stop. "While you are
  still talking" is Apple's cadence, not an instant one: measured on this Mac,
  the first partial lands about four seconds into the take and the text then
  grows in roughly four-second bursts, so anything shorter than that appears
  only when you stop. (Verified with an independently structured helper as
  well — it is SpeechAnalyzer's cadence, not this code's. What IS this code's
  is that the helper reads stdin on a thread of its own: read inline it starved
  the results consumer on a narrow cooperative pool and emitted nothing at all
  until stdin closed.) Hold the
  button and release to stop, or tap it once and click again to stop —
  both work, because "unclick" reads either way. Escape throws the take
  away, and it is tested first in the keydown handler so that a pending
  approval, the palette, the slash popover or an open overlay cannot
  swallow it and leave the microphone hot. It does *not* clear a voice
  error strip: nothing else clears that state, so an Escape branch on it
  would outrank whatever modal you were actually looking at for the rest of
  the session — the error strip carries its own × instead.
  Enter and the Send button stop the recording and insert the text
  rather than sending: sending would post the draft as it stood before you
  spoke and lose the transcript, so a second Enter is what sends. That holds
  through the finalize window too — for the up-to-2.5 s while the helper is
  still emitting its last segment the strip says `inserting what you said —
  Enter and Send wait for it`, and they do wait; falling through there would
  have sent the pre-dictation draft and dropped the transcript into an empty
  composer a moment later.
  The audio goes renderer → main → `out/native/atomic-speech`, a small
  Swift helper running `SpeechAnalyzer` with a `SpeechTranscriber` (or a
  `DictationTranscriber` for the languages the first one has no model for).
  It never touches the network, is never written to disk, and never reaches
  the agent — 0.5.5 has no audio route, no transcription tool and no config
  key, so this feature makes no HTTP call, writes nothing to
  the state directory's `config.json` and never restarts `atag serve`. The chosen
  languages live in Electron's `userData/voice.json`.
  Until this feature there was no `setPermissionRequestHandler` at all and
  Electron's default granted everything; both handlers now go in and deny
  by default. What gets through is an audio-only `media` request while a
  voice session you started is armed, plus both clipboard permissions. That
  second exception is not cosmetic and it took a probe to get right: the
  composer's "copy session id" is a `navigator.clipboard.writeText` whose
  rejection is swallowed, so a denial breaks the copy while the toast still
  claims success — and which permission Chromium asks for depends on
  transient user activation. With a gesture behind it the request is
  `clipboard-sanitized-write`; without one (an IPC-driven or timer-driven
  copy) it is `clipboard-read`, and allowing only the first still denied the
  write. Both handlers call the one `voicePermissionVerdict()`, and the
  smoke asserts that function rather than a second copy of its body — and
  asserts the verdicts directly as well as through a live write, because the
  live write is refused before it ever reaches the gate when the window is
  not focused, which let a real denial survive two green runs.
  The strip's `On-device — the audio never leaves this Mac` was measured
  before it shipped, not taken from documentation: a Russian dictation fed
  at real time through both an `en-US` and a `ru-RU` analyzer, watched with
  `nettop -P -x -L 6 -p <helper pid>`, produced no row at all for the helper
  — the per-process capture is headers and nothing else — and the
  all-process capture taken in the same window carries 612 rows, none of
  them `corespeechd`, `com.apple.siri.embeddedspeech` or any other speech
  daemon, while recording other processes moving hundreds of megabytes.
  The Web Speech API is not an option here and was not guessed at: in
  Electron 44 on-device reports `unavailable`, `install()` returns `false`
  (no component updater), and a real recognition attempt ends
  `["start","audiostart","audioend","error code=network","end"]` because
  Electron ships without the Google key the network engine needs. Cloud
  transcription was refused on purpose — every AIMLAPI speech model is a
  submit-and-poll job, so it could only ever produce text after you stop,
  never while you speak, and it would send your voice to a third party.
- **Voice input: what is and is not possible.** `SpeechAnalyzer` is macOS
  26+, so on anything older the button is disabled and says
  `Voice input needs macOS 26 or later`; the app itself still runs from
  macOS 12. Off macOS it says `Voice input works only on macOS`, and a
  build without the helper says so too. 43 languages are available
  on-device: 30 through `SpeechTranscriber`, which punctuates and cases,
  and 13 more — Russian, Arabic, Dutch, Turkish, Thai, Vietnamese, Hebrew,
  Danish, Finnish, Norwegian, Swedish, Malay and Flemish — only through
  macOS's dictation model, which is on-device too but writes without
  punctuation. The language menu says which is which, and says when a
  language still has to download its model. Both the chip and the menu
  label a locale with `Intl.DisplayNames`, so the default chip reads
  `American English`, not `English (US)` — 43 locales that have to separate
  en-US from en-GB and pt-BR from pt-PT cannot use hand-written labels. Apple's older
  `SFSpeechRecognizer` lists 63 languages, and it is deliberately not used:
  on this Mac only `en-US` reported `supportsOnDeviceRecognition`, so every
  other language there would quietly upload your voice to Apple.
  **Two languages at once** is offered and is real: add a second installed
  language with `+` and both models hear the same audio, then the
  higher-scoring transcript wins the whole take and the chip says which
  language matched. The live text always follows the first language,
  because until you stop there is nothing to compare against. That the
  score can decide was measured on two fixtures, not assumed:

  | audio | `en-US` (SpeechTranscriber) | `ru-RU` (DictationTranscriber) |
  | --- | --- | --- |
  | 5.0 s of English | 0.976, correct, wins the take | 0.285, and the words are nonsense |
  | 6.1 s of Russian | **no result at all** — no partial, no final, no score | 0.75–0.83 depending on pacing, correct, wins the take |

  That second row is the one that matters, and it is why the winner is not
  chosen by comparing against the first language's score: on Russian speech
  the `en-US` leg says nothing whatsoever, so a leg with no words has to
  rank *below* a leg with words, or the shipped default (English first,
  Russian added with `+`) would throw away the only transcript there was and
  hand the composer an empty string. A take that really did produce nothing
  says `Nothing was heard` rather than leaving the composer silently
  unchanged. There is no auto-detection beyond this, and no analyzer takes
  more than one locale.

- **Tasks and Skills are the settings tabs.** ⌘2/⌘3, the palette hits and
  View › Tasks/Skills all open the settings window on that tab — one
  implementation, as the TUI's Manage tabs are. ⌘1 closes it and returns to
  the transcript. The sidebar's own Tasks list (above) is the summary; a row
  clicked there opens that task in the Tasks tab.

## Verification

`npm run smoke` launches the app for real, waits for the agent, and asserts:

```
PASS renderer painted
PASS toolbar titled
PASS bridge exposed
PASS agent connected — state=connected
PASS context has a basis before the first message — {"tokens":5910,"source":"projected",…}
PASS draft moves the projection by its estimate — 5910 + 15 → 5925
PASS window resolved without opening the picker — window=1048576 (model window) provider=aimlapi
PASS panel basis line names the baseline — projected from the last prompt this agent built for … in this workspace — api-…, 4 minutes ago. …
PASS no trace → not measured yet, chip hidden — source=null tokens=0 chip=false …
PASS skills loaded
PASS agent replied — "hello there friend"
…
PASS live card never takes a stale trace row
PASS missing trace file rejects, never hangs
PASS reopened session carries trace durations
PASS reopened os.fs.list turn is timed
PASS durations read as the TUI prints them
PASS transcript scrollable for the fold test
PASS expand keeps the card head in place
PASS collapse keeps the card head in place
PASS open state and scroll survive a re-render
PASS unfolding a run keeps its head in place
PASS no fake zero for an untraced call
PASS tool cards keep inside the panel
PASS long URLs keep inside the panel
PASS backend: config round-trip to local — from=aimlapi active=local-llama mode=managed … restart=true
PASS backend: renderer follows the file — backend=local …
PASS backend: agent restarted and alive — state=connected port …
PASS backend: local turn gate blocks with the TUI's text — … draft="hi"
PASS backend: config round-trip back to cloud — provider=aimlapi …
PASS backend: serve behind the file still restarts — file moved first: true …
PASS mic button sits next to send — field children "TEXTAREA|micbtn|sendbtn mute"
PASS every disabled case has a sentence — 8 named cases
PASS voice reports itself honestly — available=true code= reason="" disabled=false
PASS a disabled button carries the true reason — voice-os-too-old→off, voice-helper-missing→off, voice-not-macos→off
PASS an idle strip is a hidden placeholder, not a missing node — hidden=true empty=true
PASS interim renders without touching the draft — strip "refactor the login", draft "fix "
PASS the on-device sentence is the one that ships — note "On-device — the audio never leaves this Mac · Enter or Send stops the recording and inserts the text; it does not send", offMachine false
PASS segments accumulate — "Open the settings pane. Then switch the backend. Finally"
PASS a take that ends on a final is not doubled — strip text "a. b.", partial ""
PASS and the doubled sentence is not inserted either — "a. b."
PASS final text is inserted at the caret and nothing is sent — draft "fix Open the settings pane. …", user messages 1→1
PASS a cancelled recording inserts nothing — draft "fix ", state idle, strip hidden=true empty=true
PASS Escape cancels a recording before every other Escape branch — state idle, scrollTop 0→0
PASS Escape still cancels with the slash popover open — popover open before Esc=true
PASS Escape still cancels with an approval pending — pending before Esc=true
PASS an error strip keeps Escape and is dismissed by its own control — after Escape error, × present=true, then idle
PASS the recording pulse survives the transcript repaints, and the strip still leaves on cancel — dot kept=true mic kept=true, text "refactor the login handler", dot after cancel=false
PASS a second language can win the take — final "Открой панель настроек", winner ru-RU, chip "Russian (Russia) matched"
PASS and the winning language is what gets inserted — "Открой панель настроек"
PASS a second language wins even when the first one heard nothing — strip "Открой панель настроек и переключи бэкенд на облако", inserted "Открой панель настроек и переключи бэкенд на облако"
PASS the language menu lists the on-device models and says one is active — 2 rows, foot "Transcribed on this Mac. One language is active at a time un"
PASS the + control adds a second language and the choice is remembered — 4 rows, after + ["en-US","ru-RU"], voice.json ["en-US","ru-RU"]
PASS choosing a new first language keeps the second one — after picking de-DE ["de-DE","ru-RU"], voice.json ["de-DE","ru-RU"]
PASS an uninstalled language goes to the download, not to the selection — install asked for ["fr-FR"], languages still ["de-DE","ru-RU"]
PASS the renderer cannot take the camera — getUserMedia({video:true}) → NotAllowedError
PASS and cannot take the microphone outside a session the user started — armed=false; audio→false
PASS the voice permission gate leaves the clipboard alone — verdicts sanitized-write+read=true; permissions.query(clipboard-write) → granted; writeText → OK; pasteboard held text/plain+…
PASS the worklet ships next to the renderer
PASS the speech helper answers — exit 0, 43 supported, 14 installed
PASS nothing was written to the agent — config.json byte-identical across 4096 bytes
SMOKE screenshot=…/atomic-desktop-smoke.png failures=0
```

It exits non-zero on any failure and always writes a screenshot, so it works as
a CI gate. Renderer console errors are forwarded to stderr.

The `backend:` checks run on every plain `npm run smoke`, not only under
`--models`: they switch the route cloud → local → cloud → local (the last
leg with the file moved by hand first, the way the TUI or an editor would),
so expect `atag serve` to be restarted four times (three switches plus the
restore in `finally`) and the llama.cpp daemon to be started and stopped
along the way. That needs a downloaded local model in the state dir and adds
one to two minutes. The whole config file, the daemon state and a fresh
agent are put back in `finally`, so a failing assertion cannot leave the
route changed. Run it against a private `ATOMIC_AGENT_STATE_DIR`, never
`~/.atomic-agent`.

## The state directory

**This app has its own, and it is not the terminal agent's.** The user's
words: *"Each time I'm running the agent for the first time I should go
through the setup wizard so I understand how the setup process works. None
of the keys should be shared between the TUI and the desktop app, at least
during the testing phase."*

- The desktop runs on **`~/.atomic-agent-desktop`**, created `0700`. Its own
  `config.json`, its own `.env`, its own sessions/memory/tasks databases,
  its own traces and skills. `~/.atomic-agent` is never written by any
  process this app starts.
- Precedence, resolved once in `main/state-dir.ts`: an explicitly set,
  absolute `ATOMIC_AGENT_STATE_DIR` wins (the smoke suite and every parallel
  lane depend on it), then `ATOMIC_AGENT_DESKTOP_STATE_DIR`, then the
  default above. The desktop directory is the DEFAULT, not an override.
- `main/state-dir-boot.ts` is the **first import in `main.ts`** and the only
  place with a side effect: it publishes the value into `process.env`,
  latches whether this is a first run (before `atag config get` can create a
  `config.json` and make it look otherwise), and creates the directory.
  Every spawn site names `agentEnv()` as well, so inheritance is never the
  only guarantee.
- **The model weights are shared; nothing else is.** On a fresh directory,
  `~/.atomic-agent-desktop/models/models` is symlinked to the terminal
  agent's, so the gigabytes are not downloaded twice, and `models/backend`
  is *copied* rather than linked — `localModels.managed.autoUpdate` defaults
  to true and would otherwise rewrite the operator's llama.cpp binaries. The
  pid file, the daemon log and the session registry stay private, and the
  desktop's managed port is **19191** and its embedding port **19192**
  (both `localModels.embeddings.port` and `.url` move, because the daemon is
  started on the port and the client reads the url) so two daemons cannot
  collide.
  Consequence, stated plainly: a `models pull` from the desktop writes into
  the terminal agent's model folder, and `models remove` deletes from it.
  That is the one path by which anything here touches `~/.atomic-agent`;
  config, keys and the databases never do.
  **That two-way door is opened only for the desktop's own default
  directory** — `state-dir-boot.ts` gates the seed on `!STATE_DIR_FROM_ENV`
  as well as on the directory being fresh. A directory you named through
  `ATOMIC_AGENT_STATE_DIR` (or `ATOMIC_AGENT_DESKTOP_STATE_DIR`) you named
  because it is disposable, and a throwaway install must not come up holding
  a live write path into your real weight folder — so a fresh env-named
  directory gets the `0700` mkdir and nothing else: no weights link, no
  backend copy, and a first `models pull` that downloads its own. The env
  var still *wins* the resolution; what it does not inherit is the link.
- **The import offer — the IPC, not yet the screen.** What lives on this
  branch is `main/tui-import.ts` and the two calls the wizard will make:
  `window.atomic.tuiSetupPresent()` reports what `~/.atomic-agent` holds (env
  var NAMES only, never a value; one parser counts them, so `has.keys.length`
  from the offer and `copied.keys` from the import always agree — a name is
  listed once, a repeat is last-wins, and a placeholder line with no value is
  not a key) and
  `window.atomic.importFromTui({providers, keys, skills, sessions, memory})`
  copies only what is ticked, every flag defaulting to false. The wizard step
  that draws the tick-list IS in this branch now (`obDetectAgents` pushes the
  *Atomic Agent in the terminal* row; the seam is asserted in the suite). The
  offer counts the providers the import will actually copy — the source's own
  `local-llama` entry is skipped, because its `managed.port` is the terminal
  agent's — and the import never RE-ROUTES this app: `llm.activeTextProvider`
  is only filled in when the desktop has no route of its own *and* the
  provider resolves a key here, so an operator who chose Local models in the
  wizard keeps it. The source is opened read-only and never moved; `localModels` in its entirety — the managed
  port and the dataDirOverride with it — `tui.onboarding`, `telegram`,
  `analytics`, `version` and `tasks.sqlite` are never copied, and the
  databases travel through `sqlite3 -readonly … ".backup"` rather than a
  `cp` of a live file with an open WAL. The *destination* databases belong
  to the agent this window already started, so that arm of the import stops
  `atag serve`, deletes the destination's stale `-wal`/`-shm`, restores, and
  starts it again.
- **The one thing this design cannot isolate, stated honestly.** Every agent
  subprocess gets `{...process.env, ATOMIC_AGENT_STATE_DIR}`, so an
  `AIMLAPI_API_KEY`, `OPENROUTER_API_KEY` or `HF_TOKEN` **exported in the
  shell that launches Electron** reaches the desktop's agent, and
  `keyNamesAvailable()` counts `process.env` before `<stateDir>/.env`. Against
  the user's words — *"None of the keys should be shared"* — that is a leak,
  and it is not closable from here: stripping the environment would break the
  many operators who keep their keys only in a shell profile, and the agent
  itself reads `process.env` first (`load-dotenv.ts`). The `.env` files are
  fully separate; the *shell* is shared. Launch the desktop from a shell with
  no provider keys exported if that matters for a test.
- **Making it a first run again is one gesture:** `rm -rf
  ~/.atomic-agent-desktop`. The wizard opens on the next launch, because
  `app:firstRun` reports the latched flag rather than inferring one from a
  file the agent has already written. The suite proves that end to end
  rather than by inspection: `electron . --first-run-probe` boots a window
  against whatever `ATOMIC_AGENT_STATE_DIR` names, starts no `atag serve`,
  and prints one `FIRSTRUNPROBE {json}` line saying whether the latch said
  fresh and whether the wizard put itself on screen. The smoke run makes an
  empty directory and drives it.
- The window says which directory it owns: the diagnostics line under
  Settings carries a `state <dir>` segment beside `agent <bin>`.

## Building a testable .dmg

**The app already installed at `/Applications/Atomic Agent.app` has none of
this.** Its `app.asar` was built on 1 September, before the coding-mode chip
existed: it carries no `/api/coding-mode` call and no `~/atag-agent`
candidate in its binary search, so double-clicking it keeps spawning
`~/.local/bin/atag` and keeps showing the chip's old, greyed-out state no
matter what this branch does. `cd desktop && npm run start` from this
worktree is what shows the fix today. Moving it into `/Applications` takes
the `npm run dist` below plus a reinstall from the DMG it writes — that is a
release step, and this branch deliberately does not perform it.

```bash
cd desktop
npm install
npm run dist
```

Output: `desktop/release/Atomic Agent-<version>-arm64.dmg` (Apple Silicon,
about 121 MB).

The build is **unsigned and un-notarised** — `mac.identity` is explicitly
`null` so electron-builder does not pick up a stray keychain identity and fail
half way. A DMG you build yourself carries no quarantine flag and opens
normally. One you download or receive over AirDrop does, and macOS will refuse
it; clear the flag or right-click → Open:

```bash
xattr -dr com.apple.quarantine "/Applications/Atomic Agent.app"
```

The voice helper is compiled into `out/native/atomic-speech` by
`scripts/build-speech-helper.mjs` on every `npm run build` (about two
seconds; the step prints `speech helper: skipped` and the build carries on
if there is no `swiftc`). It ships through `extraResources`, NOT through
`files` — `asar` is on, and a binary inside an asar archive cannot be
executed, so `out/native/**` is excluded from the archive and the same file
is copied to `Contents/Resources/native/atomic-speech`. `mac.extendInfo`
carries `NSMicrophoneUsageDescription`; without it TCC kills the packaged
app the first time the renderer opens the microphone. The .app is ad-hoc
signed, so its signature changes on every rebuild and macOS re-asks for
microphone access after each new build — expected, not a bug.

The app does **not** bundle the agent. It looks for `ATOMIC_AGENT_BIN` first,
then `~/atag-agent/bin/atag`, then `atag` (or `atomic-agent`) in
`~/.local/bin`, `/usr/local/bin` and `/opt/homebrew/bin`. Without one the
window still opens and says so instead of failing silently. Whichever it
started is printed in the diagnostics line as `agent <path>`, in both the
supported and unsupported cases — the desktop can be running a different
agent from the terminal's `atag`, and that has to be answerable from the
window.

`~/atag-agent/bin/atag` is the locally built agent, and it is deliberately
preferred over the released install: a released 0.5.5 binary has no
`/api/coding-mode`, which is what greys the coding-mode chip out. It is a
three-line shebang script carrying an absolute node path (the app is spawned
without a shell and a Finder-launched `.app` has a minimal `PATH`) over a
checkout of this branch:

```bash
git clone <this repo> ~/atag-agent && cd ~/atag-agent
# If it was cloned from a temporary worktree, repoint it at the repo that
# outlives one — otherwise the next `git pull` has nowhere to go:
git remote set-url origin https://github.com/AtomicBot-ai/atomic-agent
npm install --engine-strict=false && npm run build
mkdir -p ~/atag-agent/bin   # the repo ships no bin/; the build writes dist/ only
printf '#!/bin/sh\nexec %s --enable-source-maps %s/dist/cli/index.js "$@"\n' \
  "$(command -v node)" "$HOME/atag-agent" > ~/atag-agent/bin/atag
chmod 755 ~/atag-agent/bin/atag && ~/atag-agent/bin/atag --version
```

The smoke suite depends on this: the four live coding-mode round-trip checks
run only when the agent it spawned carries `/api/coding-mode`, which in
practice means this checkout. Without it the block collapses to the single
line `coding mode round-trip skipped: agent has no route`, and the suite is
then proving the chip's honest-blank path rather than the feature. A routeless
binary that IS the preferred one still fails, so the skip cannot hide a
regression — but a green run on a machine that has never been through this
recipe is a smaller claim than one on a machine that has.

Nothing under `~/.local/bin` is touched, so a terminal `atag` keeps running
the released binary. Rollback is `rm -rf ~/atag-agent`; do exactly that once
the route ships in a release, or the desktop will keep preferring a build
that has fallen behind. Re-run `npm run build` and re-check `--version` after
every pull: a missing `dist/cli/index.js` fails at spawn time with an
unhelpful node error. The checkout tracks this branch, which exists only
until it merges, so update it with `git pull origin main` (plus a rebuild)
rather than a bare `git pull`.

The packaged app answers `--smoke` exactly like the dev build, which is how a
release candidate gets checked before it goes anywhere:

```bash
"/Applications/Atomic Agent.app/Contents/MacOS/Atomic Agent" --smoke
```

## Layout

```
desktop/
  main/agent-client.ts   spawn + supervise `atag serve`, HTTP + SSE client
  main/agent-cli.ts      `atag` subprocesses: config reads/writes, models, traces
  main/backend-switch.ts the TUI's backend/provider/model decisions, main-side
  main/main.ts           lifecycle, window, IPC, the smoke harness
  main/menu.ts           the native menu bar
  main/speech.ts         the one voice-input child: probe, start/stop, audio, install
  native/atomic-speech.swift  on-device transcription (SpeechAnalyzer), NDJSON on stdout
  preload/preload.ts     the window.atomic bridge
  renderer/              index.html · styles.css · renderer.js · voice-worklet.js
  scripts/copy-renderer.mjs
  scripts/build-speech-helper.mjs
```

The renderer is the design prototype, unbundled and unminified. `renderer.js`
ends with a live-wiring section: with `window.atomic` present it clears the demo
data and drives the real agent; without it, the file runs exactly as the
prototype does in a browser.
