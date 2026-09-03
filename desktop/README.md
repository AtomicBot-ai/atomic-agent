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

The turn stream is sent with `X-Atomic-Extensions: 1`, which upgrades it from
plain OpenAI chunks to atomic's named frames — `session_id`,
`reasoning_progress`, `tool_progress` — so the transcript can draw real tool
cards and a reasoning disclosure instead of a wall of text.

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
- the transcript: your message, the streamed reply, reasoning, and tool cards
  whose args come off the stream (`tool_progress.label`) and whose result and
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
  for a file that is not there. Nothing else feeds the strip: a path the reply
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
  have read. Chats can be pinned and unpinned from the row's hover button or
  its right-click menu (Pin/Unpin · Delete…), and **Delete really deletes**:
  `DELETE /api/sessions/{id}`, not a splice that the next load undoes.
  Pinning and the read stamps live in Electron's `userData/prefs.json` — per
  machine, per viewer — because the agent has no route and no store field for
  either, and its `config.json` is the operator's file. On a machine that has
  never run this window every historical chat is therefore unread until it is
  opened; that is honest, not a bug. Skills left the sidebar (the user asked
  for it); ⌘3, the palette and View › Skills still open it, on Settings ›
  Skills. Collapsed — Setup › Hide or show the sidebar, or a window narrower
  than 1000px — the two lists stay as a column of dots, each row's tooltip
  naming it, so the rail is still a way back into a chat.
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
  surface, as in the TUI since PR #303.

Honestly degraded, and labelled as such in the UI:

- **Coding modes need an agent that has `/api/coding-mode`.** That route is
  added in this branch (`src/http/route-coding-mode.ts`); a binary without it
  answers 404 and the chip says so rather than pretending.
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
- **Settings is the TUI menu.** The bottom-left gear (and ⌘ ,) opens the
  menu tree from `src/tui/menu/menu-registry.ts` with the Manage tabs on the
  right. Menu verbs the desktop cannot do (new terminal window, mouse, debug
  bundle, queued messages, steer, uninstall) keep their TUI label with a
  "not available in the desktop" note. The `ctrl+g <key>` chords in the menu
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
  and `models list-embeddings`, the route card's daemon line from
  `atag models status` (the local route's model too — the desktop has no
  `/props`); Enter downloads / selects / starts through `models pull`,
  `models use`, `models start|stop`, `s`/`d`/`E`/`B`/`U`/`G` through the
  matching `models` subcommands and `localModels.managed.autoUpdate`, `L`
  tails `<dataDir>/llama-server.log`. `a add from hugging face` is disabled:
  the HF import lives in the TUI's editor and `atag models pull` takes
  catalogue ids only. Cloud rows read `llm.providers` and show `key ok` /
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
- **The `custom` (external llama.cpp URL) backend** is not offered by the
  selector or by the first-run setup (two choices, not the TUI's three):
  the TUI probes the URL before writing mode `external` + the provider url
  in one write. The one place that does it in the desktop is Settings › LLM
  › External, which runs the probe first (see the LLM bullet above).
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

## Building a testable .dmg

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

The app does **not** bundle the agent. It looks for `atag` (or
`atomic-agent`) in `~/.local/bin`, `/usr/local/bin` and `/opt/homebrew/bin`,
or wherever `ATOMIC_AGENT_BIN` points. Without one the window still opens and
says so instead of failing silently.

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
  preload/preload.ts     the window.atomic bridge
  renderer/              index.html · styles.css · renderer.js
  scripts/copy-renderer.mjs
```

The renderer is the design prototype, unbundled and unminified. `renderer.js`
ends with a live-wiring section: with `window.atomic` present it clears the demo
data and drives the real agent; without it, the file runs exactly as the
prototype does in a browser.
