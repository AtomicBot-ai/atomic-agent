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

- connection state, working directory and llama-server health
- the transcript: your message, streamed reply, reasoning, tool calls
- approval prompts, with the agent's own category, reason, preview and
  affected paths, resolved over `/api/approval/resolve`
- installed skills, durable tasks, persisted sessions, the tool inventory
- approval level, active provider and model, and the context cap, all read
  from the live config

Honestly degraded, and labelled as such in the UI:

- **Session grants.** The approval card offers "allow this category" and
  "allow all *shape* commands" because the TUI does. The HTTP API only
  implements `allow-once` and `deny`, so those buttons behave as allow-once
  and say so in the transcript.
- **Tool results.** The stream carries tool *calls* but not their results;
  cards close as done without a result body. Recovering them means reading
  `GET /api/sessions/{id}` after the turn — not wired yet.
- **Run modes and the cloud-share dial.** Local/Cloud/Fusion is a TUI concept
  that the HTTP API does not expose. The chip reflects the active provider
  from config and the dial is inert.
- **Memory.** There is no HTTP route for it; the room shows demo content.
- **Tasks and skills are read-only.** Creating, cancelling or enabling would
  need `atag task` / `atag skill` subprocess calls.
- Writing config is deliberately absent: `PATCH /api/config` re-defaults every
  block it does not merge, so it would silently reset `llm.providers`,
  `mcp.servers` and more. Config writes belong on `atag config set <key>`.

Without an agent binary the window still opens and runs a scripted demo, so the
design can be reviewed without an install.

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
