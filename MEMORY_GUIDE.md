# atomic-agent — memory, end to end

A practical tour for operators: what the agent remembers, when, where it lives
on disk, how it comes back into the conversation, and how to inspect or erase
it. Everything here describes shipped default behaviour — the deep internals
live in [MEMORY.md](MEMORY.md), and the design history in
[MEMORY_FABRIC_V2.md](MEMORY_FABRIC_V2.md) / [MEMORY_FABRIC_V2.5.md](MEMORY_FABRIC_V2.5.md).

## The short version

Memory is **not** the chat transcript. It is a separate, bounded, inspectable
store of five kinds of things, all in one local SQLite file:

| Kind | What it is | Written by | Comes back as |
|---|---|---|---|
| **Profile facts** | short key/value facts about you (`name`, `language`, `deploy_command`) | the agent's `memory.profile.set` tool + reflection | `### profile` block in every prompt (gated) |
| **Notes** | freeform episodic observations, keyword-searchable | `memory.notes.store` tool + reflection | top-3 `### recalled` hits + `### memory-index` pointers |
| **Links** | typed edges between related notes (`RELATES_TO`, `CAUSED_BY`, …) | an automatic post-reflection LLM sub-call | neighbour notes pulled into `### recalled` |
| **Lessons** | reusable principles distilled from clusters of related notes | the background consolidator | `### lessons` pointer rows |
| **Procedures** | advisory how-to templates (never auto-executed) | the background consolidator | `### procedures` pointer rows |

Two automatic writers do most of the work: **reflection** (a small LLM call
after each turn that extracts durable facts and notes) and the
**consolidator** (a slow background job that distills repeated notes into
lessons and procedures). You never have to hand-craft any of it — though you
can always just say *"remember this"*.

The store itself never leaves your machine. Memory content does reach the
network as part of the prompts sent to whatever LLM provider you configured —
with the default local `llama-server` it stays fully local.

## Where it lives on disk

Everything is under the state directory — `~/.atomic-agent` by default,
overridable with `ATOMIC_AGENT_STATE_DIR`:

- `<stateDir>/memory.sqlite` — the whole memory fabric: `profile_facts`,
  `memories` (+ the `memories_fts` full-text index), `memory_links`,
  `lessons`, `procedures`, `vote_events`, and (when embeddings are enabled)
  `memory_embeddings`.
- `<stateDir>/sessions.sqlite` — chat transcripts. Separate file; wiping
  memory does not touch your session history, and vice versa.
- `<stateDir>/config.json` — all the `memory.*` switches and knobs.

It is a plain SQLite database — you can look at it directly:

```bash
sqlite3 ~/.atomic-agent/memory.sqlite '.tables'

# active profile facts (superseded versions are kept, filtered here)
sqlite3 ~/.atomic-agent/memory.sqlite \
  "SELECT key, value, pinned FROM profile_facts WHERE superseded_by IS NULL;"

# newest notes (archived = already distilled into a lesson)
sqlite3 ~/.atomic-agent/memory.sqlite \
  "SELECT id, substr(content, 1, 70), tags FROM memories
   WHERE consolidated_into IS NULL ORDER BY updated_at DESC LIMIT 10;"

# distilled lessons and procedures
sqlite3 ~/.atomic-agent/memory.sqlite \
  "SELECT id, status, activation FROM lessons;"
sqlite3 ~/.atomic-agent/memory.sqlite \
  "SELECT id, status, activation FROM procedures;"
```

## Who writes memory, and when

### Explicitly, during a turn

The agent has nine `memory.*` tools. The write-capable ones fire when you ask
("remember that…", "forget that note") or when the agent decides an
observation is worth keeping:

| Tool | Args | What it does |
|---|---|---|
| `memory.profile.set` | `{ key, value, pinned?, keywords? }` | upsert a profile fact (old value is kept as history) |
| `memory.profile.remove` | `{ key }` | delete a profile fact |
| `memory.profile.list` | `{}` | list active facts |
| `memory.profile.history` | `{ key }` | full version chain of one key, oldest first |
| `memory.notes.store` | `{ content, tags? }` | save a freeform note |
| `memory.notes.recall` | `{ query \| id, k?, scope?, tags? }` | BM25 search, or fetch one note by id |
| `memory.notes.forget` | `{ id }` | delete a note |
| `memory.lessons.recall` | `{ query \| id, k? }` | read a distilled lesson's full principle |
| `memory.procedures.recall` | `{ query \| id, k? }` | read a procedure's full step list |

### Automatically, after every turn — reflection

When a turn ends, the runtime fires one small **fire-and-forget** LLM call
(your reply is never delayed by it) that reads the last user/assistant
exchange and outputs either `NONE` or up to a handful of lines like:

```
SET name=Lena
SET deploy_command=make ship [pinned=false; keywords=deploy,ship,release]
NOTE staging flyway migrations need FLYWAY_BASELINE=1 or deploy fails [tags=staging,flyway]
```

- `SET` lines land in the profile store (at most 3 per turn,
  `memory.reflection.maxFactsPerCall`).
- `NOTE` lines land in the notes store with an implicit `reflection` tag (at
  most 2 per turn, `memory.reflection.maxNotesPerCall`).
- The call has a hard timeout (`memory.reflection.timeoutMs`, 10 s); on
  timeout or parse failure nothing is written and the next turn just tries
  again. At most one reflection is in flight per session.

Reflection runs on the same model/provider the agent itself uses. With local
`llama-server` it gets a dedicated server slot so your main conversation's
KV-cache is untouched.

Whether anything gets stored — and how well-worded it is — depends on the
model. Small local models output `NONE` more often and occasionally store
trivia; that is expected, and the voting/eviction layer (below) cleans up
over time.

### In the background, every few hours — the consolidator

An in-process job (on while `memory.lessons.enabled` and
`memory.consolidation.enabled` are both true, which is the default) ticks
every 6 hours (`memory.consolidation.intervalMs`):

1. It looks at notes that have been untouched for at least 24 hours
   (`cooldownMs`) and are not yet archived.
2. It clusters related notes — connected via `memory_links` and sharing a
   tag. Clusters smaller than 3 notes (`minClusterSize`) are skipped; at most
   5 clusters are processed per tick.
3. One LLM call per cluster distills a **lesson** (a one-line *activation*
   pointer + a longer *principle*), and — when `memory.procedures.enabled` —
   optionally a **procedure** (activation + ordered steps) in the same call.
4. The source notes are **archived**: they disappear from the
   `### memory-index` prompt section but stay readable by id (lessons keep
   their parent ids so you can trace where a principle came from).

Procedures are advisory only: the runtime never executes their steps. The
agent reads them via `memory.procedures.recall` and follows, adapts, or
ignores them.

### Housekeeping you get for free

- **Dedup** — a near-duplicate of an existing note is merged instead of
  inserted: full-text search fetches the closest existing notes, and the best
  candidate absorbs the write when its token-overlap (Jaccard) similarity
  clears `memory.dedup.fts5Threshold` (0.85).
- **Voting** — a post-turn sub-call votes surfaced memories up or down by
  usefulness; heavily downvoted profile facts stop rendering even if pinned.
- **Eviction** — hard caps (1000 notes, 500 lessons, 500 procedures) with
  utility-weighted eviction, so the store cannot grow without bound.
- **Links** — after reflection, another small sub-call connects the new and
  recalled notes with typed edges, which later powers both recall expansion
  and consolidator clustering.

## How memory shows up in the prompt

Every prompt the model sees ends with a variable tail. The memory-fed
sections, in order (each one is skipped when empty):

```
### profile
- name: Lena
- language: de

### lessons
*4 [playwright] When a Playwright click flakes, prefer role-based locators

### procedures
>2 [playwright] Stabilise a flaky selector before adding retries

### memory-index
- #17 [reflection, staging, flyway] staging flyway migrations need FLYWAY_…
- #21 [reflection, ci] the release workflow requires a signed tag

### recalled
- #17 [reflection, staging, flyway] staging flyway migrations need FLYWAY_BASELINE=1 or deploy fails
```

The design is **pointers first, bodies on demand**:

| Section | What it carries | Full body via |
|---|---|---|
| `### profile` | active facts, `- key: value` | already the full value |
| `### lessons` | top-2 BM25 hits for the current turn, `*<id> [tags] activation` one-liners | `memory.lessons.recall { id }` |
| `### procedures` | top-2 BM25 hits for the current turn, `><id> [tags] activation` one-liners | `memory.procedures.recall { id }` |
| `### memory-index` | up to 20 most recent notes (minus any already in `### recalled`), 60-char previews | `memory.notes.recall { id }` |
| `### recalled` | top-3 BM25 hits for the current message, 160-char previews | `memory.notes.recall { id }` |

Two gates keep the tail small:

- Profile facts saved with `pinned=false` render only when one of their
  `keywords` appears in your current message — `deploy_command` shows up when
  you talk about deploying, not when you ask about the weather.
- Every section has its own token ceiling (`memory.*.maxTokens`), clipped
  with a `[truncated]` marker.

The `### recalled` search runs once per turn against your current message.
Short referential follow-ups ("and what about there?") are first expanded by
a query rewriter (on by default) using the recent turns, and hits are
expanded one hop through the link graph.

`### lessons` and `### procedures` are gated by the same per-turn recall
query (your message plus recent tool-result summaries), matched against each
row's activation, principle, and tags — only the top
`memory.lessons.recallK` / `memory.procedures.recallK` hits (2 each) render,
so a prompt on an unrelated topic carries no lesson or procedure rows at
all. The complete list is always browsable in the TUI Memory tab.

Optionally, recall can be made hybrid (BM25 + embedding cosine) by enabling
a local embedding model from the TUI's local-models panel — off by default.

## Worked example 1 — a profile fact forms and comes back

*Transcripts are illustrative — exact wording depends on your model.*

**Session 1, Monday:**

```
you   › My name is Lena, answer in German from now on. And remember:
        we deploy with `make ship`, never `git push`-triggered.
agent › Alles klar, Lena — ab jetzt antworte ich auf Deutsch. Gemerkt:
        Deployment läuft über `make ship`.
```

The reply may already include an explicit `memory.profile.set` call (you
asked it to remember). Seconds later, reflection independently distills the
exchange:

```
SET name=Lena
SET language=de
SET deploy_command=make ship [pinned=false; keywords=deploy,ship,release]
```

**Session 2, Thursday (fresh session, same machine):** the first prompt of
the session already contains

```
### profile
- name: Lena
- language: de
```

so the greeting is in German with no tool call and no searching.
`deploy_command` is contextual — it stays out of the prompt until a message
mentions *deploy*, *ship*, or *release*:

```
you   › time to deploy the fix
agent › (prompt now also carries `- deploy_command: make ship`)
        Ich starte das Deployment mit `make ship` …
```

**Changing your mind is versioned, not destructive:**

```
you   › actually, switch back to English
agent › Done — English it is.
```

Reflection emits `SET language=en [valid_from=now; supersedes=language]`. The
old value is not erased; ask *"what language did I use before?"* and the
agent can call `memory.profile.history { key: "language" }` to see the chain
`de → en`.

## Worked example 2 — a note forms, then saves a future session

**Session 1 — while debugging together:**

```
you   › staging deploy failed again with a flyway checksum error
agent › Found it: the staging DB was baselined manually, so migrations must
        run with FLYWAY_BASELINE=1. Deploy is green now. Worth remembering?
you   › yes please
agent › [memory.notes.store { content: "staging flyway migrations need
        FLYWAY_BASELINE=1 — the DB was baselined manually; without the flag
        the deploy fails with a checksum error", tags: ["staging","flyway"] }]
        → stored #17
```

(Had you not asked, reflection would likely have written a similar `NOTE` on
its own — with the implicit `reflection` tag.)

**Session 2 — a week later:**

```
you   › staging is red after the deploy, some flyway checksum thing
```

Before the model answers, the runtime searches notes with that message. Note
#17 scores high and is injected:

```
### recalled
- #17 [staging, flyway] staging flyway migrations need FLYWAY_BASELINE=1 — the DB was baselined manually; without the flag …
```

so the first reply already says *"that's the manually-baselined staging DB —
run migrations with `FLYWAY_BASELINE=1`"*. For a note longer than the 160-char
preview, the agent follows the pointer with
`memory.notes.recall { id: 17 }` to read the full body.

Even when a note does not match the current message, it stays discoverable:
the 20 most recent notes are always listed as one-line pointers in
`### memory-index`, and the agent can search explicitly with
`memory.notes.recall { query: "flyway staging" }`.

## Worked example 3 — repeated episodes become a lesson

Over a week of E2E-test sessions, three separate notes accumulate (some
stored explicitly, some by reflection), all tagged `playwright`, linked to
each other by the automatic link generator:

```
#31 [playwright] click on the submit button flaked; switched to getByRole("button", …) and it stabilised
#38 [playwright] css selector .btn-primary broke after a class rename; role-based locator survived
#44 [playwright] added retries around a click; real fix was a getByRole locator, retries then unnecessary
```

At some point — the consolidator ticks every 6 hours and only touches notes
older than 24 hours — the cluster is distilled in a single LLM call:

- a **lesson** row is created:
  - activation: `When a Playwright click flakes, prefer role-based locators over CSS selectors`
  - principle: the longer distilled reasoning, with `parent_ids: [31, 38, 44]`
- because procedures are enabled, the same call may also emit a **procedure**
  (`Stabilise a flaky selector` with 3–4 ordered steps),
- notes #31/#38/#44 are archived: gone from `### memory-index`, still
  readable by id.

From then on, a prompt whose turn touches the topic carries a one-line
pointer — like `### recalled`, lessons are query-matched (the turn's recall
query against activation/principle/tags, top `memory.lessons.recallK` = 2),
so the row appears when you talk Playwright, not in every prompt:

```
### lessons
*4 [playwright] When a Playwright click flakes, prefer role-based locators over CSS selectors
```

and the agent drills in for the full principle:

```
you   › the checkout e2e test is flaky again on the pay button
agent › [memory.lessons.recall { id: 4 }]
        → activation + full principle + parent note ids
        This matches a pattern we've hit three times — switching the pay
        button click to getByRole("button", { name: "Pay" }) …
```

Lessons are not permanent dogma: each carries success/failure counters and a
vote score, and gets deprecated by age, overflow, or downvotes.

## Inspecting memory

- **TUI Memory tab** — type `/memory` in the chat prompt (or Esc → the menu's
  Manage section → Memory). A read-only browser over `memory.sqlite` with six
  channels: profile, notes, lessons, procedures, votes, links. Keys: `1`–`6`
  or `[`/`]` switch channel, `j`/`k` move, Enter opens a row's full detail
  (note body, lesson principle, procedure steps, profile history), `f`
  cycles the notes archive filter (active/archived/all), `r` refreshes, `a`
  toggles 5-second auto-refresh, and `g` on a note's detail expands its link
  neighbourhood.
- **`/memory dump`** — prints the active profile into the chat transcript.
- **Just ask** — "what do you remember about me?" typically triggers
  `memory.profile.list` and a notes search.
- **sqlite3** — see the queries in "Where it lives on disk" above.

## Forgetting, disabling, wiping

**Forget one thing.** Ask in chat — "forget my deploy command", "delete note
17". The agent uses `memory.profile.remove` / `memory.notes.forget`. There is
deliberately no delete tool for lessons and procedures — they age out via
deprecation and votes; to remove one immediately, edit `memory.sqlite` with
`sqlite3` (or wipe, below).

**Turn a layer off.** Master switches in `<stateDir>/config.json`, all
default-on except embeddings:

| Key | Turns off |
|---|---|
| `memory.reflection.enabled` | automatic fact/note extraction after turns |
| `memory.reflection.autoStoreNotes` | just the automatic notes (facts still extracted) |
| `memory.profile.enabled` | the `### profile` section + profile tools |
| `memory.notes.enabled` | the notes tools |
| `memory.recallInjection.enabled` | the `### recalled` section |
| `memory.index.enabled` | the `### memory-index` section |
| `memory.links.enabled` | link generation + graph expansion |
| `memory.lessons.enabled` | lessons + the consolidator |
| `memory.consolidation.enabled` | just the consolidator (existing lessons stay) |
| `memory.procedures.enabled` | procedures |
| `memory.voting.enabled` | usefulness voting |
| `memory.retrieve.rewriter.enabled` | the recall query rewriter |
| `memory.embeddings.enabled` | hybrid embedding recall (default **off**) |

**Wipe everything.** Stop the agent, then:

```bash
rm ~/.atomic-agent/memory.sqlite*
```

(the glob also catches SQLite's `-wal`/`-shm` journal files). The next start
creates a fresh, empty memory database. Chat history (`sessions.sqlite`),
config, skills, and tasks are untouched.

## Agent memory vs your own notes (Obsidian)

Memory is the agent's private working store — optimised for prompt injection,
not for reading. For notes **you** own and read, atomic-agent ships an
`obsidian` starter skill (auto-installed with the other starter skills on
first run) that reads, searches, and writes plain Markdown in an Obsidian
vault:

- The vault path resolves from the `OBSIDIAN_VAULT_PATH` environment variable
  (put it in `<stateDir>/.env`), falling back to `~/Documents/Obsidian Vault`.
  If neither exists, the skill walks you through it: send the path in chat
  and the agent verifies it and appends it to `~/.atomic-agent/.env` itself.
- "Add this to my notes" → the vault, as Markdown you can open in Obsidian.
- "Remember this" → `memory.sqlite`, surfacing automatically in future
  prompts.

The two compose nicely: the vault holds what you want to read and link;
memory holds what the agent should recall on its own.
