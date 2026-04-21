# atomic-agent

Lightweight local general-purpose operator agent. Runs as a Tauri-friendly sidecar (or standalone CLI) and drives a KV-cache-friendly agent loop against an **external** `llama.cpp` server.

`atomic-agent` is **not** a coding agent. It is an "OpenCUA-on-minimum" operator: it controls the host browser (already-installed Chrome/Edge) and a small set of OS tools (shell, fs, clipboard, window, notify), and executes user-authored *skills* — Markdown playbooks with optional shell/Node scripts.

## Key properties

- Connects to an existing `llama-server` by URL — no LLM binaries are bundled.
- **Multi-turn chat.** A session is a persistent conversation: `user message → 0..N tool steps → reply` is one macro-turn, the whole history lives in `SessionState.turns[]`. The agent picks between chatting (`reply` tool) and acting (browser/OS/skill tools) on every step. `finish` ends the whole session.
- KV-cache-friendly stable prompt prefix (`system + tool catalog + capabilities + skill catalog`) with per-session `slot_id`. Multiple turns inside one session share the same slot.
- GBNF grammar-constrained tool calls for reliable JSON even on 7–9B models.
- Browser automation via `playwright-core` over system Chrome/Edge with a persistent profile. LLM sees a compact ARIA snapshot and references elements by `aria-ref=eN`.
- OS tools: shell, filesystem, clipboard, window management (`osascript`/`wmctrl`/PowerShell), native notifications.
- Skill system (Hermes-style): progressive loading via `skill.view`, vetted scripts via `skill.run_script` (always approved), local-only install (`skill install <path>`).
- Dangerous-only approval gate (shell, fs-write, non-http(s) navigation, skill scripts).
- NDJSON sidecar protocol shared between the Tauri host and the sidecar — chat-only, with `send_message` / `assistant_reply` / `turn_started` / `turn_finished` events.
- Per-platform Node SEA binaries (darwin-arm64/x64, linux-x64, win-x64).

## Install & build

```bash
npm install
npm run build
```

## Configuration

User-facing knobs live in a JSON config file at `<stateDir>/config.json`. It is
generated with safe defaults the first time the runtime starts. Manage it with
`atomic-agent config …` or edit the file by hand — see [Config file](#config-file)
below. Bootstrap and optional env variables stay in environment (see
[`.env.example`](.env.example)):

| Variable | Default | Purpose |
|---|---|---|
| `ATOMIC_AGENT_STATE_DIR` | `~/.atomic-agent` | State, config, profile, skills |
| `ATOMIC_AGENT_LLAMA_API_KEY` | *unset* | Optional bearer token |
| `ATOMIC_AGENT_BROWSER_CHANNEL` | `chrome` | `chrome` / `msedge` / `chromium` |
| `ATOMIC_AGENT_BROWSER_HEADLESS` | `false` | Headless mode |
| `ATOMIC_AGENT_BROWSER_CDP_URL` | *unset* | Attach over CDP instead of launching |
| `ATOMIC_AGENT_SKILLS_CATALOG_BUDGET` | `512` | Token budget for skill catalog in the stable prefix |

### Config file

`<stateDir>/config.json` with the following shape and defaults:

```json
{
  "version": 1,
  "llama": { "url": "http://127.0.0.1:8080" },
  "log":   { "level": "info" },
  "agent": {
    "tokenBudget": 3000,
    "maxSteps": 25,
    "toolTimeoutMs": 60000,
    "approvalRequired": true
  }
}
```

| Key | Purpose |
|---|---|
| `llama.url` | External llama-server URL |
| `log.level` | `debug` / `info` / `warn` / `error` |
| `agent.tokenBudget` | Hard cap for the stable prefix + world snapshot + session facts (tokens). The conversation transcript is not counted — full chat history is always sent as-is. |
| `agent.maxSteps` | Max steps per agent loop |
| `agent.toolTimeoutMs` | Default tool timeout (ms) |
| `agent.approvalRequired` | Approval gate on dangerous tools |

Manage via CLI (two commands, whole-file semantics — no dotted keys):

```bash
# Print the whole file (after auto-creating it with defaults on first run)
atomic-agent config get

# Replace the whole file with a validated JSON payload
atomic-agent config set '{
  "version": 1,
  "llama": { "url": "http://127.0.0.1:18991" },
  "log":   { "level": "info" },
  "agent": {
    "tokenBudget": 3000,
    "maxSteps": 40,
    "toolTimeoutMs": 60000,
    "approvalRequired": true
  }
}'

# Edit-and-apply loop:
atomic-agent config get > /tmp/agent.json
$EDITOR /tmp/agent.json
atomic-agent config set "$(cat /tmp/agent.json)"
```

> **Migration note:** Earlier versions read these keys from environment
> variables (`ATOMIC_AGENT_LLAMA_URL`, `ATOMIC_AGENT_LOG_LEVEL`,
> `ATOMIC_AGENT_TOKEN_BUDGET`, `ATOMIC_AGENT_MAX_STEPS`,
> `ATOMIC_AGENT_TOOL_TIMEOUT_MS`, `ATOMIC_AGENT_APPROVAL_REQUIRED`). Those
> env vars are no longer read — copy their values into `config.json` or
> apply via `atomic-agent config set '<json>'`.

## CLI

```bash
# Interactive chat. readline reads stdin, every line is sent as a user
# message into runtime.runTurn; assistant replies go to stdout, tool
# events to stderr. /quit exits, /abort cancels the current turn.
atomic-agent run --cwd /path/to/work

# Chat-like TUI: one long-lived SessionState, ink-based chat transcript,
# re-uses the browser profile and llama-server slot across turns. Hotkeys:
# enter = send message, tab = chat/feed/world/logs, esc = abort current
# turn (quit if idle), ctrl+c = quit, y/n = approval decisions.
atomic-agent tui --cwd /path/to/work

# Manage skills (markdown playbooks + scripts)
atomic-agent skill install ./my-skill
atomic-agent skill list
atomic-agent skill show check-gmail-inbox
atomic-agent skill uninstall check-gmail-inbox

# Manage user config (see "Config file" above)
atomic-agent config get
atomic-agent config set '{"version":1, ...}'

# Start the OpenAI-compatible HTTP server (see "HTTP API" below)
atomic-agent serve --host 127.0.0.1 --port 8787 --cwd /path/to/work
```

See [SKILLS.md](SKILLS.md) for the skill format.

## HTTP API (`atomic-agent serve`)

`atomic-agent serve` exposes a small HTTP surface backed by the exact
same `createAgentRuntime()` that powers `run` / `tui`. One turn on the
wire = one macro-turn in the loop (`user → 0..N tool steps → reply`).
The server is loopback-only by default and uses the built-in Node
`http` module — no extra dependencies, no dent on the sidecar SEA
bundle size.

```bash
atomic-agent serve \
  --host 127.0.0.1 \
  --port 8787 \
  --cwd /path/to/work \
  --api-key "$ATOMIC_AGENT_API_KEY"   # or set the env var directly
```

Authentication is optional. When `--api-key` (or env
`ATOMIC_AGENT_API_KEY`) is set, all routes require a
`Authorization: Bearer <key>` header; `/health` and `/v1/models` stay
public so OpenAI SDKs can probe before auth.

### OpenAI-compatible routes

- `POST /v1/chat/completions` — the OpenAI Chat Completions API.
  `stream: true` opens SSE; each tool step emits an `event:
  tool_progress` frame, the final assistant reply comes as a standard
  content-delta chunk, followed by `event: usage`, a `finish_reason`
  chunk, and the canonical `data: [DONE]`.
- `POST /v1/chat/completions/{id}/cancel` — abort a streaming
  completion by its id.
- `GET /v1/models` — single synthetic `atomic-agent` model entry.

Session continuation follows the hermes-style `Option A`: if
`X-Atomic-Session-Id` (or body `session_id`) is present the request
resumes that session; otherwise a stable id of shape
`api-<sha256:16>` is derived from `(system, firstUserMessage)`. Only
the **last** user message of the request body drives the new turn —
history lives in `SessionState.turns[]`, not the request.

### atomic-agent admin routes

All require auth when `--api-key` is configured.

| Route | Purpose |
|---|---|
| `GET /health` | Runtime liveness + llama-server reachability |
| `GET /api/capabilities` | Host caps + tool/skill catalogs + paths + llama config |
| `GET \| PATCH /api/config` | Read or merge-write the user config file |
| `GET /api/skills` | List installed skills |
| `GET /api/skills/{name}` | Manifest + SKILL.md body |
| `POST /api/skills/install` | `{ sourcePath, source?: "global"\|"project", force? }` |
| `POST /api/skills/uninstall` | `{ name, source?: "global"\|"project" }` |
| `GET /api/sessions` | Recent sessions for the working dir (`?limit=` up to 200) |
| `GET /api/sessions/{id}` | Full `SessionState` |
| `DELETE /api/sessions/{id}` | Purge (idempotent) |
| `POST /api/approval/resolve` | `{ approvalId, decision: "allow-once"\|"deny", reason? }` |
| `GET /api/events` | SSE stream of pending approval requests |

## Sidecar protocol

The sidecar reads newline-delimited JSON from stdin and writes it to stdout. Schemas live in `src/sidecar/sidecar-events.ts` and are re-exported from the package root.

Chat flow:

```json
// Create an empty session.
{"kind":"request","id":"r-1","type":"start_session","payload":{"workingDir":"/home/me"}}

// Send a user message; drives one macro-turn.
{"kind":"request","id":"r-2","type":"send_message","payload":{"sessionId":"s-1","text":"hi, can you check Gmail?"}}
```

Example sidecar events for one turn:

```json
{"kind":"event","id":"e-1","type":"user_message","correlationId":"r-2","payload":{"sessionId":"s-1","text":"hi, can you check Gmail?"}}
{"kind":"event","id":"e-2","type":"turn_started","correlationId":"r-2","payload":{"sessionId":"s-1","turnIndex":0}}
{"kind":"event","id":"e-3","type":"tool_call_result","correlationId":"r-2","payload":{"sessionId":"s-1","stepIndex":0,"tool":"browser.read_aria","status":"ok","summary":"url: https://mail.google.com/ …"}}
{"kind":"event","id":"e-4","type":"assistant_reply","correlationId":"r-2","payload":{"sessionId":"s-1","text":"You have 3 unread threads …"}}
{"kind":"event","id":"e-5","type":"turn_finished","correlationId":"r-2","payload":{"sessionId":"s-1","turnIndex":0,"reason":"reply"}}
```

## External llama-server

This package does **not** start or ship `llama.cpp`. Launch your own server, e.g.:

```bash
./llama-server -m Qwen2.5-9B-Instruct-Q4_K_M.gguf \
  --slots 4 --parallel 4 --port 8080 --cache-reuse 256
```

Then point the sidecar at it via `llama.url` in `<stateDir>/config.json` (or `atomic-agent config set …`).

## Browser prerequisites

- Install Google Chrome or Microsoft Edge (stable channel is enough). `playwright-core` attaches; browser binaries are not bundled.
- On macOS, grant Accessibility + Screen Recording permissions to your terminal / the Tauri app binary if you plan to use `os.window.focus`.
- On Linux, install `wmctrl` for window management; everything else degrades gracefully.

## License

TBD.
