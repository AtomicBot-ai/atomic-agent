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
2. **Stable prefix.** The prompt template has the shape `[system] [tools] [capabilities] [skills] [session] [world] [conversation]`. Everything above `session` must stay byte-stable within a session — this is what `cache_prompt + slot_id` on `llama-server` relies on.
3. **One step per inference.** No reasoning loops inside a single LLM call. The runtime drives the loop.
4. **Grammar-constrained tool calls.** The sidecar sends a GBNF grammar with every completion request that must produce a tool call.
5. **No global singletons.** Dependencies are passed explicitly. `getConfig()` is the only exception.
6. **Session is multi-turn chat only.** A session is a long-lived chat: `user message → 0..N tool steps → reply` is a macro-turn, multiple turns share one `SessionState.turns[]`. Two terminals exist — `reply` ends the turn, `finish` ends the whole session. All three frontends (CLI `run`, TUI, sidecar) go through `runtime.runTurn` only; there is no one-shot goal mode.

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
| `src/prompt/` | Prompt builder, stable prefix, token budget |
| `src/session/` | Session state + sqlite persistence |
| `src/agent/` | Agent loop + plan generator + step executor |
| `src/tools/` | Tool registry + individual tools. OS tools: `shell.run`, `fs.read` (w/ `offset`/`limit`/`lineNumbers`), `fs.write`, `fs.list`, `fs.glob`, `fs.grep` (bundled ripgrep), `fs.edit` (atomic string replace), `fs.read_document` (PDF/DOCX/XLSX/RTF/ODT/PPTX/legacy .doc → plain text via pure-JS), `fs.archive.list` / `fs.archive.read_entry` / `fs.archive.extract` (zip/tar/tar.gz/gz via pure-JS; zip-slip + bomb guards), `fs.hash` (md5/sha1/sha256/sha512 streaming), `fs.diff` (unified diff, jsdiff), `fs.patch` (dry-run default, all-or-nothing apply), `fs.watch` (chokidar one-shot, timeout-capped), `git.status` / `git.log` / `git.diff` / `git.show` / `git.blame` / `git.branch` (read-only shell-out with structured parse), `proc.list` / `proc.kill` (ps/tasklist + approval), `http.request` (curl + host allowlist + `config.http.approvalMode`), `clipboard.*`, `window.*`, `notify`. |
| `src/compressor/` | Result compressor, log summariser |
| `src/sandbox/` | git worktree + sandboxed command runner |
| `src/approval/` | Approval gate and event wiring |
| `src/telemetry/` | Structured logger + metrics + trace recorder (`src/telemetry/trace/`) |
| `src/replay/` | Trace-based replay: drift detection + optional LLM re-inference |

## Build & test

```bash
npm install
npm run lint    # tsc noEmit
npm test        # vitest run
npm run build   # compile to dist/
```

The CLI entry is `src/cli/index.ts`; the sidecar entry is `src/sidecar/main.ts`.

## External llama-server

`atomic-agent` never starts a `llama-server`. It assumes the server is reachable at `ATOMIC_AGENT_LLAMA_URL` (default `http://127.0.0.1:8080`). When the server is unreachable, the sidecar emits an `llm_unavailable` event and the runtime remains available for session management, skills, and non-LLM host operations.

## Current memory model

Today the runtime persists session-scoped state only:

- `SessionState.turns[]` for the full multi-turn transcript
- `knownFacts[]` for compact session facts
- `loadedSkills[]` for skill bodies loaded via `skill.view`
- `worldSnapshot` for compressed browser state

`SessionState.turns[]` stores the full history in memory and in the sessions DB unchanged. Prompt-time compression happens only at the `buildPrompt` boundary via `packConversation`: older turns get folded into a single deterministic `summary: N older turns dropped (...)` line so the variable tail of the prompt stays bounded without losing traceability. The visible tail always includes the latest `user` turn.

Prompt-section caps live in the config:

- `agent.tokenBudget` — compact ceiling for the upper prompt (stable prefix + session facts/skills).
- `agent.conversationMaxTokens` (default 32000) — safety-net cap for the `### conversation` section; typical sessions stay well under it.
- `agent.worldSnapshotMaxTokens` (default 8000) — safety-net cap for the `### world` section; the snapshot is already compressed by `aria-compressor`, so this only clips pathological cases with a `[truncated]` marker.

At bootstrap `LlamaServerClient.fetchProps()` reads the model's physical `n_ctx` (from `default_generation_settings.n_ctx`, with a root `n_ctx` fallback) and stores it on `ModelProfile.contextWindow`. `buildPrompt` then clamps the effective conversation cap to the actual available room so the prompt cannot overflow llama-server regardless of how large the user-configured cap is. If llama-server is restarted with a different `n_ctx`, restart the runtime.

There is currently no dedicated workspace-memory, retrieval, embeddings, or resource-summary subsystem in `src/`. Do not describe those modules as implemented unless they are added to the codebase first.

## LLM reliability policy

Two narrow retry layers sit between the agent loop and `llama-server`. Both are deliberately bounded and never replay already-executed tool calls:

1. **Parser retry (step-executor).** If the first `parseToolCall` on a completion throws, the executor calls the unary `llmComplete` exactly once more with the same prompt/slot and re-parses. A `parse_retry` event is emitted for observability. If the second attempt also fails, the original error (with a raw-output preview) is thrown. The streaming path always falls back to unary for the retry so partial SSE deltas are not double-emitted.
2. **Transport retry (LlamaServerClient).** `complete()` and the initial pre-body fetch of `completeStream()` are wrapped in a bounded retry governed by `llama.completionRetries` (default 3) and `llama.completionRetryBackoffMs` (default 150ms, exponential with ±20% jitter). Retries fire **only** for network errors (`LlamaServerError.status === null`) and HTTP 5xx. Grammar/validation 4xx and abort signals short-circuit immediately. Once the SSE body starts streaming, no further retries happen — the conversation state on the server is considered indeterminate.

## Traceability and replay

Every run produces an append-only NDJSON trace at `<stateDir>/traces/<sessionId>.ndjson` — one event per line. Tracing is on by default for `atomic-agent run` / TUI / `atomic-agent serve`, and off by default in sidecar mode so the Tauri host decides whether to opt in.

Emitted `TraceEvent` types (see [src/telemetry/trace/trace-event.ts](src/telemetry/trace/trace-event.ts)):

- `session_started` — carries `workingDir` and optional `metadata`.
- `turn_started` / `turn_finished` — per macro-turn, with `reason` / `stepCount` / `durationMs`.
- `step_started` / `step_finished` — per inference step.
- `prompt_captured` — `{ stablePrefixHash, tail, tokens: { total, stablePrefix, tail }, slotId, cacheReused }`. The stable prefix is stored only as its salted hash (via `hashPrefix` from [src/llm/slot-manager.ts](src/llm/slot-manager.ts)) so trace files stay compact across steps; the variable tail is stored verbatim.
- `llm_completion` — full completion `content` + `reasoningContent` + `timing`, with `attempt: 1 | 2` (attempt 2 == parse retry).
- `tool_invocation` — executed tool call with args, status, summary, and optional details.
- `parse_retry`, `loop_detected`, `error`, `trace_truncated` — diagnostics.

Invariants:

- **Append-only.** Sinks never rewrite past lines. `trace_truncated` is a synthetic final marker when the per-session cap (`telemetry.trace.maxBytesPerSession`, default 10 MiB) is hit; further events are dropped silently.
- **Per-session file.** One NDJSON per `sessionId`; no cross-session mixing.
- **Monotonic `seq`.** Every event carries a monotonic in-session sequence starting at `0`.
- **No redaction yet.** Secret redaction is an explicit NON-goal of this milestone; treat trace files as sensitive local artefacts.

CLI:

- `atomic-agent trace list [--limit N]` — most recent trace files in `<stateDir>/traces/`.
- `atomic-agent trace show <sessionId> [--step N] [--raw]` — pretty-print the chronology. `--raw` includes the full prompt tail and completion content; otherwise they are summarised.
- `atomic-agent trace export <sessionId> [--format ndjson|json]` — dump the file as-is (ndjson) or as a JSON array.
- `atomic-agent trace replay <sessionId> [--step N]` — rebuild the stable prefix from the current runtime (tools / capabilities / skills / persona) and compare its hash to the recorded `stablePrefixHash`. Drift means the upper prompt changed since recording — useful for postmortem when cache hits dropped.

Replay lives in [src/replay/](src/replay/). It is a **prompt-drift postmortem**, not a simulator: it does not reproduce LLM non-determinism or external world state (browser, filesystem). `replayInference` (programmatic, not wired to the CLI yet) can optionally rerun `LlamaServerClient` with the recorded prompts for regression tests across llama-server upgrades.
