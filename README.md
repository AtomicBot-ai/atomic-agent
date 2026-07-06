# atomic-agent

**Local First Ai Agent. Optimised for Local Ai Models. Turboquant for long context window. Proper tools calling. No cloud. Fully Private. Runs on your local device even offline**

![atomic-agent terminal demo](assets/demo.gif)

[![Release](https://github.com/AtomicBot-ai/atomic-agent/actions/workflows/release.yml/badge.svg)](https://github.com/AtomicBot-ai/atomic-agent/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/AtomicBot-ai/atomic-agent?sort=semver&display_name=tag&logo=github)](https://github.com/AtomicBot-ai/atomic-agent/releases)
[![Version](https://img.shields.io/github/package-json/v/AtomicBot-ai/atomic-agent?logo=npm)](package.json)
[![License](https://img.shields.io/github/license/AtomicBot-ai/atomic-agent)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D25.7-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/typescript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
![Local first](https://img.shields.io/badge/local--first-agent-7C3AED)
![Private by default](https://img.shields.io/badge/private--by--default-local-059669)
![No per-token fees](https://img.shields.io/badge/no%20per--token%20fees-llama.cpp-111827)
![llama.cpp](https://img.shields.io/badge/llama.cpp-supported-111827)
![Tauri sidecar](https://img.shields.io/badge/Tauri-sidecar-24C8DB?logo=tauri&logoColor=white)

`atomic-agent` is built for real desktop work, not chat-window demos. It can browse, read and edit files, run approved commands, inspect documents, remember useful context, schedule follow-ups, drive tools through MCP, and embed into apps through HTTP or a Tauri sidecar.

The promise is simple: keep the agent control loop and state local, use `llama.cpp` first, and make small quantized models useful for long, multi-step desktop work on consumer hardware. Under the hood, `atomic-agent` is a compact local runtime for prompts, tool calls, approvals, state, traces, and failure boundaries. On the surface, it is a general-purpose AI agent you can run, inspect, interrupt, and embed.

**Developer Preview / Active Development:** APIs, commands, config, and behavior are still moving. Expect sharp edges, and pin a release if you need a stable integration point.

**Platform availability:** current releases are available for macOS and Linux x64. Windows builds are coming soon.

## Benchmarks

![GAIA Level 1 benchmark — atomic-agent 69.8% vs Hermes 58.5%](assets/gaia-l1-benchmark.png)

On the public **GAIA validation Level 1** split (53 tasks), `atomic-agent` and
`Hermes` drove the **same** local `qwen-3.6-35b-a3b` (`llama-server`, UD-Q4_K_XL),
with the same step budget and timeout. The only variable is the agent loop.

| Metric | atomic-agent | Hermes |
|---|---|---|
| **Accuracy** | **37/53 = 69.8%** | 31/53 = 58.5% |
| Avg wall / task | **~217 s** | ~351 s |
| Head-to-head wins | **+15 atomic-only** | +9 Hermes-only |

**atomic-agent: +11.3 pp more accurate, ~1.6× faster per task** — same hardware, same model, same budget.

<details>
<summary>Charts (accuracy &amp; speed)</summary>

```mermaid
xychart-beta
    title "GAIA L1 accuracy — higher is better (%)"
    x-axis ["atomic-agent", "Hermes"]
    y-axis "Accuracy (%)" 0 --> 100
    bar [69.8, 58.5]
```

```mermaid
xychart-beta
    title "Avg wall time per task — lower is better (s)"
    x-axis ["atomic-agent", "Hermes"]
    y-axis "Seconds / task" 0 --> 400
    bar [217, 351]
```

</details>

### Model scaling

The same agent loop holds up as the local model shrinks. Same GAIA L1 split
(53 tasks), same harness, same step budget — only the chat model changes
(`atomic-agent` alone, no competitor):

| Chat model | Accuracy | Avg wall / task |
|---|---|---|
| `qwen-3.6-35b-a3b` (UD-Q4_K_XL) | **37/53 = 69.8%** | ~217 s |
| `qwen-3.5-9b` (Q4_K_M) | **28/53 = 52.8%** | ~152 s |
| `gemma-4-12b` (it-qat UD-Q4_K_XL) | **24/53 = 45.3%** | ~423 s |

Even a 9B model clears half of GAIA L1 through the same context-frugal loop.
(Different `atomic-agent` versions per row — see the write-up for provenance.)

Full reproducible write-up: [`eval-agents/docs/GAIA-L1-EXPERIMENT.md`](eval-agents/docs/GAIA-L1-EXPERIMENT.md).
Raw artifacts (matrices, NDJSON traces, logs): [gaia-l1-eval-2026-06-11 release](https://github.com/AtomicBot-ai/atomic-agent/releases/tag/gaia-l1-eval-2026-06-11).

## Built to Make Local Models Work

Local models need more than a prompt. They need a loop that spends context carefully, reuses cache aggressively, and keeps every step valid:

- **turboquant `llama.cpp`** — a purpose-built backend ([`AtomicBot-ai/atomic-llama-cpp-turboquant`](https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant)) shipped in managed mode and tuned for throughput on consumer machines.
- **Curated quantized models** — hand-picked GGUF quants that keep quality high while fitting real VRAM budgets.
- **KV-cache reuse** — a byte-stable prompt prefix plus slot affinity reuse the cache across steps instead of re-encoding the world every turn.
- **Grammar + bounded prompts** — GBNF tool-call grammar, small bounded prompt tails, and resource-aware parallel read batches keep every inference cheap and valid.

## Quick Install/Update

```bash
curl -fsSL https://api.atomicbot.ai/agent-install | sh
```

The installer downloads the release archive, verifies the checksum, and installs the CLI plus support assets such as `grammars/`, native prebuilds, and bundled `ripgrep`.

## Run

```bash
atomic-agent
```

## Why Local-First Matters

Most agent products ask you to rent the control plane. Your files, browser context, prompts, traces, tool outputs, and usage patterns move through a hosted service, then the bill follows the token stream.

`atomic-agent` takes the local-first route:

- Run the agent loop locally.
- Bring your own `llama-server`, or let the CLI manage one.
- Keep sessions, memory, tasks, traces, skills, browser profile, and config under `<stateDir>`.
- Inspect the prompt, replay trace drift, edit skills, and replace parts without waiting for a vendor.
- Use cloud providers only when you deliberately configure them.

This is for people who want an AI agent they can actually own: local models, terminal UIs, SQLite files, trace logs, hackable tools, and software that can be understood all the way down.

## The Core Idea

A local model can operate software if the agent loop stops wasting its context.

`atomic-agent` does not treat the model like an infinite planner. One inference produces one JSON array of tool calls. The agent core executes those calls, compresses the results, updates durable state, and asks the model for the next move.

```text
user message
  -> compact prompt
  -> llama-server completion with tool-call grammar
  -> JSON array of 1..N tool calls
  -> resource-aware execution
  -> compressed results and durable state
  -> repeat until reply, finish, cancel, or max steps
```

The model chooses actions. `atomic-agent` owns the loop, the state, the approvals, the traces, and the failure boundaries.

## What Makes It Different

### Local-Model Native by Design

- **Stable prefix:** persona, rules, tools, skills, capabilities, and instructions stay byte-stable inside a session so `cache_prompt` and `slot_id` can reuse KV-cache.
- **Bounded tail:** conversation, memory, world state, recalled notes, lessons, procedures, and loaded skill bodies are clipped into a predictable prompt budget.
- **Externalized state:** sessions, memory, tasks, skills, traces, browser snapshots, and model config live outside the prompt.
- **GBNF tool calls:** completions are constrained into a JSON array of tool calls, including the solo case `[{...}]`.
- **Parallel read batches:** independent read-only calls can run concurrently after a single inference; dangerous actions remain approval-gated.
- **Compact browser view:** ordinary web operation uses accessibility / ARIA snapshots instead of screenshot-heavy page dumps.

This is why small local models can stay useful across long, tool-heavy work.

### A Real Desktop Tool Surface

`atomic-agent` can work across the local machine:

- **Browser:** navigate, click, type, inspect tabs, and read compact browser state through `playwright-core` against Chrome, Edge, or another Chromium-family browser.
- **Filesystem and shell:** read, write, patch, glob, grep, archive, hash, inspect processes, use clipboard, send notifications, and run approved commands.
- **Documents:** extract text from PDF, DOCX, DOC, XLSX, RTF, ODT, PPTX, archives, and plain text locally.
- **Git:** status, log, diff, show, blame, and branch inspection.
- **Skills:** Markdown playbooks with optional approved scripts; full skill bodies load only when needed.
- **Memory:** profile facts, notes, hybrid recall, links, lessons, procedures, voting, reflection, and bounded prompt rendering.
- **Tasks:** durable deferred turns, cron schedules, intervals, webhooks, and agent-created reminders.
- **Vision:** optional `vision.describe` for multimodal models with `mmproj`, kept outside the normal text transcript.
- **Providers:** local `llama-server` by default, plus OpenAI-compatible and OpenRouter-style providers for text or embeddings when configured.
- **MCP:** connect external MCP servers and expose their tools, resources, and prompts through the same tool registry.
- **Telegram:** single-user remote control with owner pairing and inline approval buttons.

Dangerous actions are routed through approvals. Read-heavy exploration stays fast.

## Memory That Grows Outside the Prompt

`atomic-agent` memory is not a giant chat log pasted back into the prompt. It is a local, inspectable memory system: durable identity, episodic notes, associations, distilled lessons, reusable procedures, and feedback from experience.

The agent does not need to replay every old turn to benefit from experience. It can recall relevant facts, follow pointers into past notes, connect related memories, learn lessons from repeated outcomes, and keep procedure templates for familiar work:

- **Profile facts** render into `### profile` with contextual keyword gating.
- **Notes** are stored in SQLite + FTS5, optionally paired with embeddings for hybrid recall.
- **Links** connect related memories into a bounded graph.
- **Lessons** distill repeated episodes into reusable principles.
- **Procedures** distill how-to templates without auto-executing them.
- **Voting** lets useful or harmful memories, lessons, procedures, and profile facts drift up or down.
- **Reflection** runs after turns, off the main agent slot, and writes memory without blocking the user-visible reply.

The prompt sees compact pointers, not the whole archive. Full bodies are recalled by tool call when the agent actually needs them, so memory can grow without turning every step into a token dump.

## Ways to Use It

### TUI And CLI

Use the CLI for simple sessions, automation, and debugging. Use the TUI when you want an interactive control console for approvals, logs, models, skills, tasks, memory, MCP, Telegram, and traces.

```bash
atomic-agent run --cwd /path/to/work
atomic-agent tui --cwd /path/to/work

atomic-agent skill list
atomic-agent task list
atomic-agent trace list --limit 10
```

### Managed Local Models

The CLI can manage a paired `llama.cpp` setup for chat and embeddings:

```bash
atomic-agent models update
atomic-agent models list
atomic-agent models pull qwen-3.5-4b
atomic-agent models use qwen-3.5-4b
atomic-agent models start

atomic-agent tui --cwd /path/to/work
```

Managed mode downloads the backend, pulls GGUF models, selects the active model, and starts detached chat / embedding daemons when configured.

### External `llama-server`

Already have your own `llama.cpp` process? Point `atomic-agent` at it:

```bash
export ATOMIC_AGENT_LLAMA_URL=http://127.0.0.1:8080

./llama-server -m Qwen2.5-9B-Instruct-Q4_K_M.gguf \
  --slots 4 \
  --parallel 4 \
  --port 8080 \
  --cache-reuse 256

atomic-agent tui --cwd /path/to/work
```

### OpenAI-Compatible HTTP

Run `atomic-agent` as a local HTTP service:

```bash
atomic-agent serve \
  --host 127.0.0.1 \
  --port 8787 \
  --cwd /path/to/work \
  --api-key "$ATOMIC_AGENT_API_KEY"
```

`POST /v1/chat/completions` maps one request to one full macro-turn: `user -> 0..N tool steps -> reply`. Atomic-specific routes expose sessions, approvals, tasks, webhooks, events, traces, config, and capabilities.

### Tauri Sidecar

The sidecar speaks newline-delimited JSON over stdio, making it easy to embed in desktop apps:

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

### Telegram Remote Control

Enable a personal Telegram bot and drive the same agent from your phone:

```jsonc
// <stateDir>/config.json
{
  "telegram": { "enabled": true, "ownerUserId": null }
}
```

```bash
# <stateDir>/.env
TELEGRAM_BOT_TOKEN=123456789:AA-your-bot-token
```

The TUI can store the token, start the channel, open pairing mode, and show status. Approvals arrive as inline buttons in your DM. Telegram is intentionally single-user.

### MCP Client

Configure MCP servers in `config.json`, and their tools join the same registry as local tools. Trusted read-only servers can batch with other reads; untrusted servers default to approval-gated execution.

```jsonc
{
  "mcp": {
    "servers": [
      {
        "name": "docs",
        "enabled": true,
        "transport": {
          "kind": "stdio",
          "command": "npx",
          "args": ["-y", "@example/mcp-server"]
        },
        "trust": "pure_read"
      }
    ]
  }
}
```

The TUI MCP panel supports live add / remove without restarting the process.

## Safety And Observability

Local does not mean opaque. `atomic-agent` is built to be inspected and interrupted.

- **Approval gates:** shell, filesystem writes, patches, archive extraction, process kill, HTTP requests, skill scripts, and untrusted MCP tools are gated by policy.
- **Append-only traces:** prompts, completions, tool invocations, outcomes, failure categories, votes, lesson lifecycle events, and procedure events can be recorded as local NDJSON.
- **Prompt drift replay:** `atomic-agent trace replay <sessionId>` compares current stable-prefix hashes against recorded traces.
- **Failure taxonomy:** transport, grammar, model, tool, and cancellation failures are classified across events, traces, metrics, TUI, sidecar, and HTTP.
- **Per-session FIFO:** every surface enters the same `TurnController`; one session stays ordered while different sessions can run concurrently.
- **Explicit state:** sessions, memory, tasks, skills, browser profile, Telegram pointer, MCP config, and traces are ordinary local files or SQLite databases.

Treat traces and `<stateDir>/.env` as sensitive local artifacts. Secret redaction and per-tool environment filtering are not complete isolation layers.

## Privacy And Egress

By default, `atomic-agent` does not require a hosted agent provider. Model calls go to your configured backend, and local artifacts stay under `<stateDir>`.

Egress is still explicit and real:

- browser navigation talks to websites;
- HTTP tools talk to requested endpoints;
- configured cloud LLM or embedding providers receive their requests;
- MCP servers receive the tool calls you route to them;
- skills and shell commands inherit the agent process environment.

The promise is not magic secrecy. The promise is that the agent control plane does not need to be remote.

## Requirements

- Node.js for development; release bundles ship as Node SEA binaries.
- A reachable `llama-server`, either managed by `atomic-agent models` or launched externally.
- Chrome, Microsoft Edge, or another configured Chromium-family executable. Browser binaries are not bundled.
- `git` for git tools.
- macOS workflows may need Accessibility, Screen Recording, Automation, or Reminders permissions.

### Linux notes

- **Desktop tools** (install via your package manager for full capability coverage):
  - `ripgrep` — file search (`fs.grep`). A bundled binary is used when present.
  - `xclip` / `xsel` (X11) or `wl-clipboard` (Wayland) — clipboard tools.
  - `libnotify-bin` (provides `notify-send`) — desktop notifications.
  - `wmctrl` — window control. Does **not** work on pure Wayland sessions (X11 / XWayland only).
  - `gio` (glib2) or `trash-cli` — move-to-trash for `fs.trash`.
- **Browser:** Chromium-family sandboxing can fail under some Linux setups (containers, certain kernels). If Chrome refuses to launch, run it with `--no-sandbox` (set the browser channel / executable accordingly).
- **GPU acceleration (managed mode):** the managed `llama.cpp` backend always starts — it falls back to CPU when no GPU driver is available. For GPU offload install a Vulkan driver:
  - Intel / AMD: `mesa-vulkan-drivers` (plus `vulkan-loader` / `libvulkan1`).
  - NVIDIA: the stock proprietary driver bundles its Vulkan ICD.
  The device is auto-selected at start (best discrete GPU); override with `atomic-agent models use-device <auto|cpu|Vulkan0>`, inspect with `atomic-agent models devices`, or press `G` in the TUI Models tab.

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

Secrets for skills and channels belong in `<stateDir>/.env`, not in `config.json`:

```text
NOTION_API_KEY=ntn_xxxxxxxx
GITHUB_TOKEN=ghp_xxxxxxxx
TELEGRAM_BOT_TOKEN=123456789:AA-your-bot-token
OBSIDIAN_VAULT_PATH=/Users/me/Documents/Obsidian Vault
```

Shell-exported variables win over `.env`. The built-in parser intentionally supports only simple `KEY=VALUE` lines.

## What It Is Not

- Not a cloud agent platform.
- Not a hosted IDE coding agent.
- Not a browser distribution.
- Not a model-weight distribution.
- Not a giant-prompt framework.
- Not a hidden multi-agent planner.
- Not a complete secret-redaction or sandbox-isolation system.

The restraint is deliberate: small core, explicit state, local control, embeddable protocol.

## Development

```bash
npm install
npm run lint
npm test
npm run build
```

Core docs:

- [PROMPT.md](PROMPT.md) for stable-prefix and variable-tail prompt anatomy.
- [MEMORY.md](MEMORY.md) for profile facts, notes, reflection, and recall.
- [MEMORY_FABRIC_V2.md](MEMORY_FABRIC_V2.md) and [MEMORY_FABRIC_V2.5.md](MEMORY_FABRIC_V2.5.md) for the memory roadmap.
- [SKILLS.md](SKILLS.md) for the local skill format.
- [BUNDLING.md](BUNDLING.md) for release packaging.
- [AGENTS.md](AGENTS.md) for contributor invariants and runtime contracts.

## License

[MIT](LICENSE) (c) 2026 Atomic Bot
