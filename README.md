

# atomic-agent

**Local operator agent runtime for real desktop automation.**

Embed it in a Tauri app, run it in the terminal, or expose it behind an OpenAI-compatible API. `atomic-agent` gives local models a disciplined runtime for **browser control**, **OS actions**, **skills**, **durable memory**, **scheduled work**, and **auditable execution** without turning your product into a giant hosted stack.

[Node.js](https://nodejs.org/)
[TypeScript](https://www.typescriptlang.org/)
[License: MIT](LICENSE)



**Active development:** this project is still in active development. Nothing is frozen—APIs, configuration, CLI, and behavior may change at any time. Pin a release if you need something stable.

`atomic-agent` is built for teams that want the power of an operator agent, but want to keep the stack local, inspectable, and shippable:

- **Local-first by design**: your browser, your files, your machine, your `llama.cpp` server.
- **Small-model friendly**: stable prompt prefix, KV-cache reuse, grammar-constrained tool calls, bounded prompt growth.
- **More than chat**: browser automation, OS tools, user-authored skills, background tasks, webhooks, and traces.
- **Easy to embed**: Tauri sidecar over NDJSON, standalone CLI/TUI, or OpenAI-compatible HTTP surface.
- **Safer to ship**: dangerous actions go through approvals, state lives in SQLite, traces stay local, and runtime behavior is explicit.

See also: [ARCHITECTURE.md](ARCHITECTURE.md), [MEMORY.md](MEMORY.md), [SKILLS.md](SKILLS.md), [EVOLUTION.md](EVOLUTION.md), [BUNDLING.md](BUNDLING.md)

## Why `atomic-agent`

Most agent stacks optimize for "big cloud model, giant prompt, vague tools". `atomic-agent` goes the other direction:

- It keeps **state outside the model** and sends only a compact, structured slice each step.
- It treats the model as a **tool-choosing operator**, not a magic black box.
- It makes local inference practical with **KV-cache-aware prompt design** and **GBNF-constrained tool decoding**.
- It gives you a runtime you can actually productize: **sidecar protocol, HTTP API, approvals, tasks, memory, and traces**.

If you want a local operator agent that can be embedded into a desktop app, automate the browser and host OS, and keep working later through scheduled turns, this is the shape.

## What You Get

- **Browser operator surface** via `playwright-core` over installed Chrome or Edge, using compact ARIA snapshots that are cheap for local models.
- **OS tools** for shell, filesystem, grep, document extraction, archives, clipboard, windows, notifications, HTTP, git inspection, process listing, and more.
- **Optional image understanding** through a `vision.describe` tool that delegates to a multimodal `llama.cpp` model with a loaded `mmproj` projector — opt-in, disabled cleanly when the active model is text-only.
- **User skills**: Markdown playbooks plus optional scripts that can be installed globally or per project.
- **Durable session memory** in SQLite, plus cross-session memory with profile facts, notes, and async reflection.
- **Background autonomy** through durable tasks, cron/interval scheduling, webhook ingress, and agent self-scheduling.
- **Multiple product surfaces**: CLI, TUI, Tauri-friendly sidecar, and OpenAI-compatible HTTP.
- **Operational visibility** through append-only traces, metrics, explicit failure categories, and replay tooling.
- **Portable ship shape** with Node SEA bundles and pinned runtime assets such as `ripgrep`.

## Great Fit For

- A **Tauri desktop app** that needs a reliable local sidecar.
- A **local operations assistant** that can drive browser + shell + files.
- A **workflow helper** that resumes work from schedules or webhooks.
- A **developer or operator console** exposed through an OpenAI-compatible `/v1/chat/completions` endpoint.

## Quick Start

### Fastest path: managed local models

If you want `atomic-agent` to manage the local `llama.cpp` backend and GGUF models for you:

```bash
npm install
npm run build

atomic-agent models update
atomic-agent models list
atomic-agent models pull qwen-3.5-4b
atomic-agent models use qwen-3.5-4b
atomic-agent models start

atomic-agent tui --cwd /path/to/work
```

The `models` command manages:

- backend download/update
- local GGUF model download/remove
- active model selection
- detached `llama-server` daemon lifecycle

Current model catalog focuses on **Qwen** and **Gemma** families.

### External `llama-server`

If you already run your own `llama.cpp` server, point the config at it and keep `atomic-agent` in external mode.

Example server:

```bash
./llama-server -m Qwen2.5-9B-Instruct-Q4_K_M.gguf \
  --slots 4 \
  --parallel 4 \
  --port 8080 \
  --cache-reuse 256
```

Then configure:

```json
{
  "version": 6,
  "localModels": {
    "url": "http://127.0.0.1:8080",
    "mode": "external",
    "managed": {
      "modelId": "qwen-3.5-4b",
      "port": 19091,
      "dataDirOverride": null,
      "autoUpdate": false
    }
  },
  "log": {
    "level": "info"
  },
  "agent": {
    "tokenBudget": 3000,
    "maxSteps": 25,
    "toolTimeoutMs": 60000,
    "approvalRequired": true,
    "conversationMaxTokens": 32000,
    "worldSnapshotMaxTokens": 8000
  },
  "vision": {
    "enabled": true,
    "autoDetect": true,
    "maxImageBytes": 8388608,
    "maxImagesPerCall": 4
  }
}
```

> Older `config.json` files (`version: 5` and earlier) are migrated transparently on the next bootstrap — the runtime preserves your existing values and fills in newly-added blocks (such as `vision`) from defaults.

Manage config with:

```bash
atomic-agent config get
atomic-agent config set '<full-json>'
```

## Why It Works Well With Local Models

`atomic-agent` is intentionally engineered around the failure modes of 7B-14B local models:

- **Stable prompt prefix** keeps the expensive part of the prompt byte-stable inside a session.
- **Per-session slot reuse** lets `llama-server` hit KV cache instead of rebuilding context every step.
- **Grammar-constrained tool calls** keep structured JSON reliable on smaller models.
- **Bounded prompt tail** prevents world state, conversation, and memory from growing without limit.
- **Externalized state** means sessions, world snapshots, loaded skills, notes, and tasks live outside the model.
- **Narrow retry policy** improves resilience without replaying already-executed tools.

This is not "just prompt engineering". It is a runtime architecture tuned for local inference.

## Surfaces

### CLI and TUI

```bash
atomic-agent run --cwd /path/to/work
atomic-agent tui --cwd /path/to/work

atomic-agent skill install ./my-skill
atomic-agent skill list
atomic-agent skill show check-gmail-inbox

atomic-agent task list
atomic-agent task create --message "hourly triage" --cron "0 * * * *"

atomic-agent trace list --limit 10
atomic-agent trace show <sessionId>
```

Highlights:

- `run` is a simple line-at-a-time chat loop.
- `tui` is a long-lived terminal UI with approvals, debug panes, and a dedicated Tasks tab.
- `task` manages durable queued turns.
- `trace` lets you inspect and replay prompt-state drift.
- `models` manages the local backend and downloaded GGUF models.

### OpenAI-compatible HTTP API

```bash
atomic-agent serve \
  --host 127.0.0.1 \
  --port 8787 \
  --cwd /path/to/work \
  --api-key "$ATOMIC_AGENT_API_KEY"
```

Main routes:

- `POST /v1/chat/completions`
- `POST /v1/chat/completions/{id}/cancel`
- `GET /v1/models`
- `GET /health`
- `GET /api/capabilities`
- `GET /api/config`
- `PATCH /api/config`
- `GET /api/skills`
- `GET /api/sessions`
- `POST /api/approval/resolve`
- `GET /api/events`

One HTTP request maps to one full macro-turn: `user -> 0..N tool steps -> reply`.

### Tauri-friendly sidecar

The sidecar speaks newline-delimited JSON over stdio, which keeps integration simple and easy to debug.

Request example:

```json
{"kind":"request","id":"r-1","type":"start_session","payload":{"workingDir":"/home/me"}}
{"kind":"request","id":"r-2","type":"send_message","payload":{"sessionId":"s-1","text":"Check the inbox and summarise urgent mail."}}
```

Event example:

```json
{"kind":"event","id":"e-1","type":"turn_started","correlationId":"r-2","payload":{"sessionId":"s-1","turnIndex":0}}
{"kind":"event","id":"e-2","type":"tool_call_result","correlationId":"r-2","payload":{"sessionId":"s-1","stepIndex":0,"tool":"browser.read_aria","status":"ok","summary":"url: https://mail.google.com/ ..."}}
{"kind":"event","id":"e-3","type":"assistant_reply","correlationId":"r-2","payload":{"sessionId":"s-1","text":"You have 3 urgent threads."}}
```

## Capabilities

### Browser

- Uses `playwright-core` with the **system browser**, not a bundled Chromium.
- Works with **Chrome**, **Edge**, and Chromium-family executables.
- Reads compact **ARIA snapshots** so local models can navigate pages without vision-heavy prompts.
- Keeps a **persistent browser profile**, which is exactly what operator workflows need.

### Vision (multimodal)

Optional image understanding for local multimodal models such as **Gemma-4** (`gemma4v` projector) and **Qwen3-VL** (`qwen3vl_merger` projector). Vision is wired through a single tool — `vision.describe` — and stays out of the conversation transcript.

- **Single tool surface**: `vision.describe { prompt, path? | paths? }` reads images from disk (`png`, `jpg`, `jpeg`, `webp`, `gif`) and returns a description as a normal tool result. The model's chat history never carries image bytes.
- **Provider-based**: speaks the OpenAI-compatible `/v1/chat/completions` endpoint with `image_url` content blocks, so it works against any `llama.cpp` build that loads an `mmproj` projector. Future non-llama.cpp adapters can plug into the same `LlmProvider` interface.
- **Auto-detection**: capability follows the live `/props` from `llama-server`. When the active model is text-only, the tool surfaces a clean error and the descriptor stays in the prompt only when a provider is wired.
- **Managed-mode pull**: when `config.vision.enabled && model.supportsVision`, the TUI and CLI pull both the GGUF and the `mmproj` projector by default (toggle with the `g` hotkey for GGUF-only, or pull `mmproj` separately later).
- **Safe daemon launch**: the managed `llama-server` start path automatically appends `--mmproj` and a tuned image-token / batch budget (`--image-min-tokens 560 --image-max-tokens 560 --ubatch-size 1024 --batch-size 2048`) — without those flags Gemma-4 and Qwen-VL hallucinate at the default ~70-image-token budget.
- **Bounded by config**: `vision.maxImagesPerCall` (default `4`) and `vision.maxImageBytes` (default `8 MiB`) cap each call.

Vision is opt-in. Set `vision.enabled = false` to skip provider construction and tool registration entirely.

### OS tools

Selected built-in tools:

- `os.shell.run`
- `os.fs.read`, `write`, `list`, `glob`, `grep`, `edit`, `diff`, `patch`, `watch`
- `os.fs.read_document` for PDF, DOCX, DOC, XLSX, RTF, ODT, PPTX, and plain text
- `os.fs.archive.list`, `read_entry`, `extract`
- `os.git.status`, `log`, `diff`, `show`, `blame`, `branch`
- `os.proc.list`, `os.proc.kill`
- `os.http.request`
- `os.clipboard.read`, `os.clipboard.write`
- `os.window.list`, `os.window.focus`
- `os.notify`

Dangerous actions are gated behind approval. Read-heavy and inspection-heavy actions are available without friction.

### Skills

Skills are local playbooks made of:

- a required `SKILL.md`
- optional scripts under `scripts/`
- optional static references under `references/`

Why skills matter:

- they let humans encode reliable procedures once
- they keep prompts small by loading only what is needed
- they make the runtime more productizable than free-form prompting alone

See [SKILLS.md](SKILLS.md) for the full format.

## Memory, Tasks, And Autonomy

### Cross-session memory

`atomic-agent` has a memory fabric built for practical local use:

- **Profile facts** for durable user/operator preferences
- **FTS5 notes memory** for searchable freeform observations
- **Async reflection** that writes useful memories after a turn
- **Prompt injection only where it helps**: hot facts and top recalled notes enter the tail, the full corpus does not

This keeps memory useful without blowing up the stable prompt prefix. Details live in [MEMORY.md](MEMORY.md).

### Durable tasks

Tasks turn the agent from a purely reactive chat loop into something that can resume work later:

```bash
atomic-agent task create --message "send morning brief" --at 1776124800000
atomic-agent task create --message "hourly triage" --cron "0 * * * *" --tz "Europe/Berlin"
atomic-agent task create --message "heartbeat" --every 300

atomic-agent task list
atomic-agent task show <taskId>
atomic-agent task run <taskId>
atomic-agent task cancel <taskId>
```

Each task is a durable deferred `runTurn`, backed by SQLite, retries, and explicit status transitions.

### Webhooks and self-scheduling

You can turn external events into agent work with `POST /api/webhooks/:name`, and the agent itself can schedule follow-up work through `tasks.schedule` and `tasks.cron`.

This makes it easy to build:

- reminders
- periodic triage
- inbox or dashboard sweeps
- webhook-triggered summaries
- recurring operator routines

## Tracing And Debugging

Every `run`, `tui`, and `serve` session can emit append-only NDJSON traces:

```bash
atomic-agent trace list --limit 10
atomic-agent trace show <sessionId>
atomic-agent trace show <sessionId> --raw
atomic-agent trace replay <sessionId>
```

Traces capture:

- turns and steps
- prompt hashes and prompt tails
- completion content
- tool invocations and outcomes
- failure categories

`trace replay` helps explain lost KV-cache wins by detecting drift in the stable prompt prefix.

Treat traces as sensitive local artifacts: secret redaction is not applied yet.

## Configuration

User-facing configuration lives in:

- `<stateDir>/config.json`

Important environment variables:


| Variable                               | Default           | Purpose                                        |
| -------------------------------------- | ----------------- | ---------------------------------------------- |
| `ATOMIC_AGENT_STATE_DIR`               | `~/.atomic-agent` | State, config, browser profile, skills, traces |
| `ATOMIC_AGENT_LLAMA_API_KEY`           | unset             | Optional bearer token for `llama-server`       |
| `ATOMIC_AGENT_LLAMA_MAX_TOKENS`        | `4096`            | Completion cap (`n_predict`)                   |
| `ATOMIC_AGENT_BROWSER_CHANNEL`         | `chrome`          | `chrome`, `msedge`, or `chromium`              |
| `ATOMIC_AGENT_BROWSER_EXECUTABLE_PATH` | unset             | Explicit Chromium-family executable            |
| `ATOMIC_AGENT_BROWSER_HEADLESS`        | `0`               | Headless browser mode                          |
| `ATOMIC_AGENT_BROWSER_NO_SANDBOX`      | `0`               | Pass `--no-sandbox` when needed                |
| `ATOMIC_AGENT_BROWSER_CDP_URL`         | unset             | Attach to an already-running browser via CDP   |


The config CLI uses **whole-file semantics**. Pass a full JSON document, not dotted patches.

## Browser And Host Requirements

- Install **Google Chrome** or **Microsoft Edge**. Browser binaries are not bundled.
- `atomic-agent` uses `playwright-core` and attaches to the installed system browser.
- On **macOS**, window-management workflows may need Accessibility and Screen Recording permissions.
- On **Linux**, `wmctrl` improves window-control features.
- The bundle ships a pinned `ripgrep` for `os.fs.grep`, but external `git` is still expected on the host.

## Shipping Model

`atomic-agent` is designed to ship as a compact runtime, not a monolith:

- Node SEA **CLI** single-file executables per target
- local runtime assets such as `grammars/tool-call.gbnf` and pinned `ripgrep`
- no bundled browser
- no bundled starter skills
- no forced hosted control plane

See [BUNDLING.md](BUNDLING.md) for the target matrix, CI signing, and packaging details.

### Install CLI from a GitHub release (macOS / Linux)

Install the latest signed+notarized build straight from GitHub Releases:

```bash
curl -fsSL https://raw.githubusercontent.com/AtomicBot-ai/atomic-agent/main/scripts/install.sh | sh
```

The installer detects your OS/arch, downloads `atomic-agent-<slug>.tar.gz`, verifies the `.sha256`, and lays out the binary plus `grammars/`, `vendor/` (ripgrep), and `prebuilds/` under `$HOME/.local/bin`. It also appends `$HOME/.local/bin` to your shell's rc file (`~/.zshrc`, `~/.bash_profile` on macOS / `~/.bashrc` on Linux, `~/.config/fish/config.fish`, or `~/.profile`) if it is not already on `PATH` — open a new shell or `source` the file afterwards.

Optional environment overrides:

- `ATOMIC_AGENT_VERSION=v0.1.3` — pin a specific tag instead of `latest`.
- `ATOMIC_AGENT_INSTALL_DIR=/custom/bin` — install somewhere other than `$HOME/.local/bin`.
- `ATOMIC_AGENT_NO_PATH=1` — skip the rc-file PATH update (print a hint instead).
- `ATOMIC_AGENT_REPO=owner/atomic-agent` — install from a fork.

On **macOS**, the first launch may trigger a **network** Gatekeeper check for a notarized-but-unstapled binary; grant **Accessibility** and **Screen Recording** for window automation. See [BUNDLING.md](BUNDLING.md) for the target matrix and packaging details.

## Explicit Non-goals

- It is **not** a bundled cloud agent platform.
- It is **not** a full IDE-style coding agent product.
- It does **not** rely on giant prompts or hidden planner loops.
- It does **not** bundle Chrome, Playwright browser binaries, or remote SaaS orchestration.

That restraint is deliberate. The runtime stays small, explicit, and embeddable.

## Development

```bash
npm install
npm run lint
npm test
npm run build
```

Repository docs:

- [ARCHITECTURE.md](ARCHITECTURE.md) for the full system design
- [MEMORY.md](MEMORY.md) for cross-session memory
- [SKILLS.md](SKILLS.md) for the skill format
- [EVOLUTION.md](EVOLUTION.md) for design evolution
- [AGENTS.md](AGENTS.md) for contributor rules and invariants

## License

[MIT](LICENSE) © 2026 Atomic Bot