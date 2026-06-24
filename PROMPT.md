# atomic-agent — system prompt anatomy

This document is the source-of-truth for how the prompt sent to `llama-server`
on every step is assembled. It complements:

- `ARCHITECTURE.md` — overall runtime topology and invariants.
- `AGENTS.md` — short engineering summary for automated contributors.
- `MEMORY.md` — how the memory channels feed `### profile`, `### memory-index`,
  and `### recalled`.

Code entry point: [src/prompt/build-prompt.ts](src/prompt/build-prompt.ts).
Stable-prefix entry point: [src/prompt/stable-prefix.ts](src/prompt/stable-prefix.ts).

## 1. Why the prompt is shaped this way

The runtime is built around three hard constraints:

1. **Every step must stay under a tight token budget** (~2.5k effective on
   typical configs). State that does not fit goes outside the prompt
   (SQLite, ARIA snapshot store, memory) and is summarised on the way in.
2. **The KV-cache on `llama-server` is byte-sensitive.** Once the first byte
   of a step diverges from the previous step's prompt, every byte after that
   point must be recomputed. We pin the upper part of the prompt to be
   byte-stable across an entire session.
3. **One inference per step.** No tool call is ever invoked from inside the
   model. The runtime drives the loop, so the prompt only needs to describe
   the next step's situation, not a chain of thought. A single inference always
   emits a JSON **array** of `1..N` independent calls (`[{tool, args}, ...]`);
   a "solo" step is just a length-1 array (`[{...}]`). The grammar root
   collapsed to `tool-call-array` to beat GBNF first-token bias — see
   `AGENTS.md` §"Parallel tool calls per step" for the full contract. From the
   prompt's point of view nothing changes — the same stable prefix is reused
   across solo and multi-call steps.

The output is a two-zone prompt:

```
┌──────────────────────────────────────────────────────────┐
│ STABLE PREFIX                                            │
│  - byte-identical across a session                       │
│  - cached via `cache_prompt + slot_id` on llama-server   │
│  - ~persona + tool catalog + capabilities + skill index  │
├──────────────────────────────────────────────────────────┤
│ VARIABLE TAIL                                            │
│  - rebuilt from scratch every step                       │
│  - sections ordered from least to most mutable           │
│  - last few hundred bytes hold the actual question       │
└──────────────────────────────────────────────────────────┘
```

The cache-reuse property is what makes a 32-step browser session affordable:
the upper ~3-5k tokens are computed once and re-used; only the tail's tokens
are re-attended on each step.

## 2. The stable prefix

Built once per `runStep` by `buildStablePrefix`. It is a deterministic
concatenation of these sub-blocks (order matters for KV-cache and for how
strongly the model notices skills before the full tool wall):

```
### system
<reasoningSystemToken? + persona>

### rules
<static policy line(s)>

### skills
- [global] <name>: <description>
- [project] <name>: <description>
...

### tools
<one bullet per tool: name, summary, args-schema, optional examples>

### capabilities
platform: darwin/arm64
browser: chromium
working_dir: <abs path>
clipboard: yes
wmctrl: no
notifications: yes

### instructions
Emit a JSON ARRAY of tool calls now. Always start with `[` and end with `]`, even for a single call. Use `reply` for natural-language answers to the user.
PARALLEL: when you need multiple INDEPENDENT actions (e.g. read 3 different files, run 2 globs, look up 4 git logs), put up to 4 calls in the SAME array — they run in parallel and cut wall time by ~Nx. Examples:
  - one call: [{"tool":"os.fs.read","args":{"path":"a.ts"}}]
  - parallel batch: [{"tool":"os.fs.read","args":{"path":"a.csv"}},{"tool":"os.fs.read","args":{"path":"b.csv"}},{"tool":"os.fs.read","args":{"path":"c.csv"}}]
  - reply: [{"tool":"reply","args":{"text":"..."}}]
Keep a call solo (length-1 array) when: it is `reply`/`finish`, may need approval (`os.shell.run`, `os.fs.write`, `os.fs.edit`, `os.fs.trash`, `os.fs.patch`, `os.fs.archive.extract`, `os.proc.kill`, `os.http.request`, `skill.run_script`), or its args depend on a previous call's result.
```

### What lives here and why

| Block | Content | Why stable |
|---|---|---|
| `### system` | Persona text from `DEFAULT_SYSTEM_PERSONA` (or override via `BuildPromptInput.systemPersona`). | Persona is fixed for the whole runtime. |
| `### rules` | Short policy text (approval, `tool.view`, fs hygiene, **skill-first when `### skills` matches**). | Static literal. |
| `### skills` | Catalog of available skills (name + description), not their bodies. Placed **before** `### tools` so the model sees playbooks before the full tool wall. | Catalog is read once at bootstrap. |
| `### tools` | One bullet per tool, formatted by `formatTool`. Includes optional `examples[]`. Web search is first-class via `os.web.search` (provider from `web.search.*` config), while `os.web.fetch` reads a chosen URL as markdown/text. | Tool registry is fixed at bootstrap. |
| `### capabilities` | OS, browser channel, cwd, capability flags. | Computed once at session start. |
| `### instructions` | The array-only contract: always start with `[`, length-1 for solo, length-N for parallel independent actions. Three worked examples (solo, batch, reply) anchor the shape, and an explicit "keep solo when" list pins terminal verbs / approval-gated tools / data-dependent chains to length-1 batches. | Static literal — the array-only contract, the examples, and the solo list are part of the byte-stable prefix so the model sees them every step without invalidating the cache. |

### What does NOT live here (intentional)

- Skill *bodies*. Loaded skill bodies live in the tail under `### loaded-skills`,
  because `skill.view` can change them mid-session.
- Profile facts, recalled notes, memory index. These are tail-only — see §3.
- The current world snapshot, conversation history, or the user message.

### KV-cache invariant

The string returned by `buildStablePrefix` must be byte-identical across every
step of a session. Pinned by [src/prompt/build-prompt.test.ts](src/prompt/build-prompt.test.ts)
via `stablePrefixHash`. If you add a new sub-block to the stable prefix you
must regenerate that hash test in the same change — there is no soft-warning
for this.

## 3. The variable tail

The tail is rebuilt every step. Sections are ordered **from least to most
mutable** so that a single fast-changing section at the bottom does not force
the cache to drop the slower sections above it.

```
### loaded-skills    (slow)   bodies of skills loaded via skill.view
### profile          (slow)   pinned + keyword-gated user facts
### memory-index     (slow)   #id [tags] preview pointers (sorted by id asc)
### session-facts    (medium) compact known facts collected this session
### recalled         (medium) top-K BM25 hits against the current user message
### world            (hot)    compressed ARIA / browser state
### conversation     (hot)    transcript (oldest turns folded into a summary)
### notice           (hot, optional) one-shot runtime hint (e.g. loop detected)
### respond
Respond now.
<reasoning open tag, optional>
```

Every section starts with its `###` header and ends with one blank line.
Empty sections are omitted entirely (no header).

### 3.1 Mutability tiers

| Tier | Section | Cadence of change | What invalidates it |
|---|---|---|---|
| Slow | `### loaded-skills` | Once per `skill.view` call. | New skill loaded. |
| Slow | `### profile` | When `memory.profile.*` writes, OR when `userMessage` keywords change which contextual facts pass the gate. | New user message that triggers/un-triggers a contextual fact. |
| Slow | `### memory-index` | When notes are stored/forgotten. Sorted `id ASC` so insert order does not perturb output. | New `memory.notes.store`. |
| Medium | `### session-facts` | When `knownFacts` grows (compressor or reflection). | New fact appended. |
| Medium | `### recalled` | Top-K BM25 against the *current* user message — changes whenever the user message changes. | New user message. |
| Hot | `### world` | Every browser action that refreshes the ARIA snapshot. | Any `browser.*` tool call that mutates the world. |
| Hot | `### conversation` | Every step (new tool call/result/reply appended). | Every step. |
| Hot | `### notice` | One-shot, set by the runtime when something is wrong (loop detector, etc.). | Whenever the runtime decides. |

### 3.2 Static `### respond` anchor

A 2-line static block sits between the tail and the optional reasoning prefill:

```
### respond
Respond now.
```

It is intentionally **not** part of the stable prefix. Empirically, when the
final directive lived ~13k tokens upstream, reasoning-mode models entered
"I will write the response. I will check the response." repetition loops.
Keeping the directive close to the generation point fixes that without
hurting cache reuse meaningfully — the block is two short byte-stable lines.

If the active model profile requires it (`profile.requiresPromptThinkPrefix &&
profile.reasoningStyle !== "none"`), the prompt ends with the model's
`reasoningOpenTag` to prefill the reasoning channel.

## 4. Section sources and renderers

| Section | Built by | Source of truth |
|---|---|---|
| `### loaded-skills` | `buildSessionSectionParts` ([session-tail-sections.ts](src/prompt/session-tail-sections.ts)) | `SessionState.loadedSkills` |
| `### profile` | `renderProfileSection` ([memory/profile-renderer.ts](src/memory/profile-renderer.ts)) | `ProfileStore` (snapshot taken once per step via `profileFactsProvider`) |
| `### memory-index` | `renderMemoryIndexSection` ([memory/notes-renderer.ts](src/memory/notes-renderer.ts)) | `SessionState.memoryIndex` (pre-fetched once per turn) |
| `### session-facts` | `buildSessionSectionParts` | `SessionState.knownFacts` (last 8) |
| `### recalled` | `renderRecalledSection` ([memory/notes-renderer.ts](src/memory/notes-renderer.ts)) | `SessionState.recalledNotes` (BM25 against current user message) |
| `### world` | `renderWorldSnapshotSection` (inline in `build-prompt.ts`) | `SessionState.worldSnapshot` (compressed ARIA, captured by `browser.*` tools) |
| `### conversation` | `packConversation` + `renderTurnForPrompt` ([session/conversation-turn.ts](src/session/conversation-turn.ts)) | `SessionState.turns[]` |
| `### notice` | passed through unchanged from `BuildPromptInput.transientNotice` | runtime, e.g. loop detector |

The two memory hint sections are **deduplicated by id** — anything in
`### recalled` is filtered out of `### memory-index`.

## 5. Token budget

Defined in [src/prompt/token-budget.ts](src/prompt/token-budget.ts). Three
caps, one safety net:

| Cap | Default | Source |
|---|---|---|
| `agent.tokenBudget` | 6000 | `### loaded-skills` + `### session-facts` (shared via `truncateToTokens` on a combined string). Trimmed from the *tail* of the combined blob, so loaded-skill bodies are dropped before facts. |
| `agent.worldSnapshotMaxTokens` | 8000 | Cap on `### world`. The ARIA snapshot is already compressed upstream by `aria-compressor`; this is a pathological-input safety net. |
| `agent.conversationMaxTokens` | 32000 | Cap on `### conversation`. When the active model profile carries a physical `contextWindow` (read once via `LlamaServerClient.fetchProps()` at bootstrap), the effective cap is further clamped by `computeEffectiveConversationCap` so that `stablePrefix + sessionParts + world + memory + completion + safety` still fits. |

Per-section memory caps live under `memory.*` (full table in `MEMORY.md`):

- `memory.profile.maxTokens` (default 512) — `### profile`.
- `memory.recallInjection.maxTokens` (default 400) — `### recalled`.
- `memory.index.maxTokens` (default 300) — `### memory-index`.

When a section is truncated, the corresponding flag in
`BuiltPrompt.truncation.*` is set, the body ends with a `[truncated]` marker,
and the `### conversation` section is shrunk further (older turns become a
single deterministic `summary: N older turns dropped (...)` line) before any
hard error is raised.

## 6. KV-cache invariants (locked)

These are pinned by tests in `src/prompt/build-prompt.test.ts`:

1. **The bytes returned by `buildStablePrefix` are stable across a session.**
   Adding any per-turn data to the stable prefix breaks the contract.
2. **Profile / memory-index renderers are deterministic for the same input.**
   `renderMemoryIndexSection` sorts by `id ASC`; `renderProfileSection` sorts
   pinned-first then by key. Identical input ⇒ identical output bytes.
3. **The `### loaded-skills` and `### profile` blocks are byte-identical
   when only `knownFacts` change.** This is the property the slow→hot tier
   ordering buys us — a single-step `session-fact` append does NOT
   invalidate the slow tail above it.
4. **The static `### respond` anchor is byte-stable.** Do not parameterise
   it.
5. **`### recalled` and `### memory-index` are deduplicated.** A note
   appearing in `### recalled` is removed from `### memory-index` so the
   bytes do not collide.

## 7. What lives where (debugging cheatsheet)

If a section seems wrong, look here:

- Persona, tool catalog, skill index → `buildStablePrefix` only. Check the
  `toolDescriptors` registered in `bootstrap.ts`.
- Profile facts missing or extra → `renderProfileSection`, plus the
  contextual-keyword gate (`memory.profile.contextualKeywordGate`).
- Notes section empty when it should not be → check
  `memory-context-provider.ts` (pre-fetch happens once per turn from
  `agent-loop.runTurn` before the per-step loop starts) and `SessionState.recalledNotes`
  / `memoryIndex` ephemeral fields.
- Conversation history truncated unexpectedly → `packConversation` and the
  effective-cap logic in `computeEffectiveConversationCap`.
- World snapshot looks stale → the snapshot is captured by the *previous*
  `browser.*` tool. `browser.navigate` and `browser.search` refresh it
  automatically; `browser.click` / `browser.type` / `browser.scroll` do
  not, by design.
- Cache hits dropped between steps → run
  `atomic-agent trace replay <sessionId>` and compare `stablePrefixHash`.
  If it drifted, something added per-turn data to the upper prompt; if it
  did not, look at the tail boundary (most likely `### loaded-skills`
  being recomputed because a fact got into the loaded-skills budget
  blob).

## 8. Out of scope (deliberate)

- Embeddings or semantic search anywhere in the prompt path. Memory uses
  FTS5/BM25 only.
- Per-tool dynamic descriptions in `### tools`. Tool descriptors are static
  for the whole session.
- Streaming the prompt build. The full prompt is produced in one
  synchronous pass — the cost is dominated by token estimation, not string
  assembly.
- Secret redaction in any prompt section. Treat trace files and prompt
  dumps as sensitive local artefacts.
