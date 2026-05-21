# atomic-agent — memory subsystem

This document is the source-of-truth for how cross-session memory works in `atomic-agent`. It complements:

- `ARCHITECTURE.md` — overall runtime topology and invariants.
- `AGENTS.md` — short engineering summary for automated contributors.
- `PROMPT.md` — full anatomy of the stable prefix and variable tail, including where the memory channels render in the prompt.
- `EVOLUTION.md` — historical evolution notes (Option 2 / 2a, etc.).

## 1. Goals and non-goals

The memory subsystem must:

- Survive across sessions and across process restarts.
- Surface its hot bits to the model **without** forcing a tool call.
- Surface its warm bits as **pointers** so the model can pull on demand.
- Not invalidate the stable prompt prefix on writes (KV-cache must keep working).
- Form itself automatically — the user shouldn't have to hand-craft profiles.
- Stay bounded in size so the SQLite file and the prompt tail never blow up.

It explicitly does **not** do:

- Embeddings or semantic search (FTS5/BM25 only).
- Importance scoring or decay curves.
- Episodic / dialogue summarisation.
- Cross-machine sync, redaction, or encryption-at-rest.
- Per-skill or per-task scoped memory pools.

## 2. The three channels

Memory is a triangle of three independent channels that share one SQLite file (`<stateDir>/memory.sqlite`):

| Channel       | What it stores                | Read path                                   | Write path                                |
| ------------- | ----------------------------- | ------------------------------------------- | ----------------------------------------- |
| `ProfileStore`| short key/value facts         | auto-injected as `### profile` (gated)      | `memory.profile.set` tool **+** reflection|
| `MemoryStore` | freeform notes (FTS5/BM25)    | top-K auto-injected, plus `#id` index hints | `memory.notes.store` tool **+** reflection|
| Reflection    | n/a — it's the writer         | n/a                                         | end-of-turn micro-LLM call                |

Both stores live in the same database file but use different tables and migrations:

- `profile_facts (key TEXT PK, value TEXT, pinned INTEGER, keywords TEXT, updated_at INTEGER)`
- `memories (id INTEGER PK, content TEXT, tags TEXT, source TEXT, scope TEXT, working_dir TEXT, created_at, updated_at)`
- `memories_fts` virtual table (FTS5, `porter unicode61`).

`MEMORY_SCHEMA_VERSION` is currently `3`. Migrations are idempotent and applied lazily on `applyMigrations(db)`. See [src/memory/memory-schema.ts](src/memory/memory-schema.ts).

## 3. ProfileStore — durable facts in the tail

### 3.1 Shape

A `ProfileFact` is:

```ts
{ key: string; value: string; pinned: boolean; keywords: string[]; updatedAt: number }
```

- `key` is a short identifier (`language`, `timezone`, `name`, `preferred_browser`, …). Free-form but bounded by `PROFILE_KEY_MAX_LENGTH`.
- `value` is plain text bounded by `PROFILE_VALUE_MAX_LENGTH`.
- `pinned=true` (default) → fact is **always** rendered into the `### profile` section.
- `pinned=false` → fact is **contextual**: rendered only when at least one of its `keywords` hits the current user message (case-insensitive substring match).

### 3.2 Prompt placement

Rendered by [src/memory/profile-renderer.ts](src/memory/profile-renderer.ts) into the `### profile` section of the variable tail (after optional `### loaded-skills`, before `### memory-index` / `### session-facts` / `### recalled`). The block is bounded by `memory.profile.maxTokens` (default `512`) with a `[truncated]` marker.

The contextual gate is controlled by `memory.profile.contextualKeywordGate` (default `true`). When `false`, **all** facts render regardless of `pinned` — useful for debugging.

### 3.3 Why `pinned` exists

Without gating, every "user uses GPT-5 for Python" / "user prefers Cyrillic shortcut keys" fact would burn tail tokens forever. With gating:

- **Pinned** facts are identity-level and small in number (`name`, `language`, `timezone`, …). They go in every prompt.
- **Contextual** facts are topic-scoped (e.g. `python_test_runner=pytest [keywords=python,pytest,test]`). They only appear when the topic is hot, so they don't crowd the tail when the user is talking about something else.

### 3.4 Tools

Defined in [src/tools/memory/](src/tools/memory/) and surfaced via [src/prompt/tool-descriptors.ts](src/prompt/tool-descriptors.ts):

- `memory.profile.set { key, value, pinned?, keywords? }` — upsert. `pinned` defaults to `true`. `keywords` is an array of short strings used by the gate.
- `memory.profile.remove { key }` — delete.
- `memory.profile.list {}` — read-only. Output marks pinned facts with `*` and contextual facts with `~ [keywords: …]`.

## 4. MemoryStore — freeform notes with FTS5

### 4.1 Shape

A `MemoryEntry` is:

```ts
{ id: number; content: string; tags: string[]; source: "user" | "agent";
  scope: "all" | "project"; workingDir: string | null;
  createdAt: number; updatedAt: number }
```

- `content` is a freeform paragraph (cap: `MEMORY_CONTENT_MAX_LENGTH = 4000` chars).
- `tags` is an array of short keyword tags (cap: 8 tags, 32 chars each).
- `scope: "project"` ties the entry to a `workingDir`; `scope: "all"` is global.

### 4.2 Read path — automatic injection (tail-only)

Two new sections live in the variable tail:

- `### recalled` — top-K notes ranked by BM25 against the current user message. Driven by `memory.recallInjection.{enabled, k, previewChars, maxTokens}`. Default: `k=3`, preview clipped to 160 chars.
- `### memory-index` — the most recently updated `N` note pointers as `#id [tags] preview` lines. Driven by `memory.index.{enabled, limit, previewChars, maxTokens}`. Default: 20 rows, 60-char previews.

Both sections are deduplicated by id: anything that surfaced in `### recalled` is filtered out of `### memory-index` so the same note never appears twice in one prompt.

The pre-fetch lives in [src/memory/memory-context-provider.ts](src/memory/memory-context-provider.ts). It is invoked once per turn from `agent-loop.runTurn`, never inside the per-step loop.

### 4.3 Read path — explicit drill-down

`memory.notes.recall { query? | id?, scope?, workingDir?, k? }`:

- `{ id: 42 }` — direct lookup. Used by the agent when it sees `#42` in the `### memory-index` section and wants the full body.
- `{ query: "..." }` — BM25 search; same engine as the auto-injected `### recalled` block.

### 4.4 Write path

- `memory.notes.store { content, tags?, scope?, workingDir? }` — explicit save by the agent.
- Reflection (§5) writes notes automatically when `memory.reflection.autoStoreNotes=true`.

### 4.5 Eviction

Uncapped freeform memory rots fast. `MemoryStore` enforces a hard cap of `memory.notes.maxEntries` rows (default `1000`). On insert overflow, the oldest rows by `(updated_at ASC, id ASC)` are deleted. There is **no content-based deduplication** — `MemoryStore` is a log, and the same statement can land twice. This is a known limitation, see §10.

## 5. Reflection — automatic memory formation

### 5.1 When and where

Fired at the end of every `AgentLoop.runTurn`, after the `assistant_reply` event has already been emitted. It is **fire-and-forget**: the user-visible response never waits on it. The next `runTurn` calls `abortPending()` so at most one reflection is in flight per session.

Implementation: [src/memory/reflection/reflection-runner.ts](src/memory/reflection/reflection-runner.ts).

### 5.2 KV-cache hygiene

Reflection runs on a **dedicated llama-server slot** reserved at bootstrap via `slotManager.reserveReflectionSlot()`. The main agent slot is never touched, so the operator's KV cache survives. When llama-server is single-slot, reflection falls back to `slotId: -1` (no cache reuse) but the main slot is still untouched.

### 5.3 What it produces

A tiny stable-prefix prompt asks the model to extract durable facts from the last `USER` / `ASSISTANT` exchange. Output is GBNF-constrained to one of:

- `NONE` — nothing worth remembering.
- A bounded list of `SET` and/or `NOTE` lines, each with optional metadata.

#### SET — flows into `ProfileStore`

```
SET key=value
SET key=value [pinned=false; keywords=python,test]
```

- Plain `SET` writes a pinned fact.
- `[pinned=false; keywords=…]` makes it contextual.

#### NOTE — flows into `MemoryStore`

```
NOTE this is a freeform observation [tag1, tag2]
```

The trailing `[tag1, tag2]` marker is parsed out by the runtime; `tags` are merged with the implicit `reflection` tag.

Caps:

- `memory.reflection.maxFactsPerCall` (default `3`) — upper bound on `SET` lines.
- `memory.reflection.maxNotesPerCall` (default `2`) — upper bound on `NOTE` lines (set to `0` to disable).
- `memory.reflection.timeoutMs` (default `10000`) — hard timeout; on timeout, nothing is written.
- `memory.reflection.autoStoreNotes` (default `true`) — master switch for the `NOTE` channel.

### 5.4 Validation and observability

Parsed entries flow through the same validators as the explicit tools (`ProfileStore.set`, `MemoryStore.store`). Invalid lines are logged and skipped, never failing the whole call.

Metrics: `agent.memory.reflection` counter tagged by `outcome` (`ok | none | failed | aborted | timeout`) plus the `agent.memory.reflection.latency_ms` histogram. Logs: `reflection.fired`, `reflection.ok`, `reflection.none`, `reflection.aborted`, `reflection.timeout`, `reflection.failed`.

## 6. Per-turn data flow

```
runTurn(userMessage):
  1. abortPending()                         ← cancel any in-flight reflection
  2. memoryContextProvider.buildMemoryContext({ userMessage })
        → recalled  = MemoryStore.recall(userMessage, k)
        → index     = MemoryStore.listIndex(limit) − {ids in recalled}
     attach to SessionState.recalledNotes / memoryIndex (ephemeral)
  3. for each step:
        prompt = buildPrompt({
          stable-prefix unchanged,
          tail: [session, profile?, recalled?, memory-index?, world, conversation, notice?]
        })
        ← profile renderer filters by pinned + keyword hits against userMessage
        llmComplete → parseToolCall → invoke → recordResult
        terminate on reply / finish / max_steps
  4. emit assistant_reply / turn_finished
  5. fire-and-forget reflection.reflect({ userMessage, assistantReply })
        → SET … → ProfileStore.set
        → NOTE … → MemoryStore.store (capped, FIFO-evicted on overflow)
```

`SessionState.recalledNotes` and `SessionState.memoryIndex` are **ephemeral** fields — `stripEphemeral(state)` removes them before `SessionStore` writes the snapshot to SQLite. They are recomputed every turn so the prompt always sees fresh hits against the current user message.

## 7. Prompt placement and KV-cache invariants

```
# stable prefix (never touched by memory writes)
[system persona]              ← describes the memory protocol to the model
[tool catalog]                ← includes memory.profile.* and memory.notes.*
[capabilities]
[skill catalog]

# variable tail (memory-aware sections, slow → hot)
### loaded-skills  ← optional; skill bodies from SessionState.loadedSkills
### profile        ← ProfileStore.list() filtered by pinned + keywords
### memory-index   ← MemoryStore.listIndex(limit), dedup against recalled; rows sorted by id
### session-facts  ← optional; SessionState.knownFacts (last 8)
### recalled       ← MemoryStore.recall(userMessage, k)
### world
### conversation
### notice         ← (optional, loop-detector)
### respond
```

Hard rules enforced by tests:

- The `### profile`, `### recalled`, and `### memory-index` sections are **always in the variable tail**. They never participate in the stable prefix hash. Pinned in `build-prompt.test.ts`.
- Reflection runs on a separate llama-server slot; the main agent slot's KV cache is untouched. Pinned in `slot-manager.test.ts`.
- The `memory.notes.*` corpus is **never** dumped wholesale into the prompt. Only top-K `recalled` and pointer-only `memory-index` rows go in.

## 8. Configuration reference

All keys live under `memory.*` in `<stateDir>/config.json`. Defaults are in [src/config/config-schema.ts](src/config/config-schema.ts).

| Key                                          | Default | Meaning                                                       |
| -------------------------------------------- | ------- | ------------------------------------------------------------- |
| `memory.profile.enabled`                     | `true`  | Inject `### profile` and register the three profile tools.    |
| `memory.profile.maxTokens`                   | `512`   | Hard ceiling for the rendered `### profile` block.            |
| `memory.profile.contextualKeywordGate`       | `true`  | Hide `pinned=false` facts unless a keyword hits user message. |
| `memory.reflection.enabled`                  | `true`  | Master switch for the async reflection runner.                |
| `memory.reflection.timeoutMs`                | `10000` | Hard timeout per reflection call.                             |
| `memory.reflection.maxFactsPerCall`          | `3`     | Max `SET` lines written per reflection.                       |
| `memory.reflection.autoStoreNotes`           | `true`  | Allow reflection to emit `NOTE` lines into `MemoryStore`.     |
| `memory.reflection.maxNotesPerCall`          | `2`     | Max `NOTE` lines per reflection. `0` disables notes.          |
| `memory.notes.enabled`                       | `true`  | Register the three `memory.notes.*` tools.                    |
| `memory.notes.maxEntries`                    | `1000`  | Hard cap on `memories` rows; FIFO-evicted on overflow.        |
| `memory.notes.maxContentChars`               | `4000`  | Per-call ceiling for `memory.notes.store.content`.            |
| `memory.notes.recallDefaultK`                | `5`     | Default `k` when `memory.notes.recall` omits it.              |
| `memory.recallInjection.enabled`             | `true`  | Inject `### recalled` into the prompt tail.                   |
| `memory.recallInjection.k`                   | `3`     | Top-K notes for the auto-injected `### recalled` block.       |
| `memory.recallInjection.previewChars`        | `160`   | Per-line preview clip in `### recalled`.                      |
| `memory.recallInjection.maxTokens`           | `400`   | Hard ceiling for the rendered `### recalled` block.           |
| `memory.index.enabled`                       | `true`  | Inject `### memory-index` into the prompt tail.               |
| `memory.index.limit`                         | `20`    | Number of pointer rows in `### memory-index`.                 |
| `memory.index.previewChars`                  | `60`    | Per-line preview clip in `### memory-index`.                  |
| `memory.index.maxTokens`                     | `300`   | Hard ceiling for the rendered `### memory-index` block.       |
| `paths.memoryDbFile`                         | derived | Resolves to `<stateDir>/memory.sqlite`.                       |

## 9. Anti-bloat: why memory does not blow up

A real concern: every turn triggers reflection, which can write new facts and notes. Without safeguards, the SQLite file and the prompt tail would grow without bound. The system has five layers of defence:

1. **Per-call write caps.** Reflection cannot write more than `maxFactsPerCall` SETs and `maxNotesPerCall` NOTEs per turn (default 3 + 2). Even in the worst case, growth is at most ~5 rows per turn.
2. **Hard storage cap with FIFO eviction.** `MemoryStore.maxEntries` (default `1000`) is a strict ceiling; the oldest rows by `updated_at` are dropped on overflow. The SQLite file is bounded.
3. **Prompt-tail caps.** Each tail section has its own `maxTokens` ceiling: `### profile` ≤ 512, `### recalled` ≤ 400, `### memory-index` ≤ 300. Per-line previews are clipped (`previewChars`) so even a 4000-char note costs ~160 chars in `### recalled`.
4. **Contextual gating for ProfileStore.** Only pinned facts are unconditionally injected. Contextual facts only appear when their keywords hit the current user message — most prompts see only a small slice of `profile_facts`.
5. **LLM-side discipline.** The reflection prompt explicitly tells the model to "skip trivia" and to output `NONE` if nothing is worth remembering. Reflection is a small focused micro-prompt, not the operator persona, so this rule is followed reliably.

Worst case under defaults: 1000 notes × ~80 chars/preview ≈ 80 KB cap on `memory.sqlite` for note bodies + a few KB for `profile_facts`. The prompt tail adds at most ~1200 tokens of memory regardless of how many entries are stored.

## 9.1 Operator inspection (TUI)

`atomic-agent tui` → Manage → **Memory** tab (or `/memory` from chat).

Read-only browser over `<stateDir>/memory.sqlite`:

| Channel     | What you see                                      |
| ----------- | ------------------------------------------------- |
| `profile`   | Active facts; Enter shows bi-temporal `history()` |
| `notes`     | Index rows; Enter shows full `content` + links  |
| `lessons`   | Pointer rows; Enter shows `principle` + parents   |
| `procedures`| Pointer rows; Enter shows `steps[]`               |
| `links`     | Edge table (`from → to`, kind)                    |
| `votes`     | Audit tail when `memory.voting.enabled`           |

Hotkeys: `j/k` move, Enter detail, `r` refresh, `a` auto-refresh (5s), `[/]` cycle channel, `1`–`6` jump channel, `f` cycle notes archive filter (active / archived / all). On note detail with links enabled: `g` expands the graph neighbourhood.

Legacy: `/memory dump` still prints the active profile into the chat transcript.

## 10. Known limitations

- **No content dedup in `MemoryStore`.** The same `NOTE` body can be written multiple times if reflection produces it across turns. FTS5 will then return clones in `### recalled`. Mitigation: `maxNotesPerCall=2` keeps the rate low; explicit `memory.notes.forget` removes duplicates.
- **No usefulness signal in eviction.** FIFO-by-`updated_at` evicts the oldest row even if it has been recalled 100 times. A future revision could weight by recall hits.
- **Profile keys are LLM-generated.** Reflection can invent new keys (`coding_style`, `favourite_editor`, …). There is no schema check beyond length validation; horizontal growth of the profile is bounded only by `memory.profile.maxTokens` truncation.
- **Reflection quality depends on the model.** A weak model can either skip durable facts or store trivia. The `[pinned=false; keywords=…]` syntax is a request, not a contract.
- **No embeddings, no semantic recall.** BM25 misses paraphrases. A user asking "what did I tell you about my Python testing setup?" will hit notes containing `python` and `test`, but not notes that only say "I prefer pytest for unit work".

## 11. Failure modes

| Failure                              | Surface                                   | Recovery                                           |
| ------------------------------------ | ----------------------------------------- | -------------------------------------------------- |
| `memory.sqlite` corrupt / missing    | startup error in bootstrap                | rerun creates a fresh db; data lost.               |
| Reflection LLM call times out        | `reflection.timeout` log + counter        | next turn fires a new reflection; nothing written. |
| Reflection grammar parse error       | `reflection.failed` log + counter         | nothing written; agent loop unaffected.            |
| `MemoryStore.recall` BM25 syntax err | swallowed in `memory-context-provider`    | `### recalled` falls back to empty.                |
| `ProfileStore.set` validation reject | tool error reported back to the model     | model can retry with valid input.                  |
| llama-server single-slot             | reflection uses `slotId: -1`              | no cache reuse for reflection; main slot intact.   |

## 12. Code map

```
src/memory/
  index.ts                       — named exports
  memory-schema.ts               — SQLite schema + migrations (v1 → v2 → v3)
  profile-store.ts               — ProfileStore CRUD (pinned + keywords)
  profile-renderer.ts            — `### profile` rendering with contextual gate
  memory-store.ts                — MemoryStore CRUD + FTS5 recall + listIndex
  notes-renderer.ts              — `### recalled` and `### memory-index` rendering
  memory-context-provider.ts     — per-turn pre-fetch with dedup
  reflection/
    reflection-prompt.ts         — micro-prompt stable prefix + SET/NOTE rules
    reflection-grammar.ts        — GBNF for NONE | SET … | NOTE …
    reflection-parser.ts         — discriminated-union parser
    reflection-runner.ts         — fire-and-forget orchestrator + write fan-out

src/tools/memory/
  profile-set.ts / profile-remove.ts / profile-list.ts
  notes-store.ts / notes-recall.ts / notes-forget.ts
  index.ts                       — registerMemoryTools

src/agent/
  agent-loop.ts                  — calls memoryContextProvider + reflectionRunner
  step-executor.ts               — threads userMessage into buildPrompt

src/prompt/
  build-prompt.ts                — emits `### profile / recalled / memory-index`
  stable-prefix.ts               — persona explains the memory protocol

src/session/
  session-state.ts               — adds ephemeral recalledNotes / memoryIndex
  session-store.ts               — stripEphemeral before persistence

src/config/
  config-schema.ts               — `memory.*` keys + defaults
  load-config.ts                 — `paths.memoryDbFile` resolution
```

## 13. Glossary

- **Profile fact** — a `(key, value, pinned, keywords)` row in `profile_facts`. Auto-injected into `### profile` (gated).
- **Note** — a freeform `MemoryEntry` row in `memories`. Searchable by FTS5/BM25; auto-injected as top-K hits or as pointer rows.
- **Pinned fact** — a profile fact that is always rendered into the prompt.
- **Contextual fact** — a profile fact rendered only when at least one of its `keywords` hits the current user message.
- **Recalled** — the `### recalled` block: top-K full notes ranked by BM25 against the current user message.
- **Memory-index** — the `### memory-index` block: compact `#id [tags] preview` pointer rows.
- **Reflection** — the async end-of-turn micro-LLM call that writes `SET` and `NOTE` lines into the two stores.
- **Ephemeral session field** — a `SessionState` field (e.g. `recalledNotes`, `memoryIndex`) that is recomputed per turn and stripped before persistence.
- **Memory context provider** — the per-turn pre-fetch component that populates `recalledNotes` and `memoryIndex` for the prompt builder.
