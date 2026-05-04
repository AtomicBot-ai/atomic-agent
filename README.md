# atomic-agent

**An OpenClaw/Hermes-style local operator agent for `llama.cpp`.**

![atomic-agent terminal demo](assets/demo.gif)

[![Release](https://github.com/AtomicBot-ai/atomic-agent/actions/workflows/release.yml/badge.svg)](https://github.com/AtomicBot-ai/atomic-agent/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/AtomicBot-ai/atomic-agent?sort=semver&display_name=tag&logo=github)](https://github.com/AtomicBot-ai/atomic-agent/releases)
[![Version](https://img.shields.io/github/package-json/v/AtomicBot-ai/atomic-agent?logo=npm)](package.json)
[![License](https://img.shields.io/github/license/AtomicBot-ai/atomic-agent)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D25.7-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/typescript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
![Local first](https://img.shields.io/badge/local--first-runtime-7C3AED)
![llama.cpp](https://img.shields.io/badge/llama.cpp-supported-111827)
![Tauri sidecar](https://img.shields.io/badge/Tauri-sidecar-24C8DB?logo=tauri&logoColor=white)

`atomic-agent` is a local agent that can operate a real desktop: browser, files, shell, documents, notes, memory, scheduled work, approvals, and traces. Think of it in the same product category as OpenClaw Operator and Hermes Agent, but shipped as a standalone SEA binary and tuned for local models so it can squeeze the most out of them instead of relying on a hosted control plane.

**Active development:** APIs, commands, configuration, and behavior may change while the runtime is still moving quickly. Pin a release if you need a stable integration point.

## Why This Exists

OpenClaw, Hermes, and OpenCUA showed the shape: an agent should act like an operator, not just answer like a chatbot. It needs to read the browser, call tools, follow task playbooks, ask for approval before dangerous actions, and keep enough state to finish multi-step work.

Local models are good enough to operate software, but only if the runtime stops asking them to be a cloud-scale planner with an infinite context window.

The usual failure mode is predictable: every step stuffs more state into the prompt, JSON tool calls drift, browser pages become token soup, and a 7B model spends more time re-reading history than doing work.

`atomic-agent` goes the other way:

- Keep durable state outside the prompt.
- Keep the cache-hot prompt prefix byte-stable.
- Force tool calls through a GBNF grammar.
- Give the model compact browser and filesystem views.
- Load detailed procedures only when a skill is actually needed.
- Let the runtime execute independent read-only calls in parallel.

The result is an operator-agent loop that is small-model friendly, inspectable, and shippable.

## Lineage

`atomic-agent` is informed by the same family of systems:

- **OpenClaw-style desktop operation:** system browser control, compact terminal UI, persistent local profile, and a local-first product surface.
- **Hermes-style tool discipline:** structured tool calls, OpenAI-compatible HTTP shapes where useful, and multi-call batches for independent work.
- **OpenCUA-style browser state:** compact accessibility/ARIA snapshots instead of vision-heavy page screenshots for ordinary web operation.
- **Local-first constraints:** keep the model, browser, files, traces, and long-lived state on the user's machine.

It is not a fork of those projects and does not claim wire compatibility with their full runtimes. The goal is the same operator-agent class, tuned for `llama.cpp`, TypeScript, Tauri sidecars, and shippable local products.

## Built For Local Inference

`atomic-agent` is engineered around `llama.cpp` rather than treating it as a drop-in clone of a hosted API.

- **Stable prompt prefix:** persona, rules, skill catalog, tool catalog, capabilities, and instructions stay byte-stable inside a session so `cache_prompt` and `slot_id` can reuse KV-cache instead of rebuilding the same context every step.
- **Externalized state:** sessions, browser world snapshots, loaded skills, memory notes, task records, and traces live in SQLite or local files. The model receives a bounded slice, not the whole project history.
- **Grammar-constrained calls:** every inference emits a JSON array of `1..N` tool calls. Even a solo action is `[{...}]`, which avoids the first-token bias that makes smaller models fall into the wrong shape.
- **Parallel tool batches:** independent read-only calls can be emitted in the same inference and executed concurrently by resource class. Approval-gated tools and terminal replies stay solo.
- **Bounded prompt tail:** conversation, memory, skills, and world state are rendered under caps. Older turns are folded instead of letting the context grow forever.
- **Compact browser state:** browser automation uses ARIA snapshots from the installed system browser, which are far cheaper and more stable for local models than screenshots.
- **Narrow retries:** transport and parser retries are bounded and never replay already-executed tool calls.

This is runtime architecture, not prompt superstition.

## What It Can Operate

`atomic-agent` gives a local model a practical operator surface:

- **Browser:** navigate, click, type, search, inspect tabs, and read compact ARIA snapshots through `playwright-core` against Chrome, Edge, or another Chromium-family executable.
- **Host OS:** shell, filesystem reads/writes/patches, glob, grep, document extraction, archives, git inspection, process listing, clipboard, windows, notifications, and HTTP requests.
- **Documents:** extract text from PDF, DOCX, DOC, XLSX, RTF, ODT, PPTX, archives, and plain text without sending files to a remote service.
- **Skills:** local Markdown playbooks plus optional approved scripts. The stable prefix only lists skill names and descriptions; the full body is loaded with `skill.view` when the task matches.
- **Memory:** profile facts, FTS5 note recall, pointer-style memory index, and async end-of-turn reflection that writes useful facts without blocking the user-visible reply.
- **Tasks:** durable deferred turns, cron or interval schedules, webhook-triggered work, and agent self-scheduling.
- **Vision:** optional `vision.describe` tool for multimodal `llama.cpp` models with an `mmproj` projector, kept outside the text conversation transcript.

Dangerous actions go through approvals. Read-heavy inspection stays low-friction.

## Quick Start

### Install From Release

```bash
curl -fsSL https://raw.githubusercontent.com/AtomicBot-ai/atomic-agent/main/scripts/install.sh | sh
```

The installer downloads the matching archive, verifies the checksum, and installs the CLI plus runtime assets such as `grammars/`, `vendor/rg`, and native prebuilds.

Optional overrides:

```bash
ATOMIC_AGENT_VERSION=v0.1.3       # pin a release
ATOMIC_AGENT_INSTALL_DIR=/opt/bin # choose install directory
ATOMIC_AGENT_NO_PATH=1            # do not edit shell rc files
ATOMIC_AGENT_REPO=owner/repo      # install from a fork
```

### Use Managed Local Models

If you want `atomic-agent` to manage the local `llama.cpp` backend and GGUF model files:

```bash
atomic-agent models update
atomic-agent models list
atomic-agent models pull qwen-3.5-4b
atomic-agent models use qwen-3.5-4b
atomic-agent models start

atomic-agent tui --cwd /path/to/work
```

The managed path handles backend download/update, model download/remove, active model selection, and detached `llama-server` lifecycle. The current catalog focuses on Qwen and Gemma families.

### Use Your Own `llama-server`

If you already run `llama.cpp`, point the runtime at it:

```bash
export ATOMIC_AGENT_LLAMA_URL=http://127.0.0.1:8080

./llama-server -m Qwen2.5-9B-Instruct-Q4_K_M.gguf \
  --slots 4 \
  --parallel 4 \
  --port 8080 \
  --cache-reuse 256

atomic-agent tui --cwd /path/to/work
```

Configuration lives in `<stateDir>/config.json` and can be inspected or replaced with:

```bash
atomic-agent config get
atomic-agent config set '<full-json>'
```

## The Runtime Loop

This is an agent, not a helper library. One user message becomes one macro-turn:

```text
user message
  -> build compact prompt
  -> llama-server completion with GBNF grammar
  -> parse JSON tool-call array
  -> execute tool calls by resource class
  -> compress results into session state
  -> repeat until reply, finish, cancel, or max steps
```

There is no hidden planner loop inside a single inference. The runtime owns the loop, the model chooses the next tool call, and every effect is recorded as conversation turns plus trace events.

The prompt itself has two zones:

- **Stable prefix:** system persona, rules, skill catalog, tool catalog, capabilities, and tool-call instructions. This is the cache target.
- **Variable tail:** loaded skills, profile facts, memory pointers, recalled notes, world snapshot, conversation, notices, and the final response anchor. This is rebuilt every step and kept bounded.

See [PROMPT.md](PROMPT.md) for the full anatomy.

## Product Surfaces

### TUI And CLI

```bash
atomic-agent run --cwd /path/to/work
atomic-agent tui --cwd /path/to/work

atomic-agent skill list
atomic-agent skill install ./my-skill

atomic-agent task list
atomic-agent task create --message "hourly triage" --cron "0 * * * *"

atomic-agent trace list --limit 10
atomic-agent trace show <sessionId>
```

Use `run` for a simple terminal chat loop. Use `tui` for approvals, debug panes, local model management, skills, tasks, and long-lived operator sessions.

### OpenAI-Compatible HTTP

```bash
atomic-agent serve \
  --host 127.0.0.1 \
  --port 8787 \
  --cwd /path/to/work \
  --api-key "$ATOMIC_AGENT_API_KEY"
```

The main chat surface is `POST /v1/chat/completions`. One request maps to one full macro-turn: `user -> 0..N tool steps -> reply`. Atomic-specific routes expose capabilities, config, sessions, approvals, tasks, webhooks, events, and traces.

### Tauri Sidecar

The sidecar speaks newline-delimited JSON over stdio, which is easy to embed, tail, and debug from a desktop app.

```json
{"kind":"request","id":"r-1","type":"start_session","payload":{"workingDir":"/home/me"}}
{"kind":"request","id":"r-2","type":"send_message","payload":{"sessionId":"s-1","text":"Check the inbox and summarize urgent mail."}}
```

Events stream back as the turn runs:

```json
{"kind":"event","id":"e-1","type":"turn_started","correlationId":"r-2","payload":{"sessionId":"s-1","turnIndex":0}}
{"kind":"event","id":"e-2","type":"tool_call_result","correlationId":"r-2","payload":{"sessionId":"s-1","stepIndex":0,"tool":"browser.read_aria","status":"ok","summary":"url: https://mail.google.com/ ..."}}
{"kind":"event","id":"e-3","type":"assistant_reply","correlationId":"r-2","payload":{"sessionId":"s-1","text":"You have 3 urgent threads."}}
```

## Safety And Observability

Local does not mean opaque. The runtime is built to be inspected.

- **Approval gate:** shell, filesystem writes, patches, archive extraction, process kill, HTTP requests, and skill scripts are gated according to policy.
- **Append-only traces:** `run`, `tui`, and `serve` can emit NDJSON traces with prompts, completions, tool invocations, outcomes, and failure categories.
- **Prompt drift replay:** `atomic-agent trace replay <sessionId>` compares current stable-prefix hashes against recorded traces to diagnose lost KV-cache wins.
- **Failure taxonomy:** transport, grammar, model, tool, and cancellation failures are classified and propagated through events, traces, metrics, TUI, sidecar, and HTTP.
- **Local state:** sessions, memory, tasks, skills, browser profile, and traces live under `<stateDir>` by default.

Treat traces and `<stateDir>/.env` as sensitive local artifacts. Secret redaction and per-tool environment filtering are not implemented yet.

## Requirements

- Node.js for development. The release bundle is a Node SEA binary.
- A reachable `llama-server`, either managed by `atomic-agent models` or launched externally.
- Google Chrome, Microsoft Edge, or another configured Chromium-family executable. Browser binaries are not bundled.
- macOS users may need Accessibility, Screen Recording, Automation, or Reminders permissions depending on the workflow.
- Linux window-control workflows work best with `wmctrl`.
- External `git` is expected for git tools. The release bundle ships a pinned `ripgrep` for `os.fs.grep`.

## Configuration And Secrets

User-facing configuration lives in:

```text
<stateDir>/config.json
```

Useful environment variables:

- `ATOMIC_AGENT_STATE_DIR`: state, config, skills, browser profile, memory, tasks, and traces. Default: `~/.atomic-agent`.
- `ATOMIC_AGENT_LLAMA_URL`: external `llama-server` URL.
- `ATOMIC_AGENT_LLAMA_API_KEY`: optional bearer token for `llama-server`.
- `ATOMIC_AGENT_LLAMA_MAX_TOKENS`: completion cap.
- `ATOMIC_AGENT_BROWSER_CHANNEL`: `chrome`, `msedge`, or `chromium`.
- `ATOMIC_AGENT_BROWSER_EXECUTABLE_PATH`: explicit Chromium-family executable path.
- `ATOMIC_AGENT_BROWSER_CDP_URL`: attach to an already-running browser via CDP.

Secrets for skills belong in `<stateDir>/.env`, not in `config.json`:

```text
NOTION_API_KEY=ntn_xxxxxxxx
GITHUB_TOKEN=ghp_xxxxxxxx
OBSIDIAN_VAULT_PATH=/Users/me/Documents/Obsidian Vault
```

The dotenv parser is intentionally small: one `KEY=VALUE` per line, optional surrounding quotes, no interpolation, no `export`, no multiline values. Shell-exported variables win.

## Shipping Model

`atomic-agent` is designed to ship as a compact local runtime:

- Node SEA CLI binaries per target.
- Runtime assets next to the binary: GBNF grammar, pinned `ripgrep`, native prebuilds, starter skills.
- No bundled browser.
- No bundled model weights in the runtime itself.
- No forced hosted control plane.
- Tauri-friendly sidecar protocol for desktop products.

See [BUNDLING.md](BUNDLING.md) for packaging, signing, notarization, target matrix, and runtime asset details.

## Non-Goals

- Not a cloud agent platform.
- Not a full IDE coding-agent product.
- Not a giant-prompt framework.
- Not a hidden multi-agent planner.
- Not a browser or model distribution.
- Not a secret-redaction or sandbox-isolation system yet.

That restraint is deliberate. The runtime stays small, explicit, local, and embeddable.

## Development

```bash
npm install
npm run lint
npm test
npm run build
```

Core docs:

- [ARCHITECTURE.md](ARCHITECTURE.md) for runtime topology and design rationale.
- [PROMPT.md](PROMPT.md) for stable-prefix and variable-tail prompt anatomy.
- [MEMORY.md](MEMORY.md) for profile facts, notes, and reflection.
- [SKILLS.md](SKILLS.md) for the local skill format.
- [BUNDLING.md](BUNDLING.md) for release packaging.
- [AGENTS.md](AGENTS.md) for contributor invariants.

## License

[MIT](LICENSE) (c) 2026 Atomic Bot