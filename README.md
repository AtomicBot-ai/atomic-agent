<div align="center">

# atomic-agent

**Local operator agent runtime** — Tauri-friendly sidecar, debug CLI, and OpenAI-compatible HTTP surface. Drives a **KV-cache-aware** tool loop against an **external** [`llama.cpp`](https://github.com/ggerganov/llama.cpp) server (`llama-server`). No model weights or LLM binaries ship with this repo.

*Not a “coding agent” in the boxed-product sense* — think **OpenCUA-on-minimum**: control the host **browser** (Chrome/Edge), a curated **`os.*`** surface, and user **skills** (Markdown playbooks plus optional shell/Node scripts).

[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
![License](https://img.shields.io/badge/license-TBD-lightgrey)

</div>


---

See also: [ARCHITECTURE.md](ARCHITECTURE.md), [EVOLUTION.md](EVOLUTION.md), [SKILLS.md](SKILLS.md), [BUNDLING.md](BUNDLING.md)

## At a glance

| | |
| --- | --- |
| **Role** | General-purpose **host operator**: browser (Chrome/Edge), OS tools (shell, fs, clipboard, windows, notify), and user **skills** (Markdown playbooks + scripts). |
| **Not** | A bundled coding IDE or an all-in-one LLM stack — connect your own `llama-server` by URL. |
| **Embeds as** | NDJSON **sidecar** (stdin/stdout) or standalone **`atomic-agent`** CLI. |
| **Session model** | Multi-turn chat: `user → 0…N tool steps → reply` is one macro-turn; history in `SessionState.turns[]`. |

---

## Table of contents

- [Features](#features)
- [Quick start](#quick-start)
- [Configuration](#configuration)
  - [Environment](#environment)
  - [Config file](#config-file)
  - [Migration from env-only settings](#migration-from-env-only-settings)
- [CLI](#cli)
- [HTTP API](#http-api)
  - [OpenAI-compatible routes](#openai-compatible-routes)
  - [Admin routes](#admin-routes)
- [Sidecar protocol](#sidecar-protocol)
- [External llama-server](#external-llama-server)
- [Browser prerequisites](#browser-prerequisites)
- [OS tools](#os-tools)
  - [Document and archive formats](#document-and-archive-formats)
  - [HTTP tool policy](#http-tool-policy)
  - [Diff and patch](#diff-and-patch)
  - [Git tools](#git-tools)
  - [Process tools](#process-tools)
  - [Filesystem watch](#filesystem-watch)
- [Development](#development)
- [License](#license)

---

## Features

- **External LLM only** — points at an existing `llama-server`; no bundled inference.
- **Multi-turn chat** — persistent session; agent chooses `reply` vs. tools each step; `finish` ends the session.
- **Session-scoped memory** — persists conversation turns, compact known facts, loaded skill bodies, and the latest compressed browser world snapshot.
- **Cross-session memory fabric** — durable user profile rendered into every prompt (`memory.profile.*`), async reflection runner, and an FTS5-backed notes store (`memory.notes.store` / `memory.notes.recall` / `memory.notes.forget`) that is read and written only through explicit agent tools and never touches the prompt on its own.
- **Stable prompt prefix** + per-session `slot_id` for KV-cache reuse (`system` + tool catalog + capabilities + skill catalog).
- **GBNF grammar-constrained** tool calls for reliable JSON on smaller models (7–9B class).
- **Browser** — `playwright-core` over system Chrome/Edge, persistent profile; compact ARIA snapshot, `aria-ref=eN` targeting.
- **OS surface** — shell, filesystem, clipboard, window management (`osascript` / `wmctrl` / PowerShell), notifications.
- **Skills** (Hermes-style) — `skill.view`, `skill.run_script` (always approved), `skill install <path>`.
- **Approval gate** — dangerous paths only (shell, fs writes, non-http(s) nav, skill scripts, etc.).
- **NDJSON sidecar** — `send_message`, `assistant_reply`, `turn_started`, `turn_finished`, …
- **Ship shape** — per-platform Node SEA binaries (darwin arm64/x64, linux x64, win x64).

Current scope note: this repo does not yet ship a workspace / file-tree index, embeddings, or document-summary subsystem. Cross-session memory covers the user profile (auto-rendered) and agent-curated freeform notes (tool-accessed only, BM25 ranked via SQLite FTS5); file-tree retrieval remains session-scoped.

---

## Quick start

```bash
npm install
npm run build
```

Point `llama.url` in `<stateDir>/config.json` at your running `llama-server`, then:

```bash
npx atomic-agent tui --cwd /path/to/work
# or after global link / install:
atomic-agent run --cwd /path/to/work
```

See [External llama-server](#external-llama-server) for a minimal `llama-server` example.

---

## Configuration

User-facing settings live in **`<stateDir>/config.json`** (created with safe defaults on first run). Manage with `atomic-agent config …` or edit manually. Bootstrap paths and a few toggles use **environment** variables; see [`.env.example`](.env.example).

### Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `ATOMIC_AGENT_STATE_DIR` | `~/.atomic-agent` | State, config, browser profile, skills |
| `ATOMIC_AGENT_LLAMA_API_KEY` | *unset* | Optional bearer token for `llama-server` |
| `ATOMIC_AGENT_BROWSER_CHANNEL` | `chrome` | `chrome` / `msedge` / `chromium` |
| `ATOMIC_AGENT_BROWSER_HEADLESS` | `false` | Headless browser |
| `ATOMIC_AGENT_BROWSER_CDP_URL` | *unset* | Attach over CDP instead of launching |
| `ATOMIC_AGENT_SKILLS_CATALOG_BUDGET` | `512` | Token budget for skill catalog in stable prefix |

### Config file

Shape and defaults:

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
| --- | --- |
| `llama.url` | External llama-server URL |
| `log.level` | `debug` / `info` / `warn` / `error` |
| `agent.tokenBudget` | Cap for stable prefix + world snapshot + session facts (tokens). Full chat history is always sent; transcript is not counted against this cap. |
| `agent.maxSteps` | Max steps per agent loop |
| `agent.toolTimeoutMs` | Default tool timeout (ms) |
| `agent.approvalRequired` | Enable approval gate for dangerous tools |

**CLI (whole-file semantics — no dotted keys):**

```bash
atomic-agent config get

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

atomic-agent config get > /tmp/agent.json
$EDITOR /tmp/agent.json
atomic-agent config set "$(cat /tmp/agent.json)"
```

### Migration from env-only settings

> Earlier versions read `ATOMIC_AGENT_LLAMA_URL`, `ATOMIC_AGENT_LOG_LEVEL`, `ATOMIC_AGENT_TOKEN_BUDGET`, `ATOMIC_AGENT_MAX_STEPS`, `ATOMIC_AGENT_TOOL_TIMEOUT_MS`, `ATOMIC_AGENT_APPROVAL_REQUIRED` from the environment. **Those env vars are no longer read** — copy values into `config.json` or apply via `atomic-agent config set '<json>'`.

---

## CLI

```bash
# Line-at-a-time chat: user lines → runTurn; replies on stdout, tool noise on stderr.
# /quit exits; /abort cancels the current turn.
atomic-agent run --cwd /path/to/work

# Ink TUI: long-lived session, shared browser profile + llama slot.
# Enter = send, Tab = panes, Esc = abort turn (quit if idle), Ctrl+C = quit, y/n = approvals.
# `/tasks` (or Tab to the "tasks" debug pane) opens the task manager — see below.
atomic-agent tui --cwd /path/to/work

atomic-agent skill install ./my-skill
atomic-agent skill list
atomic-agent skill show check-gmail-inbox
atomic-agent skill uninstall check-gmail-inbox

atomic-agent config get
atomic-agent config set '{"version":1, ...}'

atomic-agent serve --host 127.0.0.1 --port 8787 --cwd /path/to/work
```

Skill format: **[SKILLS.md](SKILLS.md)**.

### TUI Tasks tab

`atomic-agent tui` exposes a dedicated **Tasks** tab in the debug pane that lists every row in `<stateDir>/tasks.sqlite`, with a detail view, a multi-step create form, and a firings feed. Reach it by typing `/tasks` or by cycling debug tabs with `Tab`. Auto-refresh kicks in at 5s intervals on first entry — toggle with `a`, refresh manually with `r`.

List-mode hotkeys:

- `j` / `k` (or arrows) — move cursor through the filtered list.
- `Enter` — open task detail.
- `n` or `/task new` — open the create form (blocks editor input until dismissed).
- `c` — cancel highlighted task. Recurring tasks prompt `y/n`; pending one-shots skip the modal.
- `R` — run one attempt now (`TaskRunner.runOne`).
- `f` — cycle status filter (`all → pending → running → terminal`).
- `a` — toggle auto-refresh.

Detail view shows the full `TaskRecord` plus the last ~20 observed firings (`timestamp | reason | stepCount | durationMs`). Press `o` to jump to the task's session in the main chat pane, `R` to run now, `c` to cancel, `Esc` to go back.

Create form walks through `kind` (`at` / `cron` / `interval`), a schedule expression with live validation (including the next 5 firings for cron/interval), optional IANA tz, and the user message. Tab/Shift+Tab cycles focus; Left/Right cycles the kind; Ctrl+Enter submits from any field.

Slash shortcuts also work without the tab open: `/task cancel <id>`, `/task run <id>`. All state mutations route through the same `TaskStore` / `TaskRunner` as the CLI and HTTP surfaces — there is no TUI-local task cache.

### Debugging with traces

Every `atomic-agent run` / `tui` / `serve` invocation writes an append-only NDJSON trace to `<stateDir>/traces/<sessionId>.ndjson`. Sidecar mode is off by default; hosts opt in via `telemetry.trace.enabled`.

```bash
atomic-agent trace list --limit 10
atomic-agent trace show <sessionId>            # pretty chronology
atomic-agent trace show <sessionId> --raw      # include full prompt tails / completions
atomic-agent trace show <sessionId> --step 2   # zoom to a single step
atomic-agent trace export <sessionId> --format json > session.json
atomic-agent trace replay <sessionId>          # detect stable-prefix drift
```

`trace replay` rebuilds the stable prompt prefix from the current runtime (tools / capabilities / skills / persona) and compares its salted hash to the one recorded at runtime — drift means the upper prompt changed since recording, which explains lost `cache_prompt` hits.

Treat trace files as sensitive: secret redaction is not applied yet. Tune retention via `telemetry.trace.maxBytesPerSession` (default 10 MiB) and `telemetry.trace.dir`.

### Durable tasks

`atomic-agent task` manages a small durable queue of deferred `runTurn` submissions in `<stateDir>/tasks.sqlite`. Drains are driven either by the background **scheduler** (see below) or explicitly (CLI / HTTP `POST /api/tasks/drain`) / implicitly on `create()` when `tasks.runOnCreate=true` (default). Retries with exponential backoff (`tasks.maxAttempts`, `tasks.backoffInitialMs`, `tasks.backoffMaxMs`) classify failures via the same taxonomy as the agent loop — `transport`/`model` retry, `grammar`/`tool` go straight to `blocked`.

```bash
atomic-agent task list --status pending
atomic-agent task show <taskId>
atomic-agent task create [--session <id>] --message "tidy inbox" [--max-attempts 3]

# One-shot at an absolute time (Unix ms)
atomic-agent task create --message "send morning brief" --at 1776124800000

# Recurring — cron (ephemeral session allocated eagerly, reused on every firing)
atomic-agent task create --message "hourly triage" --cron "0 * * * *" --tz "Europe/Berlin"

# Recurring — fixed interval (seconds)
atomic-agent task create --message "heartbeat" --every 300

atomic-agent task cancel <taskId>
atomic-agent task run <taskId>                  # one attempt
atomic-agent task run --all-pending [--session <sessionId>]   # manual drain
atomic-agent task tick                          # one scheduler pump for ops debugging
```

The same surface is exposed over HTTP: `POST/GET /api/tasks`, `GET/DELETE /api/tasks/:id`, `POST /api/tasks/:id/run`, `POST /api/tasks/drain`. All endpoints return 404 when `tasks.enabled=false`.

### Background autonomy

The runtime runs a single in-process `Scheduler` (one `setInterval`) that polls due tasks via a partial SQLite index and executes them through the same per-session FIFO contract as user turns. Three extension points open up on top of this primitive:

**1. Schedule any task.** Besides the CLI above, recurring tasks own **one persistent session for their full lifetime** — all firings accumulate into the same `SessionState.turns[]`. One-shot scheduled tasks get a fresh ephemeral session on first attempt. Session auto-recreates (with a warning + `agent.tasks.session_recreated` metric) if deleted between firings.

**2. Webhook ingress.** Declare a webhook in `<stateDir>/config.json` — `POST /api/webhooks/<name>` then materialises each hit as a task:

```json
{
  "webhooks": {
    "github-push": {
      "userMessageTemplate": "GitHub pushed {{body.commits.length}} commits to {{body.ref}} — summarise them.",
      "secret": "optional-x-webhook-secret-value",
      "sessionMode": "persistent"
    }
  }
}
```

Then:

```bash
curl -X POST http://127.0.0.1:8787/api/webhooks/github-push \
  -H "Authorization: Bearer $ATOMIC_AGENT_API_KEY" \
  -H "x-webhook-secret: optional-x-webhook-secret-value" \
  -H "Content-Type: application/json" \
  --data '{"ref":"refs/heads/main","commits":[{"id":"abc"},{"id":"def"}]}'
# => 202 Accepted { "taskId": "…" }
```

`sessionMode` options: `ephemeral` (fresh session per hit — default for one-shot), `persistent` (one session reused across every hit of this webhook — default when `schedule` is set, id stored in `<stateDir>/webhook-sessions.json`), `named` (requires explicit `sessionId`).

**3. Agent self-scheduling.** When `tasks.agentToolsEnabled=true` (default), the model can call five tools from inside a turn: `tasks.schedule` (one-shot, inherits the current session by default), `tasks.cron` (recurring, always a fresh persistent session), `tasks.list`, `tasks.cancel`, `tasks.show`.

Flip `tasks.schedulerEnabled=false` to disable the background pump while keeping manual drains working; flip `tasks.enabled=false` to disable everything (scheduler + webhook routes + agent tools all respect it).

See [ARCHITECTURE.md §4.17](ARCHITECTURE.md) and [AGENTS.md §Background autonomy](AGENTS.md) for the full contract.

---

## HTTP API

`atomic-agent serve` exposes a small HTTP surface on the same `createAgentRuntime()` as `run` / `tui`. **One HTTP request = one macro-turn** (`user → 0…N tool steps → reply`). Loopback-first; uses Node’s built-in `http` — no extra server deps.

```bash
atomic-agent serve \
  --host 127.0.0.1 \
  --port 8787 \
  --cwd /path/to/work \
  --api-key "$ATOMIC_AGENT_API_KEY"
```

Auth is optional. With `--api-key` / `ATOMIC_AGENT_API_KEY`, routes expect `Authorization: Bearer <key>`; **`/health`** and **`/v1/models`** stay public for SDK probes.

### OpenAI-compatible routes

- **`POST /v1/chat/completions`** — Chat Completions. With `stream: true`, SSE includes `tool_progress` per tool step, then normal content deltas, `usage`, `finish_reason`, and `data: [DONE]`.
- **`POST /v1/chat/completions/{id}/cancel`** — Abort a streaming completion by id.
- **`GET /v1/models`** — Single synthetic `atomic-agent` model entry.

**Sessions (Hermes-style “Option A”):** `X-Atomic-Session-Id` or body `session_id` resumes; otherwise id `api-<sha256:16>` from `(system, firstUserMessage)`. Only the **last** user message in the body starts the new turn — history lives in `SessionState.turns[]`.

### Admin routes

When `--api-key` is set, these require auth (except as noted for health/models above).

| Route | Purpose |
| --- | --- |
| `GET /health` | Liveness + llama reachability |
| `GET /api/capabilities` | Host caps, catalogs, paths, llama config |
| `GET /api/config` | Read user config |
| `PATCH /api/config` | Merge-write user config |
| `GET /api/skills` | List installed skills |
| `GET /api/skills/{name}` | Manifest + `SKILL.md` body |
| `POST /api/skills/install` | `{ sourcePath, source?: "global"\|"project", force? }` |
| `POST /api/skills/uninstall` | `{ name, source?: "global"\|"project" }` |
| `GET /api/sessions` | Recent sessions (`?limit=` ≤ 200) |
| `GET /api/sessions/{id}` | Full `SessionState` |
| `DELETE /api/sessions/{id}` | Purge (idempotent) |
| `POST /api/approval/resolve` | `{ approvalId, decision: "allow-once"\|"deny", reason? }` |
| `GET /api/events` | SSE: pending approvals |

---

## Sidecar protocol

Newline-delimited JSON on **stdin** → **stdout**. Schemas: `src/sidecar/sidecar-events.ts` (re-exported from package root).

**Requests:**

```json
{"kind":"request","id":"r-1","type":"start_session","payload":{"workingDir":"/home/me"}}
{"kind":"request","id":"r-2","type":"send_message","payload":{"sessionId":"s-1","text":"hi, can you check Gmail?"}}
```

**Example events (one turn):**

```json
{"kind":"event","id":"e-1","type":"user_message","correlationId":"r-2","payload":{"sessionId":"s-1","text":"hi, can you check Gmail?"}}
{"kind":"event","id":"e-2","type":"turn_started","correlationId":"r-2","payload":{"sessionId":"s-1","turnIndex":0}}
{"kind":"event","id":"e-3","type":"tool_call_result","correlationId":"r-2","payload":{"sessionId":"s-1","stepIndex":0,"tool":"browser.read_aria","status":"ok","summary":"url: https://mail.google.com/ …"}}
{"kind":"event","id":"e-4","type":"assistant_reply","correlationId":"r-2","payload":{"sessionId":"s-1","text":"You have 3 unread threads …"}}
{"kind":"event","id":"e-5","type":"turn_finished","correlationId":"r-2","payload":{"sessionId":"s-1","turnIndex":0,"reason":"reply"}}
```

---

## External llama-server

This package **does not** start or ship `llama.cpp`. Run your own server, e.g.:

```bash
./llama-server -m Qwen2.5-9B-Instruct-Q4_K_M.gguf \
  --slots 4 --parallel 4 --port 8080 --cache-reuse 256
```

Set `llama.url` in `<stateDir>/config.json` (or `atomic-agent config set …`).

---

## Browser prerequisites

- Install **Google Chrome** or **Microsoft Edge** (stable). `playwright-core` attaches; browser binaries are not bundled.
- **macOS:** Accessibility + Screen Recording for the terminal or Tauri host if you use `os.window.focus`.
- **Linux:** `wmctrl` for window management; other features degrade gracefully without it.

---

## OS tools

| Tool | Description | Approval |
| --- | --- | --- |
| `os.shell.run` | Shell in cwd, timeout + output cap + abort | yes |
| `os.fs.read` | UTF-8 read; `offset`/`limit`, optional `lineNumbers` | no |
| `os.fs.write` | Write / append | yes |
| `os.fs.list` | Non-recursive listing | no |
| `os.fs.glob` | `*`, `**`, `?`, `{a,b}` — pure Node | no |
| `os.fs.grep` | Bundled `ripgrep`; `content` / `files_with_matches` / `count` | no |
| `os.fs.edit` | Atomic string replace + diff preview | yes |
| `os.fs.read_document` | PDF, DOCX, legacy DOC, XLSX, RTF, ODT, PPTX, text | no |
| `os.fs.archive.list` | Zip/tar/tgz/gz listing | no |
| `os.fs.archive.read_entry` | Single entry as UTF-8 or base64 | no |
| `os.fs.archive.extract` | Extract with zip-slip / bomb guards | yes |
| `os.fs.hash` | md5 / sha1 / sha256 / sha512 (streaming) | no |
| `os.fs.diff` | Unified diff (paths or strings) | no |
| `os.fs.patch` | Apply unified diff; dry-run default; live needs approval | configurable |
| `os.fs.watch` | `chokidar` one-shot watch (≤ 60 s) | no |
| `os.git.*` | `status`, `log`, `diff`, `show`, `blame`, `branch` (read-only) | no |
| `os.proc.list` | Process snapshot (`ps` / `tasklist`) | no |
| `os.proc.kill` | Signal by PID | yes |
| `os.http.request` | System `curl`; allowlist + `config.http` | configurable |
| `os.clipboard.read` / `write` | Clipboard I/O | no |
| `os.window.list` / `focus` | List / focus windows | no |
| `os.notify` | Native notification | no |

**Ripgrep:** bundle ships `vendor/rg[.exe]`; dev may use `@vscode/ripgrep` or `rg` on `PATH`. Override: `ATOMIC_AGENT_RG_PATH=/path/to/rg`.

### Document and archive formats

`os.fs.read_document` uses pure-JS backends — tuned for local LLMs (`#` / `##`, `--- page N ---`, `## Sheet: …`, etc.). Metadata in `details` (`pageCount`, `sheetCount`, …).

| Extension | Backend | Notes |
| --- | --- | --- |
| `.pdf` | `pdfjs-dist` | text layer; `pagesFrom` / `pagesTo` / `maxPages` |
| `.docx` | `mammoth` | `includeTables=false` → raw text |
| `.doc` | `word-extractor` | temp file internally |
| `.xlsx` | `exceljs` | `sheets` by name or 1-based index |
| `.rtf` | custom parser | `\uNNNN`, `\'hh`, ignorable groups |
| `.odt` | `jszip` + `fast-xml-parser` | `content.xml` |
| `.pptx` | `jszip` + `fast-xml-parser` | per-slide markers |
| `.txt` / `.md` / `.log` / `.csv` / `.json` / `.html` / `.xml` / `.yaml` | pass-through | UTF-8, latin1 fallback |

`format: "plain"` overrides detection when extension is unknown. Defaults: `maxBytes = 5 MB`, `maxPages = 50`.

**Archives** (`os.fs.archive.*`):

| Extension | Backend | Notes |
| --- | --- | --- |
| `.zip` | `jszip` | symlinks opt-in `followSymlinks` |
| `.tar` | `tar-stream` | streaming; hard-links |
| `.tar.gz` / `.tgz` | `tar-stream` + `zlib` | gunzip |
| `.gz` | `zlib` | single member; synthetic name |

`sanitizeEntryPath` blocks zip-slip. `ExtractBudget` defaults: **100 MB total / 10 MB per file / 10 000 entries** — skips with reasons in `details.skippedEntries` instead of hard-failing.

### HTTP tool policy

`os.http.request` uses the system **`curl`**. Configure under `config.http`:

```json
{
  "http": {
    "enabled": true,
    "approvalMode": "writes",
    "hostAllowlist": null,
    "maxResponseBytes": 1048576,
    "defaultTimeoutMs": 30000
  }
}
```

| Field | Meaning |
| --- | --- |
| `enabled` | `false` disables the tool |
| `approvalMode` | `never` / `writes` (POST prompts) / `always` |
| `hostAllowlist` | `null` = any host; else hostnames + `*.wildcards` |
| `maxResponseBytes` | Body cap + truncation flag |
| `defaultTimeoutMs` | Fallback if the model omits `timeoutMs` |

### Diff and patch

`os.fs.diff` — unified diff from two paths or two strings. `os.fs.patch`: **`apply=false`** (default) parses and previews per hunk without writes; **`apply=true`** needs approval and **refuses partial apply**. Options align with `patch(1)` (`fuzzFactor`, `stripComponents`, default strip `1`).

### Git tools

Read-only; `GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`. Each tool returns `output` plus structured `details` from porcelain / `for-each-ref`.

### Process tools

`os.proc.list` — normalised `{ pid, ppid, user, cpuPercent, memPercent, command }` from POSIX `ps` or Windows `tasklist`. `os.proc.kill` — always approved; preview includes image + user. Signals: `SIGTERM` (default), `SIGKILL`, `SIGINT`, `SIGHUP`.

### Filesystem watch

`chokidar`, one-shot, blocking. Default timeout **5 s**, max **60 s**. `recursive=true` for deep watch. Events `{ kind, path, timestamp }` relative to root; `stopAfterFirst`, `events: ["unlink"]`, etc. Watcher closed on abort/timeout to avoid handle leaks.

---

## Development

```bash
npm install
npm run lint    # tsc --noEmit
npm test        # vitest run
npm run build   # compile to dist/
```

For automated contributors (invariants, module map, layout rules): **[AGENTS.md](AGENTS.md)**.

---

## License

TBD.
