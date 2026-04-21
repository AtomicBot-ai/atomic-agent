# atomic-agent — engineering guide for agents

This is the source-of-truth for automated contributors (LLM agents, codegen, etc.). Human-facing docs live in `README.md`.

## Mission

`atomic-agent` is a lightweight local coding agent runtime that:

- Embeds as a **sidecar** in Tauri desktop apps (stdin/stdout NDJSON).
- Ships a **CLI** (`atomic-agent`) for local debugging.
- Connects to an **external** `llama-server` (llama.cpp) over HTTP — the LLM runtime, model weights, and binaries are **not** part of this project.
- Keeps every LLM step under ~2.5k tokens by externalising state, summarising results, and slicing only the relevant repo context.

## Architectural invariants

1. **Project ≠ Prompt.** Index, summaries, and deltas live outside the model; the prompt is always a small slice.
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
| `src/tools/` | Tool registry + individual tools |
| `src/repo-index/` | tree-sitter parsing, symbol graph, manifest |
| `src/retrieval/` | BM25 + semantic search + relevance slice |
| `src/embeddings/` | bge-small embedder + sqlite-vec store |
| `src/summaries/` | File summaries with content-hash cache |
| `src/change-tracker/` | AST-diff and change classifier |
| `src/compressor/` | Result compressor, log summariser |
| `src/sandbox/` | git worktree + sandboxed command runner |
| `src/approval/` | Approval gate and event wiring |
| `src/telemetry/` | Structured logger + metrics |

## Build & test

```bash
npm install
npm run lint    # tsc noEmit
npm test        # vitest run
npm run build   # compile to dist/
```

The CLI entry is `src/cli/index.ts`; the sidecar entry is `src/sidecar/main.ts`.

## External llama-server

`atomic-agent` never starts a `llama-server`. It assumes the server is reachable at `ATOMIC_AGENT_LLAMA_URL` (default `http://127.0.0.1:8080`). When the server is unreachable, the sidecar emits an `llm_unavailable` event and continues running indexing/retrieval in degraded mode.
