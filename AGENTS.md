# atomic-agent — engineering guide for agents

This is the source-of-truth for automated contributors (LLM agents, codegen, etc.). Human-facing docs live in `README.md`.

## Mission

`atomic-agent` is a lightweight local operator agent runtime that:

- Embeds as a **sidecar** in Tauri desktop apps (stdin/stdout NDJSON).
- Ships a **CLI** (`atomic-agent`) for local debugging.
- Connects to an **external** `llama-server` (llama.cpp) over HTTP — the LLM runtime, model weights, and binaries are **not** part of this project.
- Keeps every LLM step under ~2.5k tokens by externalising session state, summarising results, and keeping the stable prompt prefix small.

## Architectural invariants

1. **Project ≠ Prompt.** Session state, compressed tool results, and world snapshots live outside the model; the prompt is always a small slice.
2. **Stable prefix.** The prompt is `buildStablePrefix` (persona + `### rules` + skill catalog under `### skills` + `### tools` + `### capabilities` + `### instructions`) followed by a **variable tail** in mutability order: `### loaded-skills` (optional) → `### loaded-tools` (optional) → `### profile` (optional) → `### memory-index` (optional) → `### session-facts` (optional) → `### recalled` (optional) → `### world` → `### conversation` → optional `### notice` → `### respond` (+ optional reasoning prefill). Only the stable-prefix bytes must stay stable within a session for KV-cache — this is what `cache_prompt + slot_id` on `llama-server` relies on.
3. **One inference per step.** No reasoning loops inside a single LLM call — the runtime drives the loop. A single inference always emits a JSON **array** of `1..N` tool calls (`[{tool, args}, ...]`); a "solo" step is just a length-1 array (`[{...}]`). `N` is capped by `agent.maxParallelToolCalls` (default 8, hard ceiling 16 in the grammar). See §"Parallel tool calls per step" for the rationale (GBNF first-token bias) and the executor pipeline.
4. **Grammar-constrained tool calls.** The sidecar sends a GBNF grammar with every completion request that must produce a tool call. The root collapsed to **array-only** (`root ::= tool-call-array`) so the model cannot fall into the single-object form via first-token bias even when it only needs one call.
5. **No global singletons.** Dependencies are passed explicitly. `getConfig()` is the only exception.
6. **Session is multi-turn chat only.** A session is a long-lived chat: `user message → 0..N tool steps → reply` is a macro-turn, multiple turns share one `SessionState.turns[]`. Two terminals exist — `reply` ends the turn, `finish` ends the whole session. All three frontends (CLI `run`, TUI, sidecar) go through `runtime.runTurn` only; there is no one-shot goal mode.

## Rare tools: `tool.view` and `### loaded-tools`

The stable-prefix `### tools` block lists **frequent** tools with full `args` schemas in `# common (full)` and **rare** tools as one-line entries under `# extras` (tier `rare`), keeping the cache-hot prefix small. The model does not see full `args` for a rare tool until that tool is **loaded** into the session and rendered in the **variable** tail as `### loaded-tools` (not part of the stable prefix, so it does not pollute KV-cache for steps that do not use rare tools).

- **Discovery tool.** `tool.view { name }` (see `src/tools/tool-view/`) appends the full descriptor for `name` to `SessionState.loadedTools` (LRU-evicted, cap `config.agent.loadedToolsCap`). The next step’s `buildPrompt` includes `### loaded-tools` with capped token budget `config.agent.loadedToolsMaxTokens`; the effective conversation cap subtracts that budget (see `src/prompt/token-budget.ts`). Optional `config.agent.autoExpandRareOnError` re-invokes a rare tool with autoloaded schema after an invalid-args failure (`src/agent/step-executor.ts`).

- **Contract.** Follow the same idea as `skill.view`: do not call a rare tool with precise arguments until its schema is present under `### loaded-tools` (call `tool.view` first, or rely on autoload on error if enabled). GBNF allows `tool.view` alongside other tools (`grammars/tool-call.gbnf`).

## Skills enable / disable

Installed skills can be turned off without removing their files via `skills.disabled: string[]` in `<stateDir>/config.json` (config v8). A disabled name is filtered out of `SkillRegistry.list()` entirely — it disappears from the `### skills` catalog block in the stable prefix, `skill.view` returns `SkillNotFoundError`, and the underlying skill directory stays put on disk so `seed-starter-skills` re-seeds remain idempotent. The CLI surface is `atomic-agent skill enable|disable <name>` and `atomic-agent skill list` (with an `enabled`/`disabled` column); the TUI exposes the same toggle through a dedicated **Skills tab** (`/skills` opens it, `/skill enable|disable <name>` mutates from chat). Editing the list invalidates KV-cache once because the stable-prefix bytes change — identical to install/uninstall today. Pinned by [src/skills/skill-registry.test.ts](src/skills/skill-registry.test.ts) (filtering + `listAll()`), [src/cli/skill.test.ts](src/cli/skill.test.ts) (idempotent enable/disable round-trip), [src/prompt/build-prompt.test.ts](src/prompt/build-prompt.test.ts) ("stable prefix changes deterministically when a skill is removed from the catalog"), and [src/config/config-schema.test.ts](src/config/config-schema.test.ts) (v7 → v8 transparent migration).

## Parallel tool calls per step

A single LLM inference always emits a JSON **array** of `1..N` tool calls. The runtime executes the array with class-aware concurrency: independent reads fan out, mutating tools serialise, and the wall time of the step collapses to `max(group_duration)` instead of the sum. This is the path that turns "scan 4 CSVs for PII" from 4 sequential `os.fs.read`s into one batched step.

### Grammar shape (array-only)

`grammars/tool-call.gbnf`:

```
root ::= tool-call-array
tool-call ::= "{" ws "\"tool\"" ws ":" ws tool-name ws "," ws "\"args\"" ws ":" ws object ws "}"
tool-call-array ::= "[" ws tool-call ( ws "," ws tool-call ){0,15} ws "]"
```

**Why array-only.** The first iteration of this feature shipped with `root ::= tool-call | tool-call-array` so a solo step could keep the legacy `{tool, args}` shape. Production traces showed that small/medium models (Qwen3-30B-A3B-Instruct in particular) almost never picked the array branch even when their `<think>` block reasoned about parallel reads — the GBNF sampler's first-token mass strongly favours `{` over `[`. Collapsing the root to `tool-call-array` removes that choice entirely: the model **must** start with `[`, which makes "one call vs many calls" a decision about array length instead of a first-token gamble. A solo step is now `[{...}]`. The legacy `parseToolCall` still accepts a bare `{tool, args}` for tests/replay scenarios, but `llama-server` will never emit one under the production grammar.

The hard upper bound on array length is **16** (grammar). The runtime soft cap is `agent.maxParallelToolCalls` (default `8`, env `ATOMIC_AGENT_MAX_PARALLEL_TOOL_CALLS`). Both reasoning profiles (`qwen-think`, `gemma4-think`) route the prelude into `tool-call-array`, so think-mode batches work the same way (see [src/llm/grammar/build-grammar.ts](src/llm/grammar/build-grammar.ts) and the matching invariant in [src/llm/profile-invariants.ts](src/llm/profile-invariants.ts)).

The change to the array-only root **invalidates KV-cache** for any session that started under the old grammar — the stable prefix bytes change once, then stay stable. There is no hot migration path; restart with a fresh session pool.

### Resource-class taxonomy

[src/agent/tool-resource-class.ts](src/agent/tool-resource-class.ts) maps every registered tool to one of nine classes. The batch executor groups calls by class — same-class calls run **inside** the group (parallel for `pure_read`, serial for everything else), distinct groups run **concurrently** with each other.

| Class | Examples | Within-group | Cross-group |
|---|---|---|---|
| `pure_read` | `os.fs.read`, `os.fs.glob`, `os.fs.grep`, `os.git.*` (read), `os.fs.list`, `os.fs.read_document`, `memory.notes.recall`, `tasks.list` | **parallel** (`Promise.allSettled`) | parallel |
| `browser` | `browser.*` | serial (Playwright is single-process) | parallel |
| `memory_write` | `memory.profile.set`, `memory.notes.store`, `os.clipboard.write`, `os.notify` | serial | parallel |
| `tasks_write` | `tasks.schedule`, `tasks.cron`, `tasks.cancel` | serial | parallel |
| `vision` | `vision.describe` | serial (bounds backend load) | parallel |
| `fs_write` | reserved | serial | parallel |
| `approval_gated` | `os.shell.run`, `os.fs.{write,edit,trash,patch,archive.extract}`, `os.proc.kill`, `os.http.request`, `skill.run_script` | **forbidden in batch** — must be solo | — |
| `terminal` | `reply`, `finish` | **forbidden in batch** — always solo | — |
| `unknown` | unregistered names | **forbidden in batch** (fail-closed) | — |

Adding a new tool **requires** an entry in `TOOL_RESOURCE_CLASS`; pinned by [src/agent/tool-resource-class.test.ts](src/agent/tool-resource-class.test.ts) which iterates `DEFAULT_TOOL_DESCRIPTORS` and rejects any with `unknown` class.

### Batch executor and step pipeline

[src/agent/batch-executor.ts](src/agent/batch-executor.ts) owns the planner. The flow inside [src/agent/step-executor.ts](src/agent/step-executor.ts) is:

1. **Parse.** `parseToolCalls(...)` returns a `ToolCallBatch { kind: "single" | "batch", calls: ToolCallPayload[], reasoning? }`. Under the array-only production grammar `kind` is always `"batch"` (a solo step has `calls.length === 1`); the `"single"` branch only fires for legacy bare-object input from tests / replay traces.
2. **Validate.** `validateBatch` rejects multi-call batches that contain a terminal verb, an approval-gated tool, an unknown class, or exceed `maxParallelToolCalls`. A failure is treated like a parse error: the executor triggers the existing one-shot LLM retry. After two failures it surfaces as `GrammarError` with the per-call reasons. Length-1 batches bypass these checks (legacy semantics for any tool, including `reply`/`finish`/approval-gated).
3. **Registry check.** Missing tools throw `ToolExecutionError` (category `tool`) without retry — replaying the prompt would not change the registry.
4. **Execute.** `executeBatch` plans groups, fans out, collects `BatchCallResult[]`. Failures of one call are folded into a synthetic `CompressedToolResult{status:"error"}` so siblings keep running. `signal.aborted` halts in-flight serial groups and marks the tail as `cancelled`.
5. **Apply effects.** `applyStateEffects` is invoked per result in batch-index order; `recordLatestResult` is "last writer wins". World snapshot updates from multiple browser calls collapse to the last batch index.
6. **Auto-expand on error.** Failed rare-tool calls trigger `autoExpandRareOnError` independently per batch index — each rare tool that errored gets its full descriptor injected into `### loaded-tools` for the next step.
7. **Append turns.** `appendBatchedTurns` writes N `assistant_tool_call` + N `tool_result` pairs in batch-index order. Reasoning is attached once on the first `assistant_tool_call` (one inference ⇒ one `<think>` block). The new `agent.batchToolResultCharCap` (default `16000`, env `ATOMIC_AGENT_BATCH_TOOL_RESULT_CHAR_CAP`) trims oldest within-batch summaries first when the combined char total overflows.

### Locked invariants (pinned by tests)

Pinned by [src/agent/batch-executor.test.ts](src/agent/batch-executor.test.ts), [src/agent/step-executor.test.ts](src/agent/step-executor.test.ts), [src/agent/parallel-tool-calls.integration.test.ts](src/agent/parallel-tool-calls.integration.test.ts), [src/agent/loop-detector.test.ts](src/agent/loop-detector.test.ts), [src/llm/grammar/tool-call-grammar.test.ts](src/llm/grammar/tool-call-grammar.test.ts), [src/llm/grammar/build-grammar.test.ts](src/llm/grammar/build-grammar.test.ts), [src/tracing/trace/trace-recorder.test.ts](src/tracing/trace/trace-recorder.test.ts):

1. **One inference per step.** Batches do not start a new LLM call — they execute multiple tools after one inference completes.
2. **Terminal verbs and approval-gated tools are always solo.** Validator rejects them from any multi-call batch; one-shot retry asks the model to re-emit as a length-1 array (`[{...}]`).
3. **Result order matches batch-index order.** `toolResults[i]` corresponds to `toolCalls[i]` regardless of completion order. Pure-read fan-out reorders execution but not results.
4. **Failures isolate.** A failed call never aborts siblings; it lands in `toolResults[i]` as `{status: "error", details}`. `loop_failed` only fires on infra failures (parse/grammar/cancel), not on tool-level errors.
5. **Loop detector uses a composite hash for batches.** Two identical batches in a row count as a repeat; a permuted batch (same calls, different order) does **not** — the model may legitimately reorder a set after re-thinking. Synthetic label `<batch>` (`BATCH_LOOP_LABEL`).
6. **Per-step trace = N `tool_invocation` events.** `trace-recorder.ts` keys pending parsed calls by `batchIndex` so each pair is recorded with `{batchIndex, batchSize}` (omitted for solo steps for back-compat).
7. **Sidecar forwards batch metadata optionally.** `tool_call_started` / `tool_call_result` carry `batchIndex` / `batchSize` only when `batchSize > 1`; hosts that ignore them keep working.
8. **Cross-session parallelism unchanged.** `TurnController` per-session FIFO is untouched — batches are *intra*-step parallelism, not inter-session.

### Configuration (`agent.*`)

- `agent.maxParallelToolCalls` — default `8`, range `[1, 16]`. Env `ATOMIC_AGENT_MAX_PARALLEL_TOOL_CALLS`. Set to `1` to disable batching; set to higher values to widen pure-read fan-out. Bumped from `4` → `8` after production traces showed `qwen-3.5` routinely emits 5–7 reads when the user requests "≥N files" — the previous cap forced two doomed `parse_retry` attempts in a row, both classified as `GrammarError`.
- `agent.batchToolResultCharCap` — default `16000`. Env `ATOMIC_AGENT_BATCH_TOOL_RESULT_CHAR_CAP`. Soft cap on combined summary length per batched step before per-result truncation.

Both are env-only; not user-config-file material.

### Out of scope (deferred)

Speculative batching (the runtime guessing that the model "should" have batched and rewriting the next step's prompt), per-class concurrency limits beyond the binary parallel/serial split, dependency analysis (`B uses A`'s output) — the model decides what is independent, the runtime trusts it.

## Layout rules (enforced)

- Feature-based folders under `src/`. Max 2 levels of nesting.
- Each folder has an explicit `index.ts` with **named** exports (no `export *`).
- One responsibility per file. File name describes it exactly. No `utils.ts`, `helpers.ts`, `misc.ts`, `common.ts`.
- Max 300 lines per file. If you cross that, split before adding new code.
- File naming: `kebab-case`, verb-noun for actions (`build-prompt.ts`, `apply-patch.ts`).
- Function naming: `camelCase`, verb-first (`buildPrompt`, `applyPatch`).
- Tests are colocated with source: `build-prompt.test.ts` next to `build-prompt.ts`.
- Config lives in `src/config/` — read it before touching env vars.

## Module map

| Folder | Responsibility |
|---|---|
| `src/config/` | User config file (`<stateDir>/config.json`) + env-based bootstrap, single `getConfig()` |
| `src/sidecar/` | NDJSON protocol + router + typed event schema |
| `src/cli/` | `run`, `index`, `repl`, `tui`, `serve` commands |
| `src/http/` | OpenAI-compatible HTTP API + atomic admin routes for `atomic-agent serve` |
| `src/llm/` | HTTP client for external llama-server + GBNF grammar |
| `src/prompt/` | Prompt builder, stable prefix, token budget. See [PROMPT.md](PROMPT.md) for full anatomy of the stable prefix and variable tail. |
| `src/session/` | Session state + sqlite persistence |
| `src/agent/` | Agent loop + step executor + parallel batch executor (`batch-executor.ts`) + resource-class taxonomy (`tool-resource-class.ts`) + no-progress loop detector |
| `src/tools/` | Tool registry + individual tools. OS tools: `shell.run`, `fs.read` (w/ `offset`/`limit`/`lineNumbers`), `fs.write`, `fs.list`, `fs.glob`, `fs.grep` (bundled ripgrep), `fs.edit` (atomic string replace), `fs.read_document` (PDF/DOCX/XLSX/RTF/ODT/PPTX/legacy .doc → plain text via pure-JS), `fs.archive.list` / `fs.archive.read_entry` / `fs.archive.extract` (zip/tar/tar.gz/gz via pure-JS; zip-slip + bomb guards), `fs.hash` (md5/sha1/sha256/sha512 streaming), `fs.diff` (unified diff, jsdiff), `fs.patch` (dry-run default, all-or-nothing apply), `fs.watch` (chokidar one-shot, timeout-capped), `git.status` / `git.log` / `git.diff` / `git.show` / `git.blame` / `git.branch` (read-only shell-out with structured parse), `proc.list` / `proc.kill` (ps/tasklist + approval), `http.request` (curl + host allowlist + `config.http.approvalMode`), `clipboard.*`, `window.*`, `notify`. |
| `src/compressor/` | Result compressor, log summariser |
| `src/sandbox/` | git worktree + sandboxed command runner |
| `src/approval/` | Approval gate and event wiring |
| `src/tracing/` | Structured logger + metrics + trace recorder (`src/tracing/trace/`) |
| `src/replay/` | Trace-based replay: drift detection + optional LLM re-inference |
| `src/memory/` | Memory fabric: ProfileStore (key/value facts, pinned + contextual) + MemoryStore (FTS5 freeform notes) + async end-of-turn reflection that writes into both. See [MEMORY.md](MEMORY.md). |
| `src/runtime/` | `bootstrap.ts` (assembles `AgentRuntime`) + `turn-controller.ts` (per-session FIFO queue + per-session event hook map; the **only** path into `AgentLoop.runTurn`). See §"Concurrency contract". |
| `src/tasks/` | Durable queue of deferred `runTurn` submissions: `TaskStore` (SQLite), `TaskRunner` (drain + retry/backoff), `task-backoff`, `task-schedule` (cron / interval / at resolver). See §"Durable tasks" and §"Background autonomy". |
| `src/scheduler/` | One-process `Scheduler` (single `setInterval`) that polls `TaskStore.listDue` via `TaskRunner.runDue`. The **only** periodic timer in the runtime. See §"Background autonomy". |
| `src/http/route-webhooks.ts` + `webhook-template.ts` + `webhook-session-store.ts` | Generic `POST /api/webhooks/:name` ingress. Always materialises into a `TaskRecord`, never calls `runTurn` directly. See §"Background autonomy". |
| `src/tools/tasks/` | Agent-facing self-scheduling tools (`tasks.schedule`, `tasks.cron`, `tasks.list`, `tasks.cancel`, `tasks.show`), gated by `tasks.agentToolsEnabled`. |
| `src/llm/provider/` | Provider abstraction layer (`LlmProvider` interface) + `LlamaServerProvider` adapter. Text completion stays on `LlamaServerClient.complete` / `completeStream` (legacy `/completion` extension with GBNF + slot ids); vision routes through `LlamaServerProvider.describeImage` against `/v1/chat/completions` with OpenAI-shape `image_url` content blocks. See §"Vision (multimodal input)". |
| `src/tools/vision/` | `vision.describe` tool + `loadImageFile` helper. Registered whenever `config.vision.enabled` is true and a provider is constructed; the actual capability gate (`capabilities.vision`) is a dynamic getter that re-reads `ModelProfile` on every check, so vision availability tracks `ModelProfileManager` hot-swaps without a restart. See §"Vision (multimodal input)". |
| `src/channels/telegram/` | `TelegramChannel` (lifecycle + live-control), `inbound-handler` (slash commands + dispatch into `runTurn`), `outbound-sender` (chunked replies + 429 retry), `approval-bridge` (inline-keyboard approvals with 8-min auto-deny), `pairing-mode` (60s window for first-DM owner claim), `telegram-settings` (`config.json` + `.env` persistence), `telegram-bot-factory` (grammy adapter). The **only** module that imports `grammy`. See §"Telegram remote-control channel". |
| `src/tui/telegram/` | TUI "Telegram" tab: `telegram-panel-state` + `telegram-actions` + `telegram-panel-reducer` (pure UI state slice), `tui-telegram-orchestrator` (the only TUI module that touches `runtime.telegramChannel`), `telegram-key-bindings`, and the `telegram-panel` / `telegram-token-prompt` / `telegram-pairing-modal` components. See §"Telegram remote-control channel". |

## Secrets and process environment

Skills that need API keys (Notion, GitHub, etc.) read them from `process.env`. The agent populates `process.env` once at bootstrap from the optional file `<stateDir>/.env` via `loadDotenvFromStateDir` in [src/config/load-dotenv.ts](src/config/load-dotenv.ts), invoked from [src/config/load-config.ts](src/config/load-config.ts) immediately after `stateDir` is resolved and before `ensureUserConfigFileSync`. Shell-exported variables always win — the loader only sets a key when it is currently unset or empty. Missing file is a silent no-op. The parser is deliberately tiny (`KEY=VALUE` per line, optional surrounding quotes, `#` comments, blank lines; no interpolation, no `export ` prefix, no multiline values) so we do not depend on the `dotenv` package.

There is currently **no per-tool env filtering**. `runCommand` in [src/sandbox/command-runner.ts](src/sandbox/command-runner.ts) inherits the full agent `process.env`, so every spawned subprocess (`os.shell.run`, `runSkillScript`, the managed `llama-server`, future MCP servers) sees every variable loaded from `.env`. Tightening this — per-skill `env_vars` whitelist + safe-baseline filtering (`PATH`, `HOME`, `USER`, `LANG`, `TERM`, `XDG_*`) — is tracked as a separate effort and pinned by no tests yet. Do not assume isolation when designing new skills that handle highly sensitive secrets; document the shared-env reality in the skill's `SKILL.md` instead.

## Build & test

```bash
npm install
npm run lint    # tsc noEmit
npm test        # vitest run
npm run build   # compile to dist/
```

The CLI entry is `src/cli/index.ts`; the sidecar entry is `src/sidecar/main.ts`.

## llama-server modes

`atomic-agent` supports two modes for the llama-server backend (`config.llama.mode`):

- `external` (default) — user runs `llama-server` out-of-band; runtime reads the URL from `config.llama.url` (env fallback `ATOMIC_AGENT_LLAMA_URL`).
- `managed` — `atomic-agent` downloads the llama.cpp binary from `AtomicBot-ai/atomic-llama-cpp-turboquant` GitHub Releases into `<stateDir>/llamacpp/backend/` and GGUF models into `<stateDir>/llamacpp/models/<id>/`. The server is **not** spawned by the runtime; operators control lifecycle via `atomic-agent llama start|stop|status|update`.

**Invariant (preserved):** the agent runtime never starts a `llama-server` process. It only connects. Managed-mode lifecycle lives entirely in the `atomic-agent llama` CLI so runtime code paths stay single-mode.

When the server is unreachable, the sidecar emits an `llm_unavailable` event with the current mode and a hint. In managed mode the hint points at `atomic-agent llama start`; in external mode it points at checking `llama.url` / `ATOMIC_AGENT_LLAMA_URL`.

## Current memory model

Today the runtime persists session-scoped state only:

- `SessionState.turns[]` for the full multi-turn transcript
- `knownFacts[]` for compact session facts
- `loadedSkills[]` for skill bodies loaded via `skill.view`
- `loadedTools[]` for full rare-tool descriptors loaded via `tool.view` (see §"Rare tools: tool.view and loaded-tools")
- `worldSnapshot` for compressed browser state

`SessionState.turns[]` stores the full history in memory and in the sessions DB unchanged. Prompt-time compression happens only at the `buildPrompt` boundary via `packConversation`: older turns get folded into a single deterministic `summary: N older turns dropped (...)` line so the variable tail of the prompt stays bounded without losing traceability. The visible tail always includes the latest `user` turn.

Prompt-section caps live in the config:

- `agent.tokenBudget` — compact ceiling for the upper prompt: stable prefix plus a shared budget for `### loaded-skills` + `### session-facts` (known facts and loaded skill bodies).
- `agent.conversationMaxTokens` (default 32000) — safety-net cap for the `### conversation` section; typical sessions stay well under it.
- `agent.worldSnapshotMaxTokens` (default 8000) — safety-net cap for the `### world` section; the snapshot is already compressed by `aria-compressor`, so this only clips pathological cases with a `[truncated]` marker.

At bootstrap `LlamaServerClient.fetchProps()` reads the model's physical `n_ctx` (from `default_generation_settings.n_ctx`, with a root `n_ctx` fallback) and stores it on `ModelProfile.contextWindow`. `buildPrompt` then clamps the effective conversation cap to the actual available room so the prompt cannot overflow llama-server regardless of how large the user-configured cap is. If llama-server is restarted with a different `n_ctx`, restart the runtime.

There is currently no dedicated workspace-memory, retrieval, embeddings, or resource-summary subsystem in `src/`. Do not describe those modules as implemented unless they are added to the codebase first.

## Memory fabric

A three-channel cross-session memory subsystem lives in [src/memory/](src/memory/) and exposes itself to the agent via six tools in [src/tools/memory/](src/tools/memory/). The full description is in [MEMORY.md](MEMORY.md); this section is the engineering summary. The v2 roadmap (paths B+C+E+P: reactive graph, periodic consolidation, vote curation, procedure templates) lives in [MEMORY_FABRIC_V2.md](MEMORY_FABRIC_V2.md) and rolls out in strict-gated phases. Plan-level deviation from doc §9 invariant 2: v2 pays the stable-prefix KV-cache invalidation **twice** (once when `### lessons` lands in phase 5, once when `### procedures` lands in phase 7b) instead of the doc's intended single combined release — the strict-gates rollout requires evaluation windows between the two prefix-touching phases.

### Memory-v2 phase 1B — hybrid FTS5 + embedding recall (opt-in)

Lives in [src/memory/embeddings/](src/memory/embeddings/) and is **disabled by default**. When turned on, it adds a second `llama-server` process dedicated to `/embedding` requests and blends BM25 hits with cosine similarity over a `memory_embeddings` table (schema v5).

**Two-daemon lifecycle.** `llama-server` cannot serve `/completion` and `/embedding` from the same process — the `--embeddings` flag forces pooling-only mode. The CLI therefore manages two parallel daemons:

- **Chat daemon** (primary): existing flow, port `localModels.managed.port` (default 19091), pid `<stateDir>/llamacpp/llama-server.pid`.
- **Embedding daemon** (optional secondary): new flow, port `localModels.embeddings.port` (default 19092), pid `<stateDir>/llamacpp/llama-embed.pid`. Built by `buildEmbeddingServerArgs` with `--embeddings --pooling <kind> --ctx-size 2048` and a dedicated embedding model GGUF (`nomic-embed-text-v1.5` ~84 MB, `bge-small-en-v1.5` ~33 MB — both in `EMBEDDING_MODELS_CATALOG`).

`atomic-agent models start` calls `startChatAndEmbeddingDaemons` which is **atomic in the chat-primary sense**: if the chat daemon fails to start, the function rejects and the embedding daemon is never spawned. If the embedding daemon fails (model missing, port collision, daemon refuses health) the chat daemon stays up and the call returns `{ embedding: { error } }` — the runtime then degrades to FTS5-only recall and logs a warning. `atomic-agent models stop` always tries to kill **both** pid files, so half-broken states resolve in a single command. New CLI subcommands: `models list-embeddings`, `models pull-embedding <id>`, `models use-embedding <id>|--disable`.

**Graceful degradation contract.** Every layer that touches the embedding daemon is non-throwing:

- `LlamaEmbeddingClient.embed` wraps every transport / shape / dim mismatch failure as a typed `EmbeddingUnavailableError` so callers can branch without sniffing messages.
- `EmbeddingWriter.writeFor` returns `boolean` and **never throws** — failures land in the `agent.memory.embeddings.fallback_to_fts5` counter (tagged by `reason`) and the row stays FTS5-only-recallable.
- `recallHybrid` short-circuits to BM25-only when the embedding client / store is null, when `embed()` fails, or when the corpus exceeds `memory.embeddings.bruteForceCeiling` (default 200). The overflow case emits `agent.memory.embeddings.brute_force_overflow` so dashboards spot when the JS-side brute-force cosine has outgrown its budget — sqlite-vec / ANN migration is the deferred follow-up.
- Bootstrap probes the embedding daemon's `/health` once with a short timeout; failure flips the runtime to text-only without aborting startup. The probe outcome is recorded in `agent.memory.embeddings.daemon_health` (`ok | unreachable | disabled`).

**Storage.** Schema v5 adds `memory_embeddings (memory_id, model, dim, embedding BLOB, created_at)` keyed by `(memory_id, model)` so a single corpus can host multiple model versions during an A/B rollout. `embedding` is raw Float32 little-endian (`dim * 4` bytes). `FOREIGN KEY ON DELETE CASCADE` from `memories(id)` cleans up automatically on `MemoryStore.remove` — `foreign_keys=ON` is set on the connection at construction time. Stores are wired in bootstrap via `MemoryStore.attachEmbeddings({ writer, store })`, which is intentionally late-bound: `MemoryStore` owns the SQLite handle, `EmbeddingStore` opens against the same handle once the daemon is confirmed healthy.

**Read/write paths.** Synchronous `MemoryStore.store()` kicks off a fire-and-forget embedding write (zero latency penalty for existing callers); `MemoryStore.storeAsync()` is the awaited sibling for tests that need the row to be hybrid-recallable on the next turn. `MemoryStore.recallHybridAsync()` is the new public entry point — it always goes through `recallHybrid` and is observably identical to the legacy `recall()` when embeddings are not attached. `createDefaultMemoryContextProvider` was switched to the async variant; the `MemoryContextProvider` interface already accepted `Promise<MemoryContext>`.

**Locked invariants.** Pinned by [src/memory/embeddings/embedding-client.test.ts](src/memory/embeddings/embedding-client.test.ts), [src/memory/embeddings/embedding-store.test.ts](src/memory/embeddings/embedding-store.test.ts), [src/memory/embeddings/hybrid-recall.test.ts](src/memory/embeddings/hybrid-recall.test.ts), [src/memory/memory-schema.test.ts](src/memory/memory-schema.test.ts), [src/local-llm/daemon-lifecycle.test.ts](src/local-llm/daemon-lifecycle.test.ts):

1. **Two-daemon separation is structural, not optional.** `llama-server --embeddings` forces pooling-only mode; a single instance cannot serve both `/completion` and `/embedding`. Anyone adding embedding usage MUST go through the secondary daemon's URL.
2. **Embedding writes never block the agent loop.** `MemoryStore.store()` is synchronous; the embedding write is fire-and-forget. Tests that need determinism call `storeAsync()`.
3. **Failure paths are observability-only.** Bootstrap, recall, write — none of them throw on embedding-daemon outages. Every degradation is a metric counter, never a status-`failed` turn.
4. **Cosine path skips on overflow.** When `countByModel(model) > bruteForceCeiling`, cosine is **not** computed; FTS5-only result returns and `brute_force_overflow` increments. This is the signal to wire `sqlite-vec` or trim the corpus.
5. **FK cascade is load-bearing.** `memories.remove(id)` must wipe the matching `memory_embeddings` row in the same transaction; the test `cascades delete from memories -> memory_embeddings` pins this.
6. **Config gates everything.** `memory.embeddings.enabled=false` OR `localModels.embeddings.enabled=false` OR `localModels.embeddings.modelId=null` ⇒ no second daemon, no embedding writes, no hybrid recall. Bootstrap never constructs an `EmbeddingClient` against an absent daemon.

**Configuration.** Added in user config v12 — older files transparently migrate with both blocks disabled.

- `memory.embeddings.enabled` (default `false`).
- `memory.embeddings.fts5Weight` / `vectorWeight` (defaults `0.5` / `0.5`, both in `[0, 1]`).
- `memory.embeddings.bruteForceCeiling` (default `200`).
- `localModels.embeddings.enabled` (default `false`) — must be `true` for the second daemon to be considered at startup.
- `localModels.embeddings.modelId` (default `null` — must be one of `EmbeddingModelId`).
- `localModels.embeddings.port` (default `19092`).

**Out of scope (deferred to follow-up).** `sqlite-vec` virtual table integration (the JS brute force handles current corpus sizes; sqlite-vec graduates the schema without touching `EmbeddingStore` callers), ANN indexes, cross-model query embedding fallback (when the active model changes, the existing rows under a different `model` are simply skipped — there is no auto-reembed sweep yet), embedding-side reflection (the writer is only invoked by `MemoryStore.store`; reflection's own writes happen through the same path so they get embedded too, but there is no dedicated "embed everything" CLI command). All deferred items keep the wire-shape of `memory_embeddings` stable so no future migration is forced.

### Memory-v2 phase 2 — reactive link graph (opt-in)

Lives in [src/memory/links/](src/memory/links/) and is **disabled by default** (`memory.links.enabled=false` in config v13). When turned on, it gives memories a typed, directed graph layer that is grown by an end-of-turn LLM sub-call (`link-generator`) and consumed by `MemoryContextProvider` as BFS expansion on top of the BM25/cosine hits.

**Storage.** Schema v6 adds:

```
memory_links (
  from_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  to_id   INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  kind    TEXT NOT NULL,
  weight  REAL NOT NULL DEFAULT 1.0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id, kind)
)
```

Composite PK allows multiple link kinds between the same pair (a note can both `RELATES_TO` and `CONTRADICTS` another note). FK cascade fires on **either side**, so `MemoryStore.remove(id)` automatically wipes every edge touching the removed row — no orphan links. `kind` is bounded by `LINK_KINDS = { RELATES_TO, CAUSED_BY, REFERENCES, CONTRADICTS, DUPLICATES, SUPERSEDES }`; `LinkStore.add` and the parser both reject anything outside this set. Self-loops are rejected at insert time. Indexes `idx_memory_links_to` (reverse direction) and `idx_memory_links_kind` exist so BFS can walk in either direction in O(deg).

**BFS expansion.** `LinkStore.expand(seedIds, { depth, maxExpanded, kinds? })` walks **outgoing + incoming** edges at each hop so the recall layer does not need the LLM to author symmetric edges. Returns ids in BFS order with seeds excluded; deduplicated. Depth is clamped to `[1, 3]` to bound BFS fan-out; `maxExpanded` (default 50, runtime-config default 12) hard-caps the result so a hot node cannot blow up the recall set. Empty seed ⇒ empty result.

**link-generator reflection sub-call.** A standalone runner in [src/memory/links/link-generator-runner.ts](src/memory/links/link-generator-runner.ts) that fires **after** the main reflection runner returns. Composition is wrapped by `createLinkAwareReflectionRunner` — the agent loop still calls `reflectionRunner.reflect(input)`; the decorator runs base reflection first, then materialises `input.recalledMemoryIds` (added to `ReflectionInput` in phase 2 — populated from `state.recalledNotes` in `agent-loop`) into `{id, body}` candidates via `MemoryStore.get(id)` and fires the link-generator.

Anti-feedback-loop guard (mirrors phase 7a invariant 18 from MEMORY_FABRIC_V2.md §13.7.4): the parser drops every LINK whose endpoints are not in the surfaced-id allowlist for this turn. Without it, a runaway model could connect arbitrary ids and pollute the graph permanently. Self-loops, malformed lines, unknown kinds, and duplicate triples are all silently filtered — one bad line never invalidates the rest of the batch.

**Read-side integration.** `createDefaultMemoryContextProvider` takes an optional `links` block; when `memory.links.enabled=true` it calls `linkStore.expand(recalledBaseIds, …)`, hydrates the expanded ids via `MemoryStore.get`, and folds them into `recalled` after the base hits so BM25/cosine ranking is preserved at the head. The `### memory-index` section then dedupes against the expanded set. When `links` is omitted, the provider is byte-identical to phase 1B.

**Slot affinity (cross-phase invariant 2).** `LinkGeneratorRunner` rides the **same** dedicated reflection slot (`slotManager.reserveReflectionSlot()`) as the base reflection runner. The main agent slot's KV cache is never touched. When only one slot is available, both runners fall back to `slotId: -1` (no cache reuse) — still safe because the main slot is untouched.

**Locked invariants.** Pinned by [src/memory/links/link-store.test.ts](src/memory/links/link-store.test.ts), [src/memory/links/link-generator-parser.test.ts](src/memory/links/link-generator-parser.test.ts), [src/memory/links/link-generator-runner.test.ts](src/memory/links/link-generator-runner.test.ts), [src/memory/memory-schema.test.ts](src/memory/memory-schema.test.ts), [src/memory/memory-context-provider.test.ts](src/memory/memory-context-provider.test.ts):

1. **FK cascade on both sides.** Deleting either endpoint memory wipes the link in the same transaction. No orphan rows possible.
2. **Self-loops are rejected.** `LinkStore.add({fromId: a, toId: a, …})` throws `LinkValidationError`; the parser drops them silently. Self-loops add zero recall signal and break BFS termination guarantees.
3. **`link-generator` rides the reflection slot.** Cross-phase invariant 2 — never the main agent slot. No new `setInterval`s introduced; the runner is fire-and-forget after the agent reply, identical pattern to `ReflectionRunner`.
4. **Allowlist gates every persisted edge.** Parser drops links whose endpoints are not in the per-turn surfaced-id set. Without this guard the graph could grow edges between memories the LLM never saw — a feedback-loop hazard pinned ahead of phase 7a.
5. **Recall stays byte-identical when `memory.links.enabled=false`.** `createDefaultMemoryContextProvider` short-circuits without touching `LinkStore` when the optional block is missing. Phase 1B test snapshots remain valid.
6. **BFS is bounded.** Depth clamped to `[1, 3]`, `maxExpanded` caps the result, BFS expands both directions. Hot-node fan-out cannot blow up the recall set.
7. **`autoGenerate=false` still allows manual graph growth.** With `enabled=true; autoGenerate=false`, recall expansion works but the link-generator LLM call is skipped — useful when external tooling (or a future `memory.links.add` tool, deferred) is the only graph writer.
8. **Multi-hop demo lives in the test suite.** `src/memory/memory-context-provider.test.ts > "phase 2: expands recalled via link graph when enabled (multi-hop demo)"` pins the synthetic acceptance from the execution plan — only the seed matches the BM25 query, and `A → B → C` link traversal surfaces both downstream notes.

**Configuration.** Added in user config v13 — older files transparently migrate with `memory.links` populated from defaults (everything disabled).

- `memory.links.enabled` (default `false`) — master switch for both recall expansion and link generation.
- `memory.links.autoGenerate` (default `true`) — fire the link-generator after reflection. Set to `false` to keep the schema + expansion machinery without the extra LLM round-trip.
- `memory.links.expansionDepth` (default `1`) — BFS depth on recall. Clamped to `[1, 3]`.
- `memory.links.maxExpanded` (default `12`) — hard cap on expanded-id count per recall turn.
- `memory.links.maxLinksPerCall` (default `4`) — hard cap on persisted edges per link-generator call.
- `memory.links.minCandidates` (default `2`) — skip the LLM call when the surfaced set has fewer than this many ids.
- `memory.links.generatorTimeoutMs` (default `8000`) — hard timeout for the link-generator LLM call.

**Metrics.** All env-only, exported from [src/tracing/agent-metrics.ts](src/tracing/agent-metrics.ts):

- `agent.memory.link_generator` (counter, tagged by `outcome ∈ {ok, none, skipped, aborted, timeout, failed}`).
- `agent.memory.link_generator.duration_ms` (histogram).
- `agent.memory.links_written` (counter, tagged by `source ∈ {link_generator, tool, reflection}`).
- `agent.memory.link_expansion.hits` (counter, tagged by `expanded` bucket + `depth`).

**Out of scope (deferred).** Agent-facing `memory.links.add` / `memory.links.list` tools (the LLM can still grow the graph implicitly via the link-generator; explicit tool access is deferred until a use case actually demands it), weighted BFS ordering beyond the current weight-tiebreaker, graph-aware reflection (the link-generator currently consumes only `recalledMemoryIds`; consuming the **graph neighbourhood** of those ids during reflection extraction is a follow-up), and a CLI debugger (`atomic-agent memory links show`) for graph inspection. Neighbour-evolver landed in phase 3 (see below).

### Memory-v2 phase 3 — neighbor-evolver (opt-in)

A reactive metadata-refinement layer that lets a new reflection turn enrich the `tags` of **existing** memories without ever touching their `content`. Modules in [src/memory/evolution/](src/memory/evolution/) + the grammar/parser/runner pieces inside [src/memory/reflection/](src/memory/reflection/). Default disabled; opt in via `memory.evolution.enabled = true` after phase 2 is live in your config.

**Grammar.** `REFLECTION_GRAMMAR` in [reflection-grammar.ts](src/memory/reflection/reflection-grammar.ts) gained an `evolve` alternative on `entry`:

```
entry  ::= set | note | evolve
evolve ::= "EVOLVE #" digits " [tags=" taglist "]" "\n"
```

A bounded grammar shape (`digits = [0-9]+`, `taglist ::= tag ("," tag){0,9}`) keeps malformed completions cheap and the cap deterministic. Touching the grammar invalidates the **reflection slot's** KV cache for one call; the main agent slot is unaffected.

**Parser.** [reflection-parser.ts](src/memory/reflection/reflection-parser.ts) extracts EVOLVE lines into `ReflectionEvolve { targetId, addTags }`. Hardened: empty tag lists are dropped, non-positive ids rejected, malformed lines silently skipped, duplicate EVOLVE entries for the same `targetId` collapse to last-writer-wins. Lower-cases tags, drops invalid tokens, caps tag count to 10.

**Store-level surface.** `MemoryStore.evolveTags(id, addTags, { leaseMs, now? })` in [memory-store.ts](src/memory/memory-store.ts) is the single mutation entry point. The signature **does not accept** a content delta — the append-only invariant on `MemoryEntry.content` is defended at both the runner level (post-parser, content is not even extracted from the LLM line) and the store level (no SQL path can write `content`). Returns a discriminated `EvolveTagsResult`:

- `applied`             — tags grew, `updated_at` bumped.
- `skipped_lease_held`  — `consolidating_at` lease is fresh, B↔C contention guard fires.
- `skipped_no_change`   — every proposed tag was already present, `updated_at` is **not** bumped (preserves legacy FIFO eviction ordering).
- `missing`             — target row no longer exists.

Companion lease helpers: `acquireConsolidationLease(id, leaseMs, now?)` (single-writer atomic check+stamp via SQL `WHERE consolidating_at IS NULL OR consolidating_at <= ?`), `releaseConsolidationLease(id)`, `getConsolidatingAt(id)`. Phase 5's consolidator will be the only `acquire` caller; phase 3 only **reads** the lease through `evolveTags`. The `consolidating_at` column itself landed dormant in v4 (phase 1A migration) so there is **no schema change** in phase 3.

**Runner.** `NeighborEvolver` in [neighbor-evolver.ts](src/memory/evolution/neighbor-evolver.ts) is a non-LLM, fire-safe post-parser writer:

- Enforces `maxPerWrite` (default `2`) as a hard cap; overflow → `skipped_cap_hit` (the dropped directives still record metrics).
- Honours an optional `allowlist` (a `Set<number>` of surfaced ids for the current turn) — directives whose `targetId` is **not** in the set are dropped with `skipped_not_in_allowlist`. This is the anti-feedback guard (same idea as the link-generator phase 2's allowlist).
- Wraps `MemoryStore.evolveTags` and folds `MemoryValidationError` → `skipped_invalid`. Throws nothing.
- Emits one of seven structured outcomes per directive, each tagged through `AgentMetrics.recordMemoryEvolution`.

**Reflection wiring.** `ReflectionRunnerDeps.neighborEvolver?` (optional) in [reflection-runner.ts](src/memory/reflection/reflection-runner.ts). When present, the runner applies parsed `EVOLVE` directives **after** SET + NOTE writes (so a NOTE created earlier in the same completion is never the target of its own EVOLVE — the surfaced-id allowlist already excludes brand-new rows). The runner reads `input.recalledMemoryIds` (already plumbed in phase 2) and turns it into the allowlist passed to the evolver. Sequencing inside `ReflectionRunner.runOne` is now:

```
parse  →  write SET  →  write NOTE  →  link-generator (phase 2)  →  neighbor-evolver (phase 3)
```

No new LLM call. Phase 3 is pure post-parser bookkeeping on top of the same reflection completion. Bootstrap constructs the evolver only when `memory.evolution.enabled === true` and threads it into `buildReflectionRunner`.

**Locked invariants** (pinned by [src/memory/memory-store-evolve.test.ts](src/memory/memory-store-evolve.test.ts), [src/memory/evolution/neighbor-evolver.test.ts](src/memory/evolution/neighbor-evolver.test.ts), [src/memory/reflection/reflection-parser.test.ts](src/memory/reflection/reflection-parser.test.ts)):

1. **`content` is byte-stable across N evolve calls.** Cross-phase invariant 5 from MEMORY_FABRIC_V2.md §13.7.7. Pinned by both `MemoryStore.evolveTags` (`preserves content byte-stable across N evolves`) and `NeighborEvolver` (`invariant 5 — content byte-stable across N evolve calls`). No SQL path on the evolve surface ever writes `content`; the LLM grammar never carries it either.
2. **B↔C lease honoured.** `evolveTags` skips when `consolidating_at IS NOT NULL AND (now - consolidating_at) <= leaseMs`. Stale leases (`elapsed > leaseMs`) are ignored — the phase-5 consolidator is expected to release on success, but a crashed consolidator can never permanently freeze a row.
3. **Allowlist filters before applyOne.** A directive whose `targetId` is not in `input.recalledMemoryIds` never reaches `MemoryStore`. Pinned by `filters by allowlist when provided`.
4. **`maxPerWrite` cap is hard.** Directive `N+1` and beyond never call `evolveTags`. Excess is counted under `skipped_cap_hit` so dashboards can spot models that routinely propose more evolves than the budget allows.
5. **Tag-cap overflow keeps existing tags.** When the target already has `MEMORY_MAX_TAGS` (16) tags, every proposed addition is dropped silently — the store returns `skipped_no_change` and existing tags win. Pinned by `does not write past MEMORY_MAX_TAGS`.
6. **`updated_at` is not bumped on `skipped_no_change`.** Legacy FIFO eviction (`memory.eviction.utilityWeighted=false`) keeps its expected ordering when an evolve is a no-op.
7. **`enabled=false` is the default.** Older configs auto-migrate to v14 with `memory.evolution.enabled = false`; parser still recognises EVOLVE but the runner silently drops directives because `neighborEvolver` is `undefined`. Flip the flag to opt in.
8. **Schema unchanged.** Phase 3 reuses `consolidating_at` (added dormant in v4 / phase 1A). No new tables, no new migration step; `MEMORY_SCHEMA_VERSION` stays at `6`.

**Configuration.** Added in user config v14 — older files transparently migrate with `memory.evolution` populated from defaults (everything disabled).

- `memory.evolution.enabled` (default `false`) — master switch. Off ⇒ no evolver constructed, EVOLVE lines parsed and dropped.
- `memory.evolution.maxPerWrite` (default `2`) — hard cap on applied directives per reflection turn.
- `memory.evolution.leaseMs` (default `60000`) — B↔C lease window in ms.

**Metrics.** Two counters in [src/tracing/agent-metrics.ts](src/tracing/agent-metrics.ts):

- `agent.memory.evolution.applied` (counter, tagged by `session_id`).
- `agent.memory.evolution.skipped` (counter, tagged by `session_id` + `reason ∈ {lease_held, no_change, not_in_allowlist, cap_hit, missing, invalid}`).

The dual-counter shape matches the scorecard's §3.A.4 (`applied ≥ 1`) and §3.B.2 (`skipped{reason=lease_held} ≥ 1`) asserts.

**Out of scope (deferred).** `context` column on `memories` (the doc's `EVOLVE [context=...]` branch — phase 3 sticks to tags-only, which is what the scorecard tests; adding `context` is a separate schema change), automatic neighbour discovery on writes (today the LLM proposes EVOLVE targets explicitly — discovery-driven evolution depends on phase 5's clustering pass), and an agent-facing `memory.notes.evolve` tool. The consolidator-side `acquireConsolidationLease` write path lands in phase 5; phase 3 only **reads** the lease.

### Memory-v2 phase 4 — bi-temporal ProfileStore

`profile_facts` no longer overwrites on conflict. Every `ProfileStore.set` produces a **new row** and the previous active row for the same key is flipped into the supersession chain inside one SQLite transaction. The renderer (`### profile`) keeps showing only the active row; the chain is exposed to the agent via the new `memory.profile.history` tool.

**Schema v6 → v7** in [memory-schema.ts](src/memory/memory-schema.ts). The migration renames the legacy `profile_facts` to `profile_facts_legacy`, creates the v7 shape (`id INTEGER PRIMARY KEY AUTOINCREMENT`, `valid_from`, `superseded_by`, `supersedes`, `created_at`, `updated_at`), copies every legacy row into the v7 table with `valid_from = legacy.updated_at` and `superseded_by = NULL` (preserving `pinned` + `keywords`), then drops the legacy table. The migration is idempotent; restarting after a successful v7 boot is a no-op. Active-row uniqueness is enforced by the **partial unique index** `idx_profile_active_key ON profile_facts(key) WHERE superseded_by IS NULL` — the storage-layer guard for MEMORY_FABRIC_V2.md cross-phase invariant 6.

**Store-level surface** ([profile-store.ts](src/memory/profile-store.ts)):

- `set(key, value, opts?)` — always inserts a new row. When an active row for `key` exists it gets flipped in the same transaction. Because SQLite's partial unique index is **immediate, not deferred**, the writer first stamps the parent's `superseded_by` with a sentinel self-pointer (`= id`) so the partial index releases the active slot, then inserts the new row, then patches the parent's `superseded_by` to the real `newId`. The intermediate self-pointer is never visible outside the transaction. Returns a `ProfileFact` with `id`, `validFrom`, `supersedes`, `supersededBy` populated.
- `get(key)` / `list()` — return active rows only (`superseded_by IS NULL`).
- `getById(id)` — returns any row regardless of supersession (used by history walks).
- `history(key)` — returns the full chain in `valid_from ASC, id ASC` order. The active row, when present, is the last entry. Cross-key supersession chains are **not** traversed automatically — `history` is per-key on purpose so the rendered timeline matches the column header the user sees in `### profile`.
- `remove(key)` — deletes the **active** row only. Historical (superseded) rows are kept on disk so `history(key)` keeps working. The `superseded_by` self-pointer is a **soft pointer** (no FK constraint) precisely so this deletion never cascades into the historical chain.

**Cross-key supersession.** When the LLM emits `SET full_name=Alex [supersedes=name]`, the parser captures `supersedes: "name"` on the `ReflectionFact`. The reflection runner threads this through as `set(...).supersedesKey`; the store then flips both the same-key active row (if any) **and** the cross-key `name` active row to the new row. Same-key supersession always wins for the `supersedes` back-pointer payload; cross-key parents become superseded but their `supersedes` column stays `NULL` (they were not themselves replacing anything). Pinned by `profile-store-bitemporal.test.ts` ("cross-key supersession via supersedesKey opt flips the source row").

**Parser markers.** [reflection-parser.ts](src/memory/reflection/reflection-parser.ts) `extractSetMarker` was extended with two new clauses, both still semicolon-separated inside the existing trailing `[...]`:

- `supersedes=KEY` — extracts a cross-key hint. Validated against the same `KEY_PATTERN` `ProfileStore` uses, so a malformed RHS (spaces, special chars, oversized) is dropped at parse time and never reaches the writer. Pinned by `drops a malformed supersedes RHS`.
- `valid_from=now` — the only accepted literal. Any other RHS (explicit timestamp, future date, ISO string) is dropped silently. The runtime always stamps `valid_from` from the live clock so the LLM cannot rewrite past history. The field carries through to `ReflectionFact.validFrom` as `"now" | null` and is consumed by the metrics/audit path only — the store ignores it today.

The GBNF reflection grammar itself is unchanged: `value ::= [^\n]{1,200}` already accepts the marker syntax. Parser-level validation drops malformed markers without re-prompting.

**Reflection prompt.** [reflection-prompt.ts](src/memory/reflection/reflection-prompt.ts) `REFLECTION_STABLE_PREFIX` gained a "Bi-temporal versioning" paragraph teaching the LLM about the marker. This is the only prompt change in phase 4 — it invalidates the **reflection slot's** KV cache for one call. The main agent slot's stable prefix is untouched (none of phase 4's wiring leaks into `buildStablePrefix`).

**Tool: `memory.profile.history { key }`** ([profile-history.ts](src/tools/memory/profile-history.ts)). Read-only. Returns the full chain in temporal order with an `active` flag on each row and a human-readable summary line (` * [#id] ISO-time: value (active)` / ` [#id] ISO-time: value → #N`). Registered alongside `memory.profile.{set,remove,list}` when `memory.profile.enabled` is true; resource class is `pure_read` so it fans out cleanly in parallel batches. Validation errors fold into a structured `status: "error"` tool result instead of throwing.

**Reflection wiring.** `writeFacts` in [reflection-runner.ts](src/memory/reflection/reflection-runner.ts) now threads `fact.supersedes` (when present) into `ProfileStore.set` as `supersedesKey`. Same-key supersession does not need this — every same-key write auto-chains via the partial unique index path. The supersession hint is purely for cross-key cases. Sequence inside `ReflectionRunner.runOne` is unchanged:

```
parse  →  write SET  →  write NOTE  →  link-generator (phase 2)  →  neighbor-evolver (phase 3)
```

**Metrics.** New counter `agent.memory.profile.superseded` in [agent-metrics.ts](src/tracing/agent-metrics.ts), tagged by `key`, `previous_id`, `next_id`. Fires **once per parent flipped** — a cross-key supersession that touches two parents will fire twice with distinct `previous_id`s. (Today the writer fires it only on the structural same-key parent; cross-key supersession parents do not emit the metric — see `// TODO` below.)

**Locked invariants** (pinned by [profile-store-bitemporal.test.ts](src/memory/profile-store-bitemporal.test.ts), [profile-history.test.ts](src/tools/memory/profile-history.test.ts), [reflection-parser.test.ts](src/memory/reflection/reflection-parser.test.ts) phase-4 cases, [reflection-runner.test.ts](src/memory/reflection/reflection-runner.test.ts) `scenario 4.A — SET with supersedes marker produces a bi-temporal chain`):

1. **At most one active row per key.** Enforced by the partial unique index `idx_profile_active_key`. Pinned by `4.A.3 — partial unique index forbids two active rows for one key`.
2. **Every SET preserves history.** Scenario 4.A: `ru → en` produces a 2-row chain with the `ru` row marked superseded. Pinned by `scenario 4.A — language change preserves history`.
3. **`remove(key)` keeps the historical chain.** Only the active row is deleted. Pinned by `remove() deletes only the active row, history chain intact`.
4. **Legacy v6 rows migrate transparently.** `valid_from = updated_at`, `superseded_by = NULL`, `pinned` + `keywords` preserved. Pinned by `legacy v3 row migrates to v7 with valid_from = updated_at and active state`.
5. **Renderer untouched.** `### profile` filters via `list()` which already returns active-only rows. Stable-prefix bytes do not change because of phase 4.
6. **Marker validation drops malformed RHS at parse time.** `supersedes=not a valid key` → `supersedes: null`. Pinned by `drops a malformed supersedes RHS`.
7. **`valid_from` always stamped by the runtime clock.** The parser strips the literal `now`; the store reads it from `Date.now()` (or the injected `now` arg). Pinned by `drops a non-'now' valid_from RHS silently`.
8. **No new top-level config.** Phase 4 is always-on once the v7 migration has run. No feature flag. Operators can still call `memory.profile.set` with `pinned=false; keywords=...` exactly as before — the new fields are additive.

**Out of scope (deferred).** Cross-key history walks via `getById` (today `history(key)` is per-key; following `supersedes` / `supersededBy` across keys is left as a manual chain walk for the agent), `vote_score` column on `profile_facts` (phase 7a), per-parent metric emission on cross-key supersession (today only the same-key parent fires `agent.memory.profile.superseded`), an explicit `bitemporal.enabled` config flag (the schema migration is forward-only so a runtime toggle would have no on-disk effect), and `memory.profile.bitemporal.maxHistoryPerKey` capping (today the chain grows unbounded — practically bounded by reflection rate which is at most one SET per turn per key).

**TUI surface — single screen, paired daemons, opt-in onboarding.** The "Models" tab in `atomic-agent tui` renders **both** the chat catalog and the embedding catalog on the same screen, separated by a `Embedding models (N) · paired with chat daemon` header. There is **no** catalog-toggle hotkey (the earlier `e` switcher was removed in favour of a single combined cursor). Indices `[0..rows.length-1]` are chat rows; `[rows.length..rows.length+embeddingRows.length-1]` are embedding rows; the shared helper `resolveRowAt(panel, idx)` is the single source of truth for "which row is under the cursor" — both the panel component and the key-binding layer go through it.

Hotkeys are row-type-aware (resolved per-keystroke against the cursor's `LocalModelsRowRef.kind`):

- **j / k / ↑ / ↓** — move the shared cursor across the combined list.
- **Enter** on a chat row — pull (GGUF + mmproj for vision rows), or set active if already downloaded.
- **Enter** on an embedding row — pull the GGUF (auto-flips `localModels.embeddings.{enabled, modelId}` to the row), or set active if downloaded.
- **g** — chat-only GGUF pull (no-op on embedding rows; embedding models are text-only).
- **i** — chat-only info detail (no-op on embedding rows).
- **d** on a chat row — chat-scoped red-bordered remove-confirm modal (`removeConfirmId`).
- **d** on an embedding row — embedding-scoped remove-confirm modal (`embeddingRemoveConfirmId`). The two modals are mutually exclusive at the type level so a stray `y` in the chat modal can never delete an embedding GGUF, and vice versa.
- **E** (shift+e) — toggles `localModels.embeddings.enabled` without restarting any daemon. Operator chains an explicit `s` to apply.
- **s** — drives `startChatAndEmbeddingDaemons` / `stopChatAndEmbeddingDaemons` (paired start and stop — see §"Daemon pairing" below).
- **B / r / L** — backend pull, refresh, jump to LLM Logs.

**Embedding-model onboarding modal.** When a chat-model pull finishes successfully AND no embedding model is currently configured AND no embedding GGUF exists on disk, the orchestrator **defers** the daemon start and emits `local_models_embedding_onboarding_opened` with the default embedding model (`DEFAULT_EMBEDDING_MODEL_ID`, `nomic-embed-text-v1.5` today). The panel renders an accent-bordered yes/no modal:

- **y** — `orchestrator.resolveEmbeddingOnboarding(true)` pulls the default embedding model (flipping `embeddings.enabled = true`) and then starts the paired daemon.
- **n / Esc** — `orchestrator.resolveEmbeddingOnboarding(false)` skips the pull and starts only the chat daemon.

Either branch closes the modal and routes the operator back to chat (`ui_mode_set: chat`) once the start succeeds. The modal is a one-shot detour — it never re-appears after a chat-model pull if an embedding model is already on disk, even if `embeddings.enabled === false` (the operator's explicit "later" choice is respected). Pinned by [src/tui/local-models/local-models-reducer.test.ts](src/tui/local-models/local-models-reducer.test.ts) ("opens and dismisses the embedding onboarding modal") and [src/tui/local-models/local-models-key-bindings.test.ts](src/tui/local-models/local-models-key-bindings.test.ts) (`y` / `n` resolution).

**Daemon pairing on TUI start/stop.** Every TUI code path that touches the daemon flows through `LocalModelsOrchestrator.{startDaemon, stopDaemon, stopDaemonSilent}` and they are wired to the paired entry points:

- `startDaemon` → `startChatAndEmbeddingDaemons({ chat, embedding? })` — chat is fatal-on-failure, embedding is fatal-on-`buildEmbeddingStartOptions=undefined`-only-then-skip (graceful degradation contract). The skip conditions are: `embeddings.enabled=false`, `embeddings.modelId=null`, an unknown id, or the model GGUF is not on disk.
- `stopDaemon` / `stopDaemonSilent` (shutdown) → `stopChatAndEmbeddingDaemons(dataDir)` — always tries to kill both pid files. `stopDaemonSilent` is invoked from `LocalModelsOrchestrator.shutdown()` so closing the TUI tears down both daemons together.
- `autoStartIfReady` (called once at TUI launch) reuses `startDaemon`, so a fresh TUI boot starts both daemons whenever an embedding model is configured + downloaded.

**Pairing reconciliation (`ensureEmbeddingPaired`).** Beyond the symmetric start/stop path, every TUI mutation that touches embedding-side config or model files reconciles the embedding daemon to the pairing invariant — **if the chat daemon is alive, the embedding daemon must be alive iff `embeddings.enabled && modelId is a known catalog entry && GGUF is on disk`**. The helper `LocalModelsOrchestrator.ensureEmbeddingPaired({ hotSwap? })` is the single seam; it is called from:

- `pullEmbeddingModel` after a successful GGUF download (`hotSwap: true` — the new model replaces whatever the daemon was last serving, including the same-name reload edge case).
- `setActiveEmbedding` when the chosen model is already on disk (`hotSwap: true` — model id changed, possibly with a different dim).
- `toggleEmbeddingEnabled` for both directions (no `hotSwap` — `enabled=true` starts when nothing is running, `enabled=false` stops when running).
- `autoStartIfReady` after adopting an externally-started chat daemon (no `hotSwap` — only fills in a missing embedding side, never preempts a healthy one).

When the chat daemon is not running, `ensureEmbeddingPaired` is a no-op: the next paired `startDaemon` call (or `autoStartIfReady` on a cold TUI) handles both sides atomically via `startChatAndEmbeddingDaemons`, which is the cheaper path. The helper uses `startEmbeddingDaemon` / `stopEmbeddingDaemon` (single-side primitives) rather than the paired orchestrator so chat is never inadvertently bounced mid-conversation. All failures degrade gracefully — the embedding side reports the error to the runtime feed and falls back to FTS5-only recall; chat keeps running. Pinned by [src/tui/local-models/local-models-orchestrator-pairing.test.ts](src/tui/local-models/local-models-orchestrator-pairing.test.ts) (five cases: start-when-paired, no-op-when-chat-down, hot-swap, master-switch-off, adoption-pairs).

The "LLM Logs" tab tails `llama-embed.log` next to the chat log in the same viewport (separator: `── llama-embed.log ──`) when the file exists — a missing embedding log is silently skipped so chat-only operators see no difference. `LocalModelsOrchestrator` is the only TUI module that touches `getEmbeddingDaemonStatus` / `startChatAndEmbeddingDaemons` / `pullEmbeddingModel` / `resolveEmbeddingOnboarding` — the orchestrator-as-seam invariant from the chat side extends verbatim.

The three channels share one SQLite file `<stateDir>/memory.sqlite` (separate from `sessions.sqlite`):

| Channel        | Storage table          | Read path (auto)                 | Write path                          |
| -------------- | ---------------------- | -------------------------------- | ----------------------------------- |
| `ProfileStore` | `profile_facts`        | `### profile` (gated)            | `memory.profile.set` + reflection   |
| `MemoryStore`  | `memories` + FTS5      | `### recalled` + `### memory-index` | `memory.notes.store` + reflection|
| Reflection     | n/a — it writes to both| n/a                              | end-of-turn fire-and-forget LLM call|

`MEMORY_SCHEMA_VERSION = 3`; idempotent migrations in [src/memory/memory-schema.ts](src/memory/memory-schema.ts).

### ProfileStore (durable facts, in the prompt tail)

- **Shape.** `profile_facts (key TEXT PK, value TEXT, pinned INTEGER, keywords TEXT, updated_at INTEGER)`. CRUD in [src/memory/profile-store.ts](src/memory/profile-store.ts).
- **Pinned vs contextual.** `pinned=true` (default) facts are always rendered; `pinned=false` facts are rendered only when at least one of their `keywords` hits the current `userMessage` (case-insensitive substring match). Filter applied by [src/memory/profile-renderer.ts](src/memory/profile-renderer.ts), gated by `memory.profile.contextualKeywordGate` (default `true`).
- **Prompt placement.** Rendered as `### profile` in the **variable tail** (after optional `### loaded-skills`, before `### memory-index` / `### session-facts` / `### recalled`). Never the stable prefix. `build-prompt.test.ts` pins the invariant by hashing the stable prefix across profile edits.
- **Budgeting.** `truncateToTokens(content, memory.profile.maxTokens)` (default `512`) with `[truncated]` marker; tokens subtracted from the effective conversation cap in [src/prompt/token-budget.ts](src/prompt/token-budget.ts).
- **Live snapshot.** `AgentLoop` reads `profileStore.list()` once per step via the optional `profileFactsProvider` and threads it into `StepContext.profileFacts` → `buildPrompt`.
- **Tools.** `memory.profile.set { key, value, pinned?, keywords? }`, `memory.profile.remove { key }`, `memory.profile.list {}`.

### MemoryStore (FTS5 freeform notes)

- **Shape.** `memories (id INTEGER PK, content, tags, source, scope, working_dir, created_at, updated_at)` + `memories_fts` virtual table (`porter unicode61`). CRUD in [src/memory/memory-store.ts](src/memory/memory-store.ts). Hard cap `memory.notes.maxEntries` (default `1000`); FIFO eviction by `(updated_at ASC, id ASC)` on overflow.
- **Auto-injection.** Two new tail sections (rendered by [src/memory/notes-renderer.ts](src/memory/notes-renderer.ts)):
  - `### recalled` — top-K BM25 hits against the current `userMessage`. Driven by `memory.recallInjection.{enabled, k, previewChars, maxTokens}` (defaults `k=3`, `previewChars=160`, `maxTokens=400`).
  - `### memory-index` — compact `#id [tags] preview` pointer rows. Driven by `memory.index.{enabled, limit, previewChars, maxTokens}` (defaults `limit=20`, `previewChars=60`, `maxTokens=300`).
  - The two sections are **deduplicated by id** — anything in `### recalled` is filtered out of `### memory-index`.
- **Pre-fetch.** Done once per turn by [src/memory/memory-context-provider.ts](src/memory/memory-context-provider.ts), invoked from `agent-loop.runTurn` before the per-step loop starts. Results land in ephemeral `SessionState.recalledNotes` / `SessionState.memoryIndex`. `stripEphemeral` in [src/session/session-store.ts](src/session/session-store.ts) removes them before snapshot persistence — they are recomputed every turn.
- **Tools.** `memory.notes.store { content, tags?, scope?, workingDir? }`, `memory.notes.recall { query? | id?, scope?, workingDir?, k? }` (`{ id }` is direct lookup for `#42` pointers from `### memory-index`), `memory.notes.forget { id }`. The bulk corpus is **never** dumped wholesale into the prompt.

### Reflection (async end-of-turn memory formation)

- **When.** Fired at the end of every `AgentLoop.runTurn` after `assistant_reply` is emitted. **Fire-and-forget**, never awaited. `abortPending({ sessionId: state.id })` runs at the start of the next `runTurn` so at most one reflection is in flight **per session**; reflections on other sessions are never aborted as a side effect (load-bearing for cross-session parallelism — see §"Concurrency contract").
- **What.** A micro-prompt with its own small stable prefix asks the model to extract durable facts from the last `USER`/`ASSISTANT` exchange. Output is GBNF-constrained to either `NONE` or a bounded list of two flavours:
  - `SET key=value` (pinned fact) or `SET key=value [pinned=false; keywords=a,b,c]` (contextual fact). Caps at `memory.reflection.maxFactsPerCall` (default `3`).
  - `NOTE freeform observation [tag1, tag2]` → into `MemoryStore` with implicit `reflection` tag. Master switch `memory.reflection.autoStoreNotes` (default `true`); cap at `memory.reflection.maxNotesPerCall` (default `2`, set to `0` to disable).
- **KV-cache invariant.** Reflection runs on a **dedicated llama-server slot** reserved at bootstrap via `slotManager.reserveReflectionSlot()`. The main agent slot is never touched. When only one slot is available, reflection falls back to `slotId: -1` (no cache reuse).
- **Writes.** Parsed entries flow through the same validators as the explicit tools (`ProfileStore.set`, `MemoryStore.store`); invalid entries are logged and skipped without failing the whole call.
- **Observability.** `agent.memory.reflection` counter tagged by `outcome` (`ok | none | failed | aborted | timeout`) plus `agent.memory.reflection.latency_ms` histogram. Logs: `reflection.fired`, `reflection.ok`, `reflection.none`, `reflection.aborted`, `reflection.timeout`, `reflection.failed`.
- **Code.** [src/memory/reflection/](src/memory/reflection/) — `reflection-prompt`, `reflection-grammar`, `reflection-parser`, `reflection-runner`.

### Configuration

All keys under `memory.*` in the user config and [src/config/config-schema.ts](src/config/config-schema.ts). Full table in [MEMORY.md §8](MEMORY.md). The most relevant for tuning:

- `memory.profile.{enabled, maxTokens, contextualKeywordGate}`
- `memory.reflection.{enabled, timeoutMs, maxFactsPerCall, autoStoreNotes, maxNotesPerCall}`
- `memory.notes.{enabled, maxEntries, maxContentChars, recallDefaultK}`
- `memory.recallInjection.{enabled, k, previewChars, maxTokens}`
- `memory.index.{enabled, limit, previewChars, maxTokens}`
- `paths.memoryDbFile` — resolved to `<stateDir>/memory.sqlite`.

### Invariants

1. **Stable prefix is untouched by memory writes.** All three memory-aware sections (`### profile`, `### recalled`, `### memory-index`) live strictly in the variable tail. Pinned by `build-prompt.test.ts`.
2. **Reflection never blocks or crashes the loop.** `ReflectionRunner.reflect()` is fire-safe — errors are logged and counted; the agent-visible reply is already returned before reflection starts. Pinned by `slot-manager.test.ts` (slot isolation) and `reflection-runner.test.ts` (error swallowing).
3. **Notes corpus is never dumped wholesale.** Only top-K (`### recalled`) and pointer-only (`### memory-index`) rows go into the prompt; full bodies require an explicit `memory.notes.recall { id }`.
4. **Bounded growth.** Per-call write caps (`maxFactsPerCall` / `maxNotesPerCall`) + storage cap (`maxEntries` + FIFO) + tail caps (`maxTokens` per section) + contextual gating for profile facts ⇒ both the SQLite file and the rendered tail are bounded under all input distributions.
5. **Single validator path per writer.** All `ProfileStore` writes (tool or reflection) go through `ProfileStore.set` validators; all `MemoryStore` writes go through `MemoryStore.store` validators. There is no second back door.
6. **Ephemeral session fields are not persisted.** `SessionState.recalledNotes` / `memoryIndex` are stripped by `stripEphemeral` before `SessionStore` writes the snapshot — they are recomputed each turn against the current user message.

### Explicit out-of-scope

Episodic summaries, `topic`/`expires_at` columns, embeddings / semantic search, importance scoring, content-based deduplication of notes, and secret redaction are deliberately deferred. See [MEMORY.md §10](MEMORY.md) for the known-limitations list.

## Concurrency contract

Every entry point into the runtime — CLI, TUI, HTTP, sidecar, scheduler, and webhook ingress — funnels through one primitive: `TurnController` in [src/runtime/turn-controller.ts](src/runtime/turn-controller.ts). It is the **only** path into `AgentLoop.runTurn`. The defunct `src/http/turn-hub.ts` is gone; its global serialization invariants are now enforced per session.

### Invariants (locked, pinned by [src/runtime/turn-controller.test.ts](src/runtime/turn-controller.test.ts))

1. **Per-session FIFO.** At most one `runTurn` is in flight per `sessionId`. Two concurrent `enqueue` calls on the same session run strictly in submission order.
2. **Cross-session parallelism.** Different `sessionId`s run concurrently — there is no global queue. This is the property Option 4 (cron / wakeups) was designed to consume.
3. **No preemption, no priorities.** Scheduler-origin submissions queue behind in-flight user submissions on the same session, and vice versa. All `TurnOrigin`s (`cli | tui | http | sidecar | scheduler`) are equal citizens.
4. **Per-session event hook.** `submission.eventHook` is installed before `run()` starts and cleared in `finally`. A hook on session A never sees events from session B. Routing is keyed by `sessionId` stored in an `AsyncLocalStorage` set in `bootstrap.ts` around every `executeTurn` call.
5. **Per-session recorder.** `currentRecorder` is no longer a global pointer; recorders are lazy-created per `sessionId` and dispatched via the same `AsyncLocalStorage`.
6. **Aborted submission rejects fast.** `submission.signal` races the queue wait — a cancelled submission rejects without ever calling `run()`.

### Ownership of shared resources

| Resource | Owner | Safe under cross-session parallelism? |
|---|---|---|
| `PlaywrightBackend` | The active turn on each session | **Yes per-session** — `TurnController` guarantees one turn touches the browser at a time within a session. **Cross-session sharing is an accepted product constraint:** there is one browser profile per process, so concurrent sessions see the same window. Cron-driven sessions must account for this. |
| `SlotManager` | Each `runTurn` (acquire-per-step) | **Yes** — `acquire` for a single session is sequential by `TurnController` invariant; different sessions have separate slot assignments and the round-robin pointer is integer-mutating. See doc-comment in [src/llm/slot-manager.ts](src/llm/slot-manager.ts). |
| `ApprovalGate` | Per-session pending request | **Yes** — at most one pending approval per session by design. |
| `ProfileStore` / `MemoryStore` / `SessionStore` | Anything holding a handle | **Yes** — all three use `better-sqlite3`, which is **synchronous**: there is no race window between read and write inside a single statement, so concurrent sessions are safe. **This is a load-bearing assumption.** Replacing the driver with an async one would require a redesign. |
| `ReflectionRunner.pending` | Per-session `Map<sessionId, AbortController>` | **Yes** — reflection on session A is never aborted by reflection on session B. `agent-loop.runTurn` calls `reflectionRunner.abortPending({ sessionId: state.id })` at the start of every turn so a stale reflection from the previous same-session turn cannot race the next one. `abortPending()` with no argument cancels every in-flight reflection (used at runtime shutdown). |
| Trace recorder | Per-session, dispatched via `AsyncLocalStorage` | **Yes** — no global pointer to mix traces across sessions. |

### What the scheduler / webhook paths may and may not assume

- **May** enqueue any session via `runtime.turnController.enqueue({ origin: "scheduler", … })` or `runtime.runTurn(session, msg, { origin: "scheduler" })`.
- **May** introspect via `turnController.isBusy(sessionId)` / `busySessionIds()` and decide between "enqueue and wait" or "skip this tick".
- **May not** preempt user turns or claim a separate priority queue — there is none.
- **May not** assume exclusive browser ownership across sessions; the browser is shared at process scope (see table).
- **Must not** hold a stale `SessionState` reference between `enqueue` and `run`. `executeTurn` writes its result to `sessionStore`; the correct pattern is to **re-read the latest session inside the queued callback** (see [src/sidecar/main.ts](src/sidecar/main.ts) `send_message` for the canonical example).

### Extension points

- `TurnController.isBusy(sessionId)` / `busySessionIds()` — observability hook for UI and scheduler.
- `TurnController.emit(sessionId, event)` — single dispatch path for `AgentLoopEvent` to the per-session hook.
- `runtime.executeTurn(session, msg, opts)` — bypasses the queue. Used by sidecar from inside an already-acquired `enqueue` callback so it does not deadlock against itself. CLI / TUI / HTTP go through the public `runtime.runTurn` instead.

### Risk (acknowledged)

The three existing callers (CLI / HTTP / sidecar) relied on subtle hook timing through `TurnHub` / inline `onAgentEvent`. The hook contract on `TurnController` matches the defunct `TurnHub.runExclusive` byte-for-byte (hook installed before `run()`, cleared in `finally`), so single-session callers are observably identical. New surface tests cover the cross-session and same-session-FIFO behaviour: [src/http/openai-chat-completions.test.ts](src/http/openai-chat-completions.test.ts), [src/sidecar/send-message-concurrency.test.ts](src/sidecar/send-message-concurrency.test.ts), [src/memory/reflection/reflection-runner.test.ts](src/memory/reflection/reflection-runner.test.ts).

## Durable tasks

A minimal durable queue of deferred `runTurn` submissions lives in [src/tasks/](src/tasks/). It is the **persistence layer** for any future scheduler / cron / agent-driven self-scheduling — but it ships **without** a background ticker on purpose: drains are always triggered explicitly (CLI `atomic-agent task run`, HTTP `POST /api/tasks/drain`) or implicitly right after `create()` when `tasks.runOnCreate=true` (the default).

A task is exactly one record:

```ts
TaskRecord = {
  id, sessionId, userMessage, maxSteps,
  status: "pending" | "running" | "completed" | "failed" | "blocked" | "cancelled",
  origin: "cli" | "tui" | "http" | "sidecar" | "scheduler" | "agent",
  attempts, maxAttempts, lastError, lastErrorCategory,
  createdAt, updatedAt, startedAt, completedAt,
}
```

Stored in a separate SQLite file `<stateDir>/tasks.sqlite` (no cross-file FKs to `sessions.sqlite` — `sessionId` validity is checked at runtime by `TaskRunner` and a missing session marks the task `blocked` with `session_not_found`). Schema version `1`, idempotent migrations in [src/tasks/task-schema.ts](src/tasks/task-schema.ts).

### Lifecycle

```
pending --(markRunning)--> running
running --(success)--> completed
running --(retryable, attempts < maxAttempts)--> pending   [retry loop]
running --(retryable, attempts == maxAttempts)--> failed
running --(grammar | tool failure)--> blocked              [permanent — same input, same wall]
running --(cancelled signal)--> cancelled
pending --(cancel())--> cancelled
```

Failure classification is delegated to `classifyFailure` from [src/llm/reliability/](src/llm/reliability/) (the LLM reliability policy below) so retry semantics never drift from the rest of the runtime.

### Drain semantics

`TaskRunner.drainPending(opts?)` is the one-shot drain primitive:

1. Pull every `pending` task (optionally `?session=`).
2. Group by `sessionId`.
3. For each group: drain sequentially. Each call into `runtime.runTurn(..., { origin: "scheduler" })` enters `TurnController` per-session FIFO and serialises against any user turn that lands mid-drain.
4. Across groups: `Promise.all` — different sessions drain in parallel, inheriting cross-session parallelism from the Concurrency contract above for free.

Inter-attempt sleep on retry uses `nextDelayMs(attempts, { initialMs, maxMs })` from [src/tasks/task-backoff.ts](src/tasks/task-backoff.ts) (`min(initialMs * 2^attempt, maxMs)`). Sleep happens **between attempts**, never blocking the per-session lock for longer than necessary.

### Locked invariants (pinned by tests)

1. **Tasks always run via `runtime.runTurn(..., { origin: "scheduler" })`.** Never via `executeTurn` (which bypasses the controller). Per-session FIFO + cross-session parallelism are inherited from §"Concurrency contract".
2. **Retries are turn-level only.** The same `userMessage` is replayed; partial-tool replay is out of scope. Step-level retries inside a single `runTurn` remain the LLM reliability layer's responsibility.
3. **`TaskRunner` never holds a `SessionState` reference between attempts.** It always re-reads via `sessionStore.load(sessionId)` inside the next attempt — same pattern as the sidecar `send_message` callback.
4. **`cancel(id)` is idempotent on terminal rows** — returns the existing record unchanged, so HTTP `DELETE` and CLI `cancel` are safe to retry.
5. **Stale recovery is one-shot.** `taskStore.recoverStale(staleAfterMs)` runs exactly once on bootstrap; there is **no background sweeper**. Process crash between `markRunning` and the terminal write leaves a `running` row that the next bootstrap flips back to `pending`.
6. **`tasks.enabled=false` ≠ `TaskStore` is absent.** The store is always constructed (it owns a SQLite handle that must be closed in `shutdown`), but `drainPending` is a no-op and HTTP routes return 404. Mirrors `memory.profile.enabled` from Memory fabric.

### Surfaces

| Surface | Path | Notes |
|---|---|---|
| HTTP | `POST/GET /api/tasks`, `GET/DELETE /api/tasks/:id`, `POST /api/tasks/:id/run`, `POST /api/tasks/drain` | [src/http/route-tasks.ts](src/http/route-tasks.ts). Returns 404 for every route when `tasks.enabled=false`. |
| CLI | `atomic-agent task list \| show \| create \| cancel \| run` | [src/cli/task-command.ts](src/cli/task-command.ts). All subcommands except `run` open `TaskStore` directly and exit fast; `run` boots the full `createAgentRuntime` and tears it down on the way out. |
| Metrics | `agent.tasks.{created,started,completed,failed,blocked,cancelled,retried}` counters + `agent.tasks.{attempts,duration_ms}` histograms | Emitted from `TaskRunner` at status transitions. |

### Configuration

All under `tasks.*` in [src/config/config-schema.ts](src/config/config-schema.ts) — env-only (operational tuning, not user config file material):

- `tasks.enabled` (default `true`) — master switch.
- `tasks.maxAttempts` (default `3`) — retry budget per task.
- `tasks.backoffInitialMs` (default `1000`) / `tasks.backoffMaxMs` (default `60000`) — exponential capped backoff.
- `tasks.runOnCreate` (default `true`) — auto-drain immediately after `create()`. Detached, fire-and-forget.
- `tasks.staleAfterMs` (default `300000`) — `recoverStale` threshold.
- `paths.tasksDbFile` — resolved to `<stateDir>/tasks.sqlite`.

### Out of scope (deferred)

Task graphs / dependencies, workflow primitives (`kind != "runTurn"`), secret redaction in `userMessage` / `lastError`, per-origin priorities, distributed scheduler / leader election across multiple processes. Scheduling itself, webhook ingress, and agent-side `tasks.*` tools shipped in Option 4 — see next section.

## Background autonomy

Option 4 ships time-based scheduling, webhook ingress, and agent self-scheduling as a thin layer on top of §"Durable tasks". It **does not** change the `runTurn` contract or add any timers outside of `src/scheduler/`.

### Schedules on `TaskRecord`

`TaskRecord` carries an optional `schedule: TaskSchedule | null` where `TaskSchedule` is a discriminated union:

```ts
TaskSchedule =
  | { kind: "at"; at: number }                         // Unix ms
  | { kind: "cron"; expression: string; tz?: string }  // parsed via cron-parser
  | { kind: "interval"; everyMs: number }              // lower bound config.tasks.minIntervalMs
```

`resolveScheduledFor(schedule, fromMs)` in [src/tasks/task-schedule.ts](src/tasks/task-schedule.ts) is the **only** path that turns a schedule into an absolute `scheduledFor` (Unix ms). It is used both by `TaskRunner.create` on insert and by recurring requeue on completion. `cron-parser` is imported **only** from this file.

Schema bumped `TASK_SCHEMA_VERSION` 1 → 2, idempotent migration adding columns `schedule_kind`, `schedule_value` (JSON), `scheduled_for`, `recurring`, `last_scheduled_at`, `trigger_source` and a partial index `idx_tasks_due(status, scheduled_for) WHERE status='pending'` — the only path the scheduler uses to find work.

### Scheduler

[src/scheduler/scheduler.ts](src/scheduler/scheduler.ts) exposes one class with `start()`, `stop()`, `tickOnce()` (for tests). One `setInterval` per runtime, period = `config.tasks.schedulerTickMs` (default 5000), batch = `config.tasks.schedulerBatch` (default 10). On each tick:

1. Guard `running` flag (no reentry).
2. `await taskRunner.runDue(Date.now(), batch)`.
3. Errors are swallowed + logged + counted in `agent.scheduler.tick_errors`; interval keeps running.

Wired in [src/runtime/bootstrap.ts](src/runtime/bootstrap.ts) after `taskStore.recoverStale`. `shutdown()` awaits `scheduler?.stop()` **before** `taskStore.close()` to prevent a final tick from touching a closed handle.

### Session lifecycle for scheduled tasks

This is the most load-bearing rule in Option 4 — respect it when adding new code paths.

| Task shape | `sessionId` at `create()` | `sessionId` before `runTurn` |
|---|---|---|
| User-provided `sessionId` (CLI / HTTP / sidecar) | As provided | Unchanged. |
| One-shot, no `sessionId`, no `schedule` (or `schedule.kind="at"`) | `NULL` | `TaskRunner.runOne` lazily creates a fresh ephemeral session, **writes it back to the row**, then calls `runTurn`. Once written, stable for the row's lifetime. |
| Recurring (`cron` / `interval`), no `sessionId` | A fresh persistent session, created immediately by `sessionFactory` | Reused across every firing. If the session row is missing (user deleted it), `runOne` auto-recreates, logs a warning, emits `agent.tasks.session_recreated`, and continues. |

`requeueRecurring` atomically resets `attempts`, `last_error`, `started_at`, `completed_at` and rearms `scheduled_for` — **but never touches `session_id`**. This invariant is pinned by [src/tasks/task-store.test.ts](src/tasks/task-store.test.ts).

### Wake reason on session metadata

`TaskRunner.stampWakeReason` writes `session.metadata.wakeReason = { source, taskId, webhookName?, at }` before every `runTurn`, then persists the session. `source ∈ { "user", "scheduler", "webhook", "agent" }` mirrors `TaskRecord.triggerSource`. The reserved keys under `session.metadata` are documented in [src/session/session-state.ts](src/session/session-state.ts):

- `wakeReason` — set by `TaskRunner`, audit-only in this milestone (not rendered into the prompt).
- `recurringTask`, `scheduleKind` — set on persistent sessions owned by recurring tasks.
- `webhookName`, `webhookPersistent` — set on sessions created via `POST /api/webhooks/:name`.
- `ephemeralTask`, `scheduledBy` — set on lazy-created one-shot sessions.

None of these are currently rendered into the stable prefix; if you start rendering them, pin the stable-prefix hash test first.

### Webhook ingress

`POST /api/webhooks/:name` in [src/http/route-webhooks.ts](src/http/route-webhooks.ts) resolves `config.webhooks[name]` and returns 404 when missing or when `tasks.enabled=false`. On success:

1. Optional `x-webhook-secret` check against `config.webhooks[name].secret`.
2. `userMessage` = `evaluateWebhookTemplate(userMessageTemplate, body)` with `{{body.<json.path>}}` substitutions (see [src/http/webhook-template.ts](src/http/webhook-template.ts) — minimal substitution, no expression eval, length-capped).
3. `sessionId` resolved per `sessionMode`: `ephemeral` (leave null — `TaskRunner` creates fresh on `runOne`), `persistent` (read/create via [webhook-session-store.ts](src/http/webhook-session-store.ts), file-backed JSON in `<stateDir>/webhook-sessions.json`), `named` (require explicit `sessionId` in config).
4. `taskRunner.create({ origin: "http", triggerSource: "webhook", sessionId, userMessage, schedule })` — the route **never** calls `runTurn` directly.
5. HTTP 202 with `{ taskId }`.

Webhook config lives in the **user config file** (per-name declarative — ops shouldn't need a redeploy to add a new webhook). `USER_CONFIG_VERSION` bumped 2 → 3 with transparent `v2 → v3` migration (`webhooks: {}` default).

### Agent tools (`tasks.*`)

Five tools in [src/tools/tasks/](src/tools/tasks/), gated by `config.tasks.agentToolsEnabled`. Registered from [src/runtime/bootstrap.ts](src/runtime/bootstrap.ts) next to `registerMemoryTools`. The current session id is read via `AsyncLocalStorage` (`currentSessionId` from [src/runtime/session-context.ts](src/runtime/session-context.ts)).

| Tool | Writeable | Session resolution | Schedule |
|---|---|---|---|
| `tasks.schedule` | yes | **Inherits current session** by default; `newSession=true` opts into a fresh one | `at` (absolute) or `inSeconds` (relative) — validated via `parseOneShotSchedule` |
| `tasks.cron` | yes | **Always** a fresh persistent session (recurring ⇒ continuity, never mix with user thread) | `{ kind: "cron", expression, tz? }` |
| `tasks.list` | no | Defaults to current session; filters by `status` (CSV) and `limit` (capped at 200) | — |
| `tasks.cancel` | yes | — | — |
| `tasks.show` | no | — | — |

`TaskValidationError`s from `parseOneShotSchedule` / `task-schedule` are caught inside each tool's `run` method and surfaced as a structured `{ status: "error", details }` result — they never escape as thrown exceptions.

Descriptors in [src/prompt/tool-descriptors.ts](src/prompt/tool-descriptors.ts); the GBNF grammar [grammars/tool-call.gbnf](grammars/tool-call.gbnf) was extended with a `tasks-tool` branch covering all five names.

### Configuration (env-only under `tasks.*`)

Extending §"Durable tasks" config:

- `tasks.schedulerEnabled` (default `true`, env `ATOMIC_AGENT_TASKS_SCHEDULER_ENABLED`).
- `tasks.schedulerTickMs` (default `5000`).
- `tasks.schedulerBatch` (default `10`).
- `tasks.agentToolsEnabled` (default `true`, env `ATOMIC_AGENT_TASKS_AGENT_TOOLS_ENABLED`).
- `tasks.minIntervalMs` (default `1000`) — lower bound for `{ kind: "interval" }`.

Webhook config lives under `webhooks.*` in the user config file, not env.

### Metrics (tasks)

Added to [src/tracing/agent-metrics.ts](src/tracing/agent-metrics.ts):

- Counters: `agent.tasks.scheduled`, `agent.tasks.recurring_requeued`, `agent.tasks.session_recreated`, `agent.tasks.session_auto_created`, `agent.scheduler.ticks`, `agent.scheduler.tick_errors`, `agent.webhooks.received`.
- Histograms: `agent.scheduler.batch_size`, `agent.scheduler.tick_duration_ms`.
- Webhook tag: `webhook_name`.

### CLI

`atomic-agent task create` now accepts scheduling flags:

- `--at <unix-ms>` — one-shot at absolute time.
- `--cron "<expr>" [--tz <iana>]` — recurring cron (allocates a persistent session eagerly, so this path boots the full runtime).
- `--every <seconds>` — recurring interval.
- `--session <id>` is now optional; omit for one-shot ephemeral or let recurring allocate its own.

`atomic-agent task list` gained `schedule` and `next-run` columns.

`atomic-agent task tick` — one-shot `runDue(now, limit=Infinity)` for ops debugging (does not start the long-lived ticker).

### TUI surface (Tasks tab)

The `atomic-agent tui` debug pane exposes the task store as a first-class tab. State slice `state.tasksPanel` in [src/tui/tui-state.ts](src/tui/tui-state.ts) drives three view modes — `list`, `detail`, `create` — plus an optional `cancelConfirm` modal.

Module map:

- [src/tui/tasks/tasks-panel-state.ts](src/tui/tasks/tasks-panel-state.ts) — state types + `createInitialTasksPanelState`.
- [src/tui/tasks/tasks-actions.ts](src/tui/tasks/tasks-actions.ts) — `TasksAction` union (`tasks_*` prefix); folded into the root `TuiAction` via a mixin.
- [src/tui/tasks/tasks-reducer.ts](src/tui/tasks/tasks-reducer.ts) — slice reducer invoked first by the root reducer, returns `null` to fall through.
- [src/tui/tasks/tasks-filter.ts](src/tui/tasks/tasks-filter.ts) — pure filter+sort (status bucket, substring search).
- [src/tui/tasks/tasks-summary.ts](src/tui/tasks/tasks-summary.ts) — `TaskRecord → TaskSummaryRow` with time/interval formatters.
- [src/tui/tasks/cron-preview.ts](src/tui/tasks/cron-preview.ts) — thin wrapper over `peekNextFirings` (still keeps `cron-parser` behind `task-schedule.ts`).
- [src/tui/tasks/tasks-form-validator.ts](src/tui/tasks/tasks-form-validator.ts) — create-form parser; errors surfaced as `preview.error`, never thrown.
- [src/tui/tasks/tasks-orchestrator.ts](src/tui/tasks/tasks-orchestrator.ts) — the only module that calls `runtime.taskStore` / `runtime.taskRunner` from TUI code. Owns a 5s `setInterval` refresher (opt-in on first entry to the tab).
- [src/tui/tasks/tasks-key-bindings.ts](src/tui/tasks/tasks-key-bindings.ts) — dedicated hotkey layer; disables the editor when `activeTab === "tasks"` so single-char hotkeys (`j/k/n/c/R/r/a/f/o`) never conflict with typing.
- Components in [src/tui/components/tasks-*.tsx](src/tui/components/).

Keyboard contract:

- **List mode** — `j/k` (or arrows) move cursor, Enter opens detail, `n` opens create form, `c` cancels (y/n confirm for recurring), `R` runs now, `r` manual refresh, `a` toggles auto-refresh, `f` cycles status filter.
- **Detail mode** — `o` opens the task's session, `R` runs now, `c` cancels, Esc returns to list.
- **Create form** — Tab/Shift+Tab cycles focus (`kind → expression → tz? → message → submit`), Left/Right cycles kind when focused, Enter submits on the submit field or advances otherwise, Ctrl+Enter submits from any field, Esc closes.
- **Cancel confirm modal** — `y` confirms, `n`/Esc dismisses.

Slash commands:

- `/tasks` — jump to the Tasks tab.
- `/task new` — jump + open the create form.
- `/task cancel <id>` — enqueue a cancellation (skips the modal — intentional, the operator knows the id).
- `/task run <id>` — execute one attempt via `TaskRunner.runOne`.

Locked invariants (pinned by [src/tui/tasks/tasks-reducer.test.ts](src/tui/tasks/tasks-reducer.test.ts), [src/tui/tasks/tasks-filter.test.ts](src/tui/tasks/tasks-filter.test.ts), [src/tui/tasks/tasks-form-validator.test.ts](src/tui/tasks/tasks-form-validator.test.ts), [src/tui/tasks/cron-preview.test.ts](src/tui/tasks/cron-preview.test.ts), [src/tui/tasks/tasks-summary.test.ts](src/tui/tasks/tasks-summary.test.ts), [src/tui/commands/slash-command-handler.test.ts](src/tui/commands/slash-command-handler.test.ts)):

1. **`TasksOrchestrator` is the only TUI module that touches `runtime.taskStore` / `runtime.taskRunner`.** Components dispatch actions; actions reach the orchestrator via `TuiAppCallbacks`.
2. **`cron-parser` stays behind `task-schedule.ts`.** TUI only imports `peekNextFirings` via `cron-preview.ts`.
3. **The editor is disabled on the Tasks tab.** Single-char hotkeys are free to use letter keys; Tab re-enters the debug-tab cycler unless a create form or cancel modal is open.
4. **Form validation is pure.** Neither the reducer nor the keybinding layer throws; all errors surface as `preview.error` or `runtime_info` lines.
5. **Firings feed is best-effort.** The orchestrator diffs task snapshots between refresh ticks; it is never the source of truth for billing or auditing — that stays in metrics + traces.

### Locked invariants (pinned by tests)

Pinned by [src/scheduler/scheduler.test.ts](src/scheduler/scheduler.test.ts), [src/tasks/task-runner.test.ts](src/tasks/task-runner.test.ts), [src/tasks/task-store.test.ts](src/tasks/task-store.test.ts), [src/http/route-webhooks.test.ts](src/http/route-webhooks.test.ts), [src/runtime/bootstrap.test.ts](src/runtime/bootstrap.test.ts), and colocated tool tests:

1. **`Scheduler` is the only new periodic timer.** Never `setInterval` outside `src/scheduler/`.
2. **Webhooks never call `runTurn` directly.** Always `TaskRunner.create`.
3. **Recurring requeue preserves `session_id`.** Only auto-recreation on `session_not_found` may overwrite it.
4. **One-shot `session_id` is stable after the first attempt.** Lazy-created sessions must be written back to the row before `runTurn`.
5. **Partial-index `idx_tasks_due` is the only scheduler path.** No full scans.
6. **`tasks.enabled=false` disables everything.** Scheduler doesn't start, webhook routes 404, agent tools unregistered.
7. **`cron-parser` is isolated behind `task-schedule.ts`.** Future replacement touches one file.
8. **`session.metadata.wakeReason` is audit-only.** Survives restart, never rendered into the prompt.
9. **Agent tool validation errors are structured, not thrown.** Including nested errors from schedule parsing.

## Vision (multimodal input)

Image recognition is an opt-in feature wired exclusively through the new provider abstraction in [src/llm/provider/](src/llm/provider/). The text agent loop is unchanged — vision lives outside the conversation transcript, exposed only via the `vision.describe` tool.

### Surfaces

| Layer | Module | Responsibility |
|---|---|---|
| Detection | [src/llm/model-profile.ts](src/llm/model-profile.ts) `detectVisionSupport` | Inspects `/props` and stamps `ModelProfile.vision = { supported, source }`. Source priority: `modalities.vision` (current llama.cpp surface) → `has_multimodal` → `multimodal` → `mmproj` (legacy fallbacks). The first source that reports support wins; the resolved tag is surfaced through `ProviderCapabilities.visionSource` for diagnostics. |
| Provider | [src/llm/provider/llm-provider.ts](src/llm/provider/llm-provider.ts) | `LlmProvider` interface — `name`, `capabilities`, `describeImage(request)`. Future non-llamacpp adapters implement this surface. |
| Adapter | [src/llm/provider/llama-server-provider.ts](src/llm/provider/llama-server-provider.ts) | Speaks the OpenAI-compatible `/v1/chat/completions` endpoint with `messages: [{role:"user", content:[{type:"image_url", image_url:{url:"data:<mime>;base64,…"}}, {type:"text", text:prompt}]}]`. Sends `chat_template_kwargs: {enable_thinking: false}` + `reasoning_format: "none"` so Gemma-4 / other thinking-capable models do not park the answer in a separate `thinking` channel. Sniffs JPEG/PNG/WebP/GIF magic bytes for the `data:` MIME. **Does not pass `slot_id`** — chat-completions manages its own slots; the main agent slot and the reflection slot are not touched. `capabilities` is a getter (not a frozen field) that reads the live profile through `getProfile()`, so vision turns on the moment `ModelProfileManager` swaps to a multimodal profile (load-bearing for the TUI's `deferLlamaHealthCheck=true` cold start). |
| Tool | [src/tools/vision/describe.ts](src/tools/vision/describe.ts) + [load-image.ts](src/tools/vision/load-image.ts) | `vision.describe { prompt, path? \| paths? }`. Loads images from disk (`png`/`jpg`/`jpeg`/`webp`/`gif`), enforces per-call and per-image caps, calls the provider, returns a `CompressedToolResult` like any other tool. |
| Wiring | [src/runtime/bootstrap.ts](src/runtime/bootstrap.ts) | Constructs the `LlamaServerProvider` only when `config.vision.enabled === true`, threading a `getProfile` closure that resolves through `ModelProfileManager` (with the cold-start `profile` as fallback). When the provider is present, `vision.describe` stays in `effectiveToolDescriptors` for the entire session — capability is checked dynamically at call time, not at bootstrap. The descriptor is filtered out only when `config.vision.enabled === false`, so the prompt never advertises a tool the runtime cannot actually invoke. |
| Catalog | [src/local-llm/models-catalog.ts](src/local-llm/models-catalog.ts) | `LocalModelDef.supportsVision` + `mmprojUrl` / `mmprojFilename` / `mmprojFileSizeGb` for downloads. |
| Installer | [src/local-llm/model-installer.ts](src/local-llm/model-installer.ts) | `downloadMmproj` / `isMmprojDownloaded` for projector files alongside GGUF weights. |
| Daemon launch | [src/local-llm/daemon-lifecycle.ts](src/local-llm/daemon-lifecycle.ts) `buildLlamaServerArgs` | Pure builder for the `llama-server` argv. When `mmprojFile` is set, the builder emits `--mmproj <path>` **and** a fixed image-token / batch budget: `--image-min-tokens 560 --image-max-tokens 560 --ubatch-size 1024 --batch-size 2048`. The 560-token budget is the lowest tier in Unsloth's published Gemma-4 grid (70 / 140 / 280 / 560 / 1120) that produces stable general-purpose multimodal chat — at the default ~70 image tokens the clip embedding is too noisy and the model hallucinates instead of describing. The ubatch/batch bumps cover Gemma-4's non-causal vision attention which assumes the entire image-token batch fits in a single ubatch. Both managed-mode start paths (CLI `atomic-agent models start` and TUI `LocalModelsOrchestrator.startDaemon`) auto-resolve the projector via `isMmprojDownloaded` + `resolveMmprojFilePath` when `config.vision.enabled && model.supportsVision`. When the projector is missing or vision is disabled the server boots text-only and the vision flags are not emitted. |
| TUI | [src/tui/local-models/](src/tui/local-models/) | Pull modes `with-mmproj` (default), `gguf-only` (`g` hotkey), `mmproj-only` (Enter on a model whose GGUF is already present but mmproj is missing). |

### Locked invariants

1. **Vision calls never touch the main agent or reflection slots.** `LlamaServerProvider.describeImage` posts to `/v1/chat/completions` without a `slot_id` — chat-completions manages its own slots and never reuses the main agent slot or the reflection slot. The legacy `/completion` + `image_data` + `[img-N]` placeholder path is gone; sending a plain prompt without a chat template was load-bearing for the previous Gemma-4 hallucination bug. Pinned by [src/llm/provider/llama-server-provider.test.ts](src/llm/provider/llama-server-provider.test.ts) (asserts URL ends in `/v1/chat/completions`, body uses `image_url` content blocks, `chat_template_kwargs.enable_thinking === false`).
2. **Vision lives outside the conversation transcript.** `vision.describe` returns a `CompressedToolResult`; no changes to `ConversationTurn` or the variable tail. The model receives the description as a normal `### latest-result` block.
3. **Text completion bypasses the provider.** Only the vision verb goes through `LlmProvider`. The agent loop continues to call `LlamaServerClient.complete` / `completeStream` directly so llama.cpp-specific knobs (`slot_id`, `cache_prompt`, GBNF) stay first-class.
4. **Vision tool registration is config-only; capability is dynamic.** `registerVisionTools` short-circuits on `config.vision.enabled === false` or on a missing provider, but **does not** check `capabilities.vision` at registration time — that check would freeze the wrong answer when the runtime starts before the first `/props` probe lands (the TUI's `deferLlamaHealthCheck=true` cold start). `LlamaServerProvider.describeImage` re-checks `this.capabilities.vision` on every call against the live profile and throws `VisionUnsupportedError` when the active model is text-only. The bootstrap filters the descriptor out of `DEFAULT_TOOL_DESCRIPTORS` only when no provider was constructed — so disabling vision via config still produces a clean prompt.
5. **Grammar always allows `vision.describe`.** [grammars/tool-call.gbnf](grammars/tool-call.gbnf) keeps `vision-tool` as a sibling alternative regardless of registration. When the descriptor is absent the model never selects this branch in practice; if it ever did, the registry would reject the call cleanly.
6. **Vision daemon flags are tied to `--mmproj`.** `buildLlamaServerArgs` emits `--image-min-tokens 560 --image-max-tokens 560 --ubatch-size 1024 --batch-size 2048` together with `--mmproj <path>` — never independently. Removing the bundle will silently regress to the ~70-image-token default that the Gemma-4 / Qwen-VL families confabulate on. Pinned by [src/local-llm/daemon-lifecycle.test.ts](src/local-llm/daemon-lifecycle.test.ts).
7. **`vision.describe` is `tier: "frequent"` in the descriptor catalog.** The full `argsSchema` and `examples` are always rendered into the stable prefix, not the variable `### loaded-tools` tail. Demoting the tier would cause the agent to emit malformed first-shot calls (e.g. missing `prompt`) until the rare-tool auto-expansion kicks in on error. Pinned by [src/prompt/default-tool-descriptors-b.ts](src/prompt/default-tool-descriptors-b.ts).

### Configuration (`vision.*`)

User-config block (`config.json` v6; `ensureUserConfigFileSync` actively migrates older files on bootstrap — when the on-disk `version` is below `USER_CONFIG_VERSION`, the parsed contents are atomically rewritten with the bumped version and any newly-added blocks filled from `USER_CONFIG_DEFAULTS`. Existing user values are preserved verbatim and a single `migrated config vN → vM` line is emitted to stderr for audit. Read-only call sites (`readUserConfigFileSync`) stay non-mutating):

- `vision.enabled` (default `true`) — master switch. Set to `false` to skip provider construction and tool registration entirely.
- `vision.autoDetect` (default `true`) — when `true`, the provider's capabilities follow `ModelProfile.vision.supported`. When `false`, the provider trusts the operator and reports `vision: true` regardless of `/props`; useful when running a custom backend that does not expose multimodal flags.
- `vision.maxImagesPerCall` (default `4`) — per-call ceiling enforced both in the tool and in the provider (`describeImage` throws if exceeded).
- `vision.maxImageBytes` (default `10485760`) — per-image byte cap enforced after `loadImageFile` reads from disk.

### Out of scope (deferred)

Image inputs as first-class `ConversationTurn` payloads (the user pasting an image directly into the chat instead of going through the `vision.describe` tool), paste-from-clipboard / drag-and-drop ingestion in TUI, mmproj checksum verification, per-projector tuning of the image-token budget (today the 560-token tier is uniform across vision models), and an OpenAI-API provider adapter are all out of scope for this milestone. The provider abstraction is intentionally narrow — only `describeImage` — and will grow when a second adapter actually lands.

## Telegram remote-control channel

`atomic-agent` ships an opt-in Telegram bot that acts as a **remote control for the same single-user agent runtime** — not a separate process, not a multi-user service. When the user starts the TUI / `atomic-agent run` / `atomic-agent serve`, an enabled Telegram channel boots automatically and shares the runtime's `TurnController`, `ApprovalGate`, `SessionStore`, `MemoryStore`, and `ProfileStore`. Code lives in [src/channels/telegram/](src/channels/telegram/) (runtime side) and [src/tui/telegram/](src/tui/telegram/) (TUI panel).

### Lifecycle

The channel is **always constructed** at bootstrap when the `telegram` config block exists; only `start()` is gated on `config.telegram.enabled`. This is load-bearing for live-control: the TUI / slash commands can flip `enabled` on at runtime without restarting the host. When `enabled=true` but `TELEGRAM_BOT_TOKEN` is missing, the channel transitions to `down` with `lastError: "missing TELEGRAM_BOT_TOKEN"` instead of crashing the runtime. Errors are reported through `runtime.onChannelStatus` (a `ChannelStatus` sink in [src/runtime/channel-status.ts](src/runtime/channel-status.ts)) so CLI / TUI / sidecar can surface them without parsing logs.

Single-instance enforcement is a `<stateDir>/telegram.lock` file ([telegram-lockfile.ts](src/channels/telegram/telegram-lockfile.ts)); the second runtime to boot fails fast at `start()` with a `lock_held` reason. `stop()` releases the lock; bootstrap shutdown awaits `telegramChannel.stop()` before closing SQLite handles.

### Polling — explicit AGENTS.md carve-out

The Telegram client uses **long-polling** (`grammy.Bot.start()` under the hood). Long-polling is normally forbidden by §"Background autonomy" — `Scheduler` is the only periodic timer in the runtime, and §"Concurrency contract" disallows additional internal queues. Telegram is the **single bounded exception**:

- The polling loop is owned exclusively by the grammy adapter inside [telegram-bot-factory.ts](src/channels/telegram/telegram-bot-factory.ts); no other code in `src/channels/telegram/` calls `setInterval` / `setTimeout` for periodic work.
- Every Telegram update is processed in a **fire-and-forget** wrapper (`bot.on("message:text", …) → void handler(update).catch(…)`); the polling loop never blocks on `runTurn`. This is what makes `/cancel` work mid-turn.
- Updates always materialise into a normal `runtime.runTurn(..., { origin: "telegram" })` call. Telegram never writes to `SessionStore`, `ApprovalGate`, or `TurnController` directly. Per-session FIFO + cross-session parallelism are inherited from §"Concurrency contract" for free.
- The carve-out is bounded to grammy. New channels (Slack, WhatsApp, …) will need a similar one-time review before adopting long-polling, and **must not** route through this code path; the `src/channels/<name>/` folder is the seam.

### Sessions

Telegram has its own dedicated session, persisted as a pointer in `<stateDir>/telegram-session.json` ([telegram-session-pointer.ts](src/channels/telegram/telegram-session-pointer.ts)). The TUI session and the Telegram session never collide. `/new` from Telegram rotates the pointer; the TUI's `/new` does not. The pointer file is the only Telegram-specific session metadata; everything else lives in the shared `sessions.sqlite`.

### Approvals

When a `runtime.runTurn` call originated on Telegram (`{ origin: "telegram" }`), `ApprovalRouter` ([src/approval/approval-router.ts](src/approval/approval-router.ts)) routes the `ApprovalRequest` to `ApprovalBridge` ([approval-bridge.ts](src/channels/telegram/approval-bridge.ts)) instead of falling through to the host UI. The bridge:

- Sends a 2-button inline keyboard (`✅ Approve` / `❌ Deny`) to the owner's DM as plain text (no MarkdownV2 — escaping rules are easy to get wrong with tool names containing backticks / underscores).
- Validates the callback `userId` against the live `ownerUserId` mirror — a stale callback from a previous owner is rejected.
- Auto-denies after 8 minutes (`config.telegram.approvalTimeoutMs`) and edits the original message to `⏱ timed out — auto-denied` with the buttons removed.
- Folds button-click / timeout / external-cancel into a single `approvals.resolve()` call; double-resolution is prevented by a `pending` map check.

Known UX gap (deferred): `/cancel` aborts the turn but the inline-keyboard message lingers because the bridge does not know it was cancelled externally. Documented inline in `approval-bridge.ts`.

### Live control

`TelegramChannel` exposes a small live-control API used by the TUI panel and `/telegram` slash commands:

- `setEnabled(enabled)` — flips `config.telegram.enabled` in `config.json` and starts/stops the channel.
- `setOwnerUserId(id | null)` — updates the live mirror + `config.json`; restarts when the channel is `up` so inbound-handler / approval-bridge re-capture the new value.
- `setToken(token | null)` — writes `TELEGRAM_BOT_TOKEN` into `<stateDir>/.env` via [dotenv-writer.ts](src/config/dotenv-writer.ts) (atomic, mode `0600`, never logged), mirrors into `process.env`, and restarts when `up`.
- `restart()` — clean stop + start; useful to reload a token without flipping `enabled`.
- `startPairing(timeoutMs?)` / `cancelPairing()` — opens a 60s window where the first eligible private DM claims ownership ([pairing-mode.ts](src/channels/telegram/pairing-mode.ts)). Only allowed when the channel is `up`. Inbound handler calls `tryClaimForPairing` **before** the owner check so an unowned bot can be paired.

Persistence is split: `enabled` and `ownerUserId` live in `<stateDir>/config.json`; the token lives only in `<stateDir>/.env`. The token is never copied into config, never echoed in TUI, and never logged on error paths (errors are scrubbed via `scrubErrorMessage` in [telegram-channel-types.ts](src/channels/telegram/telegram-channel-types.ts)).

### TUI panel

The "Telegram" tab in `atomic-agent tui` mirrors the channel state and exposes the live-control API. Architecture matches the existing Tasks / Skills tab pattern (see §"TUI surface (Tasks tab)"):

- [tui-telegram-orchestrator.ts](src/tui/telegram/tui-telegram-orchestrator.ts) is the **only** TUI module that imports `TelegramChannel` or reads `process.env.TELEGRAM_BOT_TOKEN`. The token never leaves this file: `setToken` calls into the channel by value; the UI mirrors its presence as a `hasToken: boolean`.
- The reducer ([telegram-panel-reducer.ts](src/tui/telegram/telegram-panel-reducer.ts)) is pure; every side effect (channel calls, persistence, timers) lives in the orchestrator.
- The pairing countdown ticker is owned by the orchestrator and is cleared on shutdown / resolution / dismissal. Pinned by [tui-telegram-orchestrator.test.ts](src/tui/telegram/tui-telegram-orchestrator.test.ts).

Slash commands: `/telegram enable|disable`, `/telegram start|stop` (alias for the same), `/telegram restart`, `/telegram pair`, `/telegram token` (opens the masked modal), `/telegram clear-token`, `/telegram clear-owner`. The `e` / `t` / `o` hotkeys mirror enable-toggle / token-prompt / pairing.

### Configuration

`config.telegram` (user config, v10) — see [src/config/config-schema.ts](src/config/config-schema.ts):

- `telegram.enabled` (default `false`) — master switch for `start()`.
- `telegram.ownerUserId` (default `null`) — numeric Telegram user id authorised to send DMs to the bot. When `null`, the bot ignores all messages and approvals are dropped.
- `telegram.parseMode` (default `"html"`) — agent-reply rendering mode. `"html"` converts the agent's markdown to Telegram's HTML subset via `convertMarkdownToTelegramHtml` and sends with `parse_mode: "HTML"` + `disable_web_page_preview: true`; on HTTP 400 ("can't parse entities") the same chunk is retried once as plain text so a formatter regression never silently swallows a reply. `"plain"` disables formatting entirely (legacy behaviour). Slash-command acks, infra messages (`Turn cancelled.`, `(no reply)`), and failure envelopes (`Turn failed [...]: ...`) **always** send as plain text regardless — only "agent content" is formatted, "channel infrastructure" stays unformatted so a stray `<` in an error message can never collide with the HTML grammar. MarkdownV2 is intentionally unsupported (escape surface too wide for typical LLM output). Added in config v10; older files transparently get `"html"`.
- `telegram.approvalTimeoutMs` (default `480000` = 8 min) — `ApprovalBridge` auto-deny window.

`TELEGRAM_BOT_TOKEN` (env / `<stateDir>/.env`) — bot token. Stored only in `.env` with mode `0600`; never copied into `config.json` or logged.

### Metrics

[src/tracing/agent-metrics.ts](src/tracing/agent-metrics.ts):

- Counters: `agent.telegram.up`, `agent.telegram.down` (tagged by `outcome` + short `reason`), `agent.telegram.messages_received`, `agent.telegram.messages_sent`, `agent.telegram.approvals_resolved` (tagged by `resolver` + `approved`).
- The `messages_*` counters track agent-visible inbound (post owner-check, post slash-command-shortcut) and one-per-reply outbound, **not** raw Telegram updates / `sendMessage` chunks.

### Outbound formatting (HTML mode)

Agent replies are rendered as Telegram HTML by default ([config v10](src/config/config-schema.ts), `telegram.parseMode = "html"`). The path is:

- [markdown-to-html.ts](src/channels/telegram/markdown-to-html.ts) is a pure converter that maps a deliberately narrow LLM-friendly markdown subset (headings → `<b>`, bold/italic/strikethrough, inline + fenced code, links, lists, blockquotes) into Telegram's HTML subset (`<b>`, `<i>`, `<u>`, `<s>`, `<code>`, `<pre>`, `<a>`, `<blockquote>`). All non-tag text is HTML-escaped (`<`, `>`, `&`); link `href`s are validated against an `(https?|tg|mailto):` allowlist so unsafe schemes degrade to escaped plain text instead of becoming `<a>` tags.
- [outbound-sender.ts](src/channels/telegram/outbound-sender.ts) `sendOutbound` accepts `parseMode: "plain" | "html"`. The chunker always operates on raw input text (line-break aware, identical to plain mode); the conversion runs **per chunk** so an unbalanced markdown delimiter that straddles a chunk boundary degrades to literal text rather than producing a corrupt HTML tag. HTML chunks are sent with `parse_mode: "HTML"` and `disable_web_page_preview: true` (so a stray bare URL in the agent's reply does not unfurl an unwanted preview card).
- On HTTP 400 with a "can't parse entities" / "unsupported start tag" / "can't find end of" description, the same chunk is retried **once** as plain text and the `parseFallbacks` counter on `OutboundSendResult` increments. Other 400s drop the chunk like any non-429 error. This is the load-bearing safety net: a formatter regression never silently swallows a reply.

### Locked invariants

Pinned by [src/runtime/bootstrap.test.ts](src/runtime/bootstrap.test.ts), [src/channels/telegram/telegram-channel.test.ts](src/channels/telegram/telegram-channel.test.ts), [src/channels/telegram/inbound-handler.test.ts](src/channels/telegram/inbound-handler.test.ts), [src/channels/telegram/approval-bridge.test.ts](src/channels/telegram/approval-bridge.test.ts), [src/channels/telegram/pairing-mode.test.ts](src/channels/telegram/pairing-mode.test.ts), [src/channels/telegram/markdown-to-html.test.ts](src/channels/telegram/markdown-to-html.test.ts), [src/channels/telegram/outbound-sender.test.ts](src/channels/telegram/outbound-sender.test.ts), [src/config/dotenv-writer.test.ts](src/config/dotenv-writer.test.ts), [src/tui/telegram/telegram-panel-reducer.test.ts](src/tui/telegram/telegram-panel-reducer.test.ts), [src/tui/telegram/tui-telegram-orchestrator.test.ts](src/tui/telegram/tui-telegram-orchestrator.test.ts):

1. **Polling carve-out is scoped to grammy.** `setInterval` / long-polling outside `telegram-bot-factory.ts` is forbidden in `src/channels/telegram/`. Other channels must repeat the carve-out review.
2. **Telegram updates always go through `runtime.runTurn`.** Never directly into `SessionStore`, `ApprovalGate`, or `TurnController`.
3. **The token never leaves `src/channels/telegram/` or [tui-telegram-orchestrator.ts](src/tui/telegram/tui-telegram-orchestrator.ts).** UI state mirrors only the boolean `hasToken`; reducer actions never carry the value. Errors are scrubbed.
4. **`TelegramChannel` is always constructed when the `telegram` config block exists.** Bootstrap sets `runtime.telegramChannel` regardless of `enabled`; the live-control API stays callable from the TUI without a host restart.
5. **Pairing bypasses the owner check.** Inbound handler calls `tryClaimForPairing` **before** filtering by `ownerUserId` — the only path where a non-owner DM is allowed to claim ownership.
6. **Approval routing is per-session.** `ApprovalRouter.setForSession(sessionId, handler)` binds the Telegram session id to `ApprovalBridge`; everyone else falls through to the host UI handler. A fallback collision between two channels on the same session is intentionally not supported.
7. **`grammy` is imported from one file only.** [telegram-bot-factory.ts](src/channels/telegram/telegram-bot-factory.ts). Future replacement of the Telegram client touches one file.
8. **Only agent replies are formatted.** Slash-command acks (`/help`, `/status`, `/new`, `/cancel`), infra messages (`Turn cancelled.`, `(no reply)`), failure envelopes (`Turn failed [<category>]: ...`), pairing welcomes, and approval-keyboard text always send as plain text regardless of `telegram.parseMode`. The carve-out keeps a stray `<` in an error message from colliding with the HTML grammar and keeps the operator's mental model clean: formatted text == agent content, plain text == channel infrastructure.
9. **HTML conversion is tag-allowlisted.** `convertMarkdownToTelegramHtml` only emits tags from `{b, i, u, s, code, pre, a, blockquote}` and only `(https?|tg|mailto):` schemes for `<a href>`. New tag emission requires extending both the converter and the allowlist in [markdown-to-html.ts](src/channels/telegram/markdown-to-html.ts).
10. **Plain-text fallback on HTTP 400 'can't parse entities'.** When `parseMode === "html"`, a parse-rejected chunk is retried once with `parse_mode` stripped and the original raw markdown body — not the formatted HTML — so the operator sees the LLM's intent instead of the broken tags. `parseFallbacks` is surfaced separately from `dropped` for metrics + regression detection.

### Out of scope (deferred)

Multi-user pairing flows, per-chat session isolation, MarkdownV2 rendering (the escape surface is too wide for typical LLM output and `parse_mode: "MarkdownV2"` rejects the whole message on a single stray reserved char — see §"Outbound formatting"), structured menu / command surfaces beyond plain text, message editing for streaming output, file uploads (image / document ingestion through Telegram), webhook ingress as a Telegram-specific endpoint (the generic `/api/webhooks/:name` path is the existing surface), and a generic `Channel` abstraction (Slack / WhatsApp adapters) are all deferred. The seam is `src/channels/<name>/`; only extract shared interfaces when a second concrete channel actually lands.

## LLM reliability policy

Two narrow retry layers sit between the agent loop and `llama-server`. Both are deliberately bounded and never replay already-executed tool calls:

1. **Parser retry (step-executor).** If the first `parseToolCall` on a completion throws, the executor calls the unary `llmComplete` exactly once more with the same prompt/slot and re-parses. A `parse_retry` event is emitted for observability. If the second attempt also fails, the original error (with a raw-output preview) is thrown. The streaming path always falls back to unary for the retry so partial SSE deltas are not double-emitted.
2. **Transport retry (LlamaServerClient).** `complete()` and the initial pre-body fetch of `completeStream()` are wrapped in a bounded retry governed by `llama.completionRetries` (default 3) and `llama.completionRetryBackoffMs` (default 150ms, exponential with ±20% jitter). Retries fire **only** for network errors (`LlamaServerError.status === null`) and HTTP 5xx. Grammar/validation 4xx and abort signals short-circuit immediately. Once the SSE body starts streaming, no further retries happen — the conversation state on the server is considered indeterminate.

### Failure taxonomy

Every terminal failure the agent loop surfaces is normalised into a canonical `LlmFailureCategory` before `step_error` / `loop_failed` fire. The classes live in [src/llm/reliability/](src/llm/reliability/) and carry specialised fields for postmortem use.

| Category    | Class                | When it fires                                                                                         | Invariants                                                                                       |
| ----------- | -------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `transport` | `TransportError`     | `LlamaServerError` with `status === null` or `status >= 500` (after the bounded retry is exhausted).  | Carries `status` and `url`. Transport retries already fired; runtime does not retry again here.  |
| `grammar`   | `GrammarError`       | `LlamaServerError` 4xx, or `ToolCallParseError` that survives the one-shot parser retry.              | Carries `rawPreview` of the completion body so postmortems can diagnose without replaying SSE.   |
| `model`     | `ModelError`         | `detectModelFailure` returns `truncated` / `empty` / `no_stop` on the initial or retry completion.    | **Never retried in-place** — the same prompt would reproduce the same wall. Parser retry skipped. |
| `tool`      | `ToolExecutionError` | Tool missing from the registry, or any unexpected error escaping the tool dispatch path.              | Carries `tool` name. Runtime tool failures from `registry.invoke` are folded into `CompressedToolResult { status: "error" }` and do **not** reach this category. |
| `cancelled` | `CancelledError`     | `ctx.signal.aborted` is true, or the caught error is an `AbortError` / message mentions `aborted`.    | The agent loop closes the turn with `reason: cancelled` and status `cancelled`, not `failed`.    |

`classifyFailure(err)` is the single source of truth for mapping raw thrown values into the taxonomy; `LlmFailure` instances short-circuit the classifier. `step-executor` wraps every escape with the correct subclass before the `step_error` event fires, and `agent-loop` classifies at the outer catch so `loop_failed` always carries `category` even for legacy errors.

### Observability propagation

`category` is plumbed through every observability surface:

- **Events.** `step_error.category` and `loop_failed.category` are mandatory fields on the `AgentLoopEvent` union.
- **Traces.** `TraceError.category` on the append-only NDJSON stream (see [src/tracing/trace/trace-event.ts](src/tracing/trace/trace-event.ts)).
- **Metrics.** `AgentMetrics.recordLlmFailure({ sessionId, category })` increments `agent.llm.failure` tagged by category — fired exactly once per failed turn from the agent-loop outer catch.
- **TUI.** `agent-event-reducer` renders `! [${category}] ${message}` in the step feed and `failed [${category}]: ${message}` in the run-status line.
- **Sidecar protocol.** `session_failed.category` and `error.code = step_error:<category>` for the Tauri host.
- **OpenAI SSE.** Atomic-extension clients receive `{ error, category }`; OpenAI-compatible clients receive `error.type = agent.<category>` (the `type` field is a loose string in the OpenAI error envelope).

## Traceability and replay

Every run produces an append-only NDJSON trace at `<stateDir>/traces/<sessionId>.ndjson` — one event per line. Tracing is on by default for `atomic-agent run` / TUI / `atomic-agent serve`, and off by default in sidecar mode so the Tauri host decides whether to opt in.

Emitted `TraceEvent` types (see [src/tracing/trace/trace-event.ts](src/tracing/trace/trace-event.ts)):

- `session_started` — carries `workingDir` and optional `metadata`.
- `turn_started` / `turn_finished` — per macro-turn, with `reason` / `stepCount` / `durationMs`.
- `step_started` / `step_finished` — per inference step.
- `prompt_captured` — `{ stablePrefixHash, tail, tokens: { total, stablePrefix, tail }, slotId, cacheReused }`. The stable prefix is stored only as its salted hash (via `hashPrefix` from [src/llm/slot-manager.ts](src/llm/slot-manager.ts)) so trace files stay compact across steps; the variable tail is stored verbatim.
- `llm_completion` — full completion `content` + `reasoningContent` + `timing`, with `attempt: 1 | 2` (attempt 2 == parse retry).
- `tool_invocation` — executed tool call with args, status, summary, and optional details.
- `parse_retry`, `loop_detected`, `error`, `trace_truncated` — diagnostics.

Invariants:

- **Append-only.** Sinks never rewrite past lines. `trace_truncated` is a synthetic final marker when the per-session cap (`tracing.trace.maxBytesPerSession`, default 10 MiB) is hit; further events are dropped silently.
- **Per-session file.** One NDJSON per `sessionId`; no cross-session mixing.
- **Monotonic `seq`.** Every event carries a monotonic in-session sequence starting at `0`.
- **No redaction yet.** Secret redaction is an explicit NON-goal of this milestone; treat trace files as sensitive local artefacts.

CLI:

- `atomic-agent trace list [--limit N]` — most recent trace files in `<stateDir>/traces/`.
- `atomic-agent trace show <sessionId> [--step N] [--raw]` — pretty-print the chronology. `--raw` includes the full prompt tail and completion content; otherwise they are summarised.
- `atomic-agent trace export <sessionId> [--format ndjson|json]` — dump the file as-is (ndjson) or as a JSON array.
- `atomic-agent trace replay <sessionId> [--step N]` — rebuild the stable prefix from the current runtime (tools / capabilities / skills / persona) and compare its hash to the recorded `stablePrefixHash`. Drift means the upper prompt changed since recording — useful for postmortem when cache hits dropped.

Replay lives in [src/replay/](src/replay/). It is a **prompt-drift postmortem**, not a simulator: it does not reproduce LLM non-determinism or external world state (browser, filesystem). `replayInference` (programmatic, not wired to the CLI yet) can optionally rerun `LlamaServerClient` with the recorded prompts for regression tests across llama-server upgrades.
