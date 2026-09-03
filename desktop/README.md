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
  duration is the wall time this window observes between a tool's frame and
  the next frame, and the card's tooltip says so: neither the store (which
  stamps one `at` on a call and its result) nor the trace (one `ts` at
  completion) records how long a tool ran, so there is no agent-side number
  to show. Three or more consecutive calls to the same tool fold into one
  line.
- file paths and URLs in replies: files are chips that open in the default
  app, with a right-click menu (Open · Show in Finder · Copy Path · Save As…);
  URLs open in the browser
- approval prompts, resolved over `/api/approval/resolve`
- installed skills, durable tasks, and sessions — named by their first
  message and opened in full from the sidebar
- the model selector: backend, provider and model chips, each opening one
  pane; switching backend applies immediately; picking a model applies and
  closes before the config write confirms
- the add-provider wizard: the TUI's kind list (nothing preselected) → key /
  base URL → verification by listing the provider's models under that key →
  saved, activated, and a default model picked
- the context gauge, measured from the agent's trace after each turn, with
  the TUI's one control: tasks per turn (`agent.conversationMaxPairs`, 1–100)
- coding modes default / plan / auto / bypass, applied live through
  `/api/coding-mode` exactly as the TUI's `onCodingModeChanged` does — the
  runtime's ladder and plan flag move, `config.json` is untouched. The Privacy
  pane shows the persisted baseline read-only; the chip is the one approval
  surface, as in the TUI since PR #303.

Honestly degraded, and labelled as such in the UI:

- **Coding modes need an agent that has `/api/coding-mode`.** That route is
  added in this branch (`src/http/route-coding-mode.ts`); a binary without it
  answers 404 and the chip says so rather than pretending.
- **Session grants.** The HTTP API implements `allow-once` and `deny` only, so
  the card offers exactly those.
- **Subscription-CLI providers** (`claude-cli`, `codex-cli`) are not in the
  desktop wizard: their config shape is not one this client writes.
- **Settings is the TUI menu.** The bottom-left gear (and ⌘ ,) opens the
  menu tree from `src/tui/menu/menu-registry.ts` with the Manage tabs on the
  right. Menu verbs the desktop cannot do (new terminal window, mouse, debug
  bundle, queued messages, steer, uninstall) keep their TUI label with a
  "not available in the desktop" note. The diagnostics line prints the TUI's
  null form (`llm — · step —`, `kv —`) for the process metrics this window
  does not have; the tool counters come from the open session's store rows.
- **Tasks** create through `atag task create` (POST /api/tasks on 0.5.4 takes
  no schedule), cancel through `DELETE /api/tasks/{id}` and run-now through
  `POST /api/tasks/{id}/run`; the next-firings preview is the agent's own
  cron-parser. The firings feed is not exposed by the HTTP API and the tab
  says so.
- **Memory, skills, MCP, LLM, Telegram and Import tabs** land in the next
  steps of this branch; skills are read-only until then.
- Writing config goes through `atag config set`, never `PATCH /api/config`,
  which re-defaults every block it does not merge.

## Verification

`npm run smoke` launches the app for real, waits for the agent, and asserts:

```
PASS renderer painted
PASS toolbar titled
PASS bridge exposed
PASS agent connected — state=connected
PASS skills loaded
PASS agent replied — "hello there friend"
SMOKE screenshot=…/atomic-desktop-smoke.png failures=0
```

It exits non-zero on any failure and always writes a screenshot, so it works as
a CI gate. Renderer console errors are forwarded to stderr.

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
