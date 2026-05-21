# atomic-agent — memory fabric v2

> **Status:** **implemented** (phases 1A–7b in `src/memory/`). This document
> remains the design rationale and rollout ledger; **runtime truth** for
> behaviour, defaults, and pinned invariants lives in [`AGENTS.md`](AGENTS.md)
> §"Memory fabric" (kept in sync with the code). Use this file for *why* and
> *research context*; use AGENTS for *what ships today*.
>
> **v2.5 add-ons:** [`MEMORY_FABRIC_V2.5.md`](MEMORY_FABRIC_V2.5.md) (phases A–C,
> opt-in). Operator scenarios for v2: §14 below + [`eval-memory/PLAN.md`](eval-memory/PLAN.md).
>
> Companions: [`MEMORY.md`](MEMORY.md) (v1 baseline), [`PROMPT.md`](PROMPT.md)
> (variable tail anatomy), [`EVOLUTION.md`](EVOLUTION.md) (sibling planning docs).

## Table of contents

0. [Implementation ledger](#0-implementation-ledger)
1. [Why this document exists](#1-why-this-document-exists)
2. [Current state: what we have today](#2-current-state-what-we-have-today)
3. [Research landscape: surveyed approaches](#3-research-landscape-surveyed-approaches)
4. [Conceptual frame: Experience Compression Spectrum](#4-conceptual-frame-experience-compression-spectrum)
5. [Design path B+C: combined reactive graph + periodic consolidation](#5-design-path-bc-combined-reactive-graph--periodic-consolidation)
6. [Architecture: three execution paths](#6-architecture-three-execution-paths)
7. [Schema migrations](#7-schema-migrations)
8. [Code map: new files and changes](#8-code-map-new-files-and-changes)
9. [Invariants and pinned tests](#9-invariants-and-pinned-tests)
10. [Configuration surface](#10-configuration-surface)
11. [Observability: metrics, logs, traces](#11-observability-metrics-logs-traces)
12. [Conflicts between B and C, and how to resolve them](#12-conflicts-between-b-and-c-and-how-to-resolve-them)
13. [Risks and trade-offs](#13-risks-and-trade-offs)
14. [Phased rollout plan](#14-phased-rollout-plan)
15. [Open questions for the author](#15-open-questions-for-the-author)
16. [Out of scope (deferred)](#16-out-of-scope-deferred)
17. [References](#17-references)

---

## 0. Implementation ledger

All paths below are **in the tree** unless marked deferred. Feature flags
default **off** for phases 2–7b and v2.5 unless noted; phase **1A** defaults
are **on** (`memory.dedup`, `memory.eviction`). See §10 for the full config
table and [`src/config/config-schema.ts`](src/config/config-schema.ts)
`USER_CONFIG_DEFAULTS` (config file version **19** at time of writing).

| Phase | Goal (short) | Schema | Config gate | Code home |
|-------|----------------|--------|-------------|-----------|
| **1A** | Utility eviction, FTS5 dedup, `recall_count` | v4 columns on `memories` | `memory.dedup.*`, `memory.eviction.*` (defaults on) | [`memory-store.ts`](src/memory/memory-store.ts), [`memory-store-v2.test.ts`](src/memory/memory-store-v2.test.ts) |
| **1B** | Hybrid FTS5 + embedding recall | v5 `memory_embeddings` | `memory.embeddings.*` + `localModels.embeddings.*` (default off) | [`src/memory/embeddings/`](src/memory/embeddings/) |
| **2** | Reactive link graph | v6 `memory_links` | `memory.links.*` (default off) | [`src/memory/links/`](src/memory/links/) |
| **3** | Neighbor tag evolution (`EVOLVE`) | v4 `consolidating_at` (dormant until here) | `memory.evolution.*` (default off) | [`src/memory/evolution/`](src/memory/evolution/) |
| **4** | Bi-temporal `ProfileStore` | v7 `profile_facts` rebuild | always-on after migration | [`profile-store.ts`](src/memory/profile-store.ts), [`memory.profile.history`](src/tools/memory/profile-history.ts) |
| **5** | Lessons + cold consolidator | v8 `lessons`, `consolidated_into` | `memory.lessons.*`, `memory.consolidation.*` (default off) | [`src/memory/lessons/`](src/memory/lessons/), [`src/memory/consolidator/`](src/memory/consolidator/) |
| **6** | Lesson lifecycle + deprecation | (v8 columns) | same as phase 5 | [`lesson-lifecycle-hook.ts`](src/memory/lessons/lesson-lifecycle-hook.ts), consolidator sweep |
| **7a** | ExpeL-style vote curation | v9 `vote_score`, `vote_events` | `memory.voting.*` (default off) | [`src/memory/voting/`](src/memory/voting/) |
| **7b** | MemP-style procedure templates | v10 `procedures` | `memory.procedures.*` (default off) | [`src/memory/procedures/`](src/memory/procedures/), [`memory.procedures.recall`](src/tools/memory/procedures-recall.ts) |

**v2.5 (default-off):** query rewriter (A), reflection segmentation (B),
typed `NOTE` markers (C) — see [`MEMORY_FABRIC_V2.5.md`](MEMORY_FABRIC_V2.5.md).

`MEMORY_SCHEMA_VERSION` is **10** in
[`memory-schema.ts`](src/memory/memory-schema.ts) (not the v7 figure used in
early drafts of §7–§8).

### Deliberate plan deviations (documented)

1. **KV-cache invalidation (stable prefix).** The original plan assumed a
   **single** persona change when `### lessons` landed. Production rollout
   pays **two** one-time main-slot invalidations: phase 5 (`### lessons`) and
   phase 7b (`### procedures`) — both in [`stable-prefix.ts`](src/prompt/stable-prefix.ts).
2. **Consolidator timer.** The cold path uses a **scoped `setInterval`** inside
   [`consolidator-job.ts`](src/memory/consolidator/consolidator-job.ts) (second
   carve-out next to Telegram long-polling), **not** the task `Scheduler`.
3. **Link kinds.** Shipped kinds are
   `RELATES_TO | CAUSED_BY | REFERENCES | CONTRADICTS | DUPLICATES | SUPERSEDES`
   (see `LINK_KINDS` in [`link-store.ts`](src/memory/links/link-store.ts)), not
   the draft `related` / `consolidated_with` names in §7 below.
4. **Deferred agent tools.** Only read tools shipped:
   `memory.lessons.recall`, `memory.procedures.recall`, `memory.profile.history`.
   `memory.lessons.list`, `memory.procedures.{store,list,deprecate}` remain
   deferred (inspect via SQLite / CLI).
5. **Vote `EDIT` marker.** Phase 7a ships **up/down only**; `EDIT` is deferred.
6. **Procedure shape.** No separate `parameters` JSON column; steps use
   `description` + optional `toolHint` in a single `steps` JSON array.

---

## 1. Why this document exists

The current memory subsystem (described in [`MEMORY.md`](MEMORY.md)) is solid for
a single-machine, single-user local operator. It survives across sessions, it
never blows up the SQLite file, and it does not violate KV-cache hygiene. But:

- BM25 misses paraphrases — **mitigated** by optional phase 1B hybrid recall.
- Notes are isolated — **addressed** by phase 2 link graph (opt-in).
- FIFO eviction — **addressed** by phase 1A utility-weighted eviction.
- Near-duplicate writes — **addressed** by phase 1A FTS5 dedup.
- No periodic consolidation — **addressed** by phase 5 consolidator (opt-in).
- No procedural memory — **addressed** by phase 7b procedure templates (opt-in).
- Profile overwrites history — **addressed** by phase 4 bi-temporal store.
- No episode → lesson distillation — **addressed** by phases 5–6 (opt-in).

Remaining v1 limitations (still true): no cross-machine sync, no secret
redaction, no per-task memory pools — see [`MEMORY.md`](MEMORY.md) §10 and
§16 below.

This document records the v2 design that **shipped** in `src/memory/` while
preserving every architectural invariant from [`AGENTS.md`](AGENTS.md).

## 2. Current state: what we have today

One SQLite file `<stateDir>/memory.sqlite` (schema v10). The v1 three-channel
shape is still the core; v2 adds parallel **read surfaces** and **cold-path**
artefacts:

| Channel / artefact | Storage | Auto read (variable tail) | Write path |
|---|---|---|---|
| `ProfileStore` | `profile_facts` (bi-temporal v7+) | `### profile` (active rows; vote filter when 7a on) | `memory.profile.*` + reflection `SET` |
| `MemoryStore` | `memories` + `memories_fts` (+ optional `memory_embeddings`) | `### recalled` + `### memory-index` (archived rows hidden from index) | `memory.notes.*` + reflection `NOTE` |
| Link graph (phase 2) | `memory_links` | BFS expansion folded into recall | `link-generator` after reflection |
| Lessons (phase 5) | `lessons` + `lessons_fts` | `### lessons` (pointer-only) | consolidator distillation |
| Procedures (phase 7b) | `procedures` + `procedures_fts` | `### procedures` (pointer-only) | same distillation slot as lessons |
| Vote scores (phase 7a) | columns + `vote_events` audit | rerank / filter only (not raw scores in prompt) | `vote-runner` after reflection |
| Reflection | n/a | n/a | fire-and-forget on reflection slot; optional v2.5 segmentation |

**Recall pipeline (when flags are on):** optional query rewriter (v2.5 A) →
`MemoryStore.recallHybridAsync` (FTS5, or FTS5+cosine if 1B on) → optional link
expansion → lesson/procedure BM25 recall for tail pointers.

Key invariants we must not break:

- Stable prefix is byte-stable — memory writes only touch the variable tail.
- Reflection runs on a dedicated llama-server slot; the main agent slot's
  KV-cache survives.
- The notes corpus is never dumped wholesale into the prompt; only top-K
  `### recalled` and pointer-only `### memory-index` rows go in.
- Memory state is single-machine, single-user. No cross-machine sync, no
  encryption-at-rest, no per-task scopes (deliberate non-goals from
  `MEMORY.md` §1).

## 3. Research landscape: surveyed approaches

A condensed map of the agentic-memory research surface as of Q1 2026, grouped
by structural family (taxonomy borrowed from
[*Anatomy of Agentic Memory*](https://arxiv.org/abs/2602.19320), Jiang et al.
2026):

### 3.1 Lightweight Semantic
Append-only vector store with top-K retrieval. Where we live today (FTS5
instead of vectors). Representative work: **Mem0**
([arXiv:2504.19413](https://arxiv.org/abs/2504.19413)), **LightMem**
([arXiv:2510.18866](https://arxiv.org/abs/2510.18866)).

### 3.2 Entity-Centric / Personalized
Schema-bounded key/value records about users, tasks, preferences. Where our
`ProfileStore` lives. Representative work:
- **EgoMem** ([arXiv:2025](https://arxiv.org/abs/2509.04279)) — lifelong
  multimodal profile with conflict-aware updates.
- **MemOrb** — compact reflective memories for continual improvement.
- **Memory-R1** ([arXiv:2508.19828](https://arxiv.org/abs/2508.19828)) — RL
  policy for entity-fact-bank management.

### 3.3 Episodic & Reflective
Temporal abstraction + periodic consolidation. The growth direction we
propose. Representative work:
- **A-MEM (Zettelkasten)** ([arXiv:2502.12110](https://arxiv.org/abs/2502.12110),
  NeurIPS 2025) — atomic notes + LLM-generated context/keywords/tags +
  dynamic linking + memory evolution. Empirically +30–50% F1 on multi-hop
  vs MemGPT on LoCoMo, with ~7–13× fewer tokens. Works down to
  Qwen-2.5-3B / Llama-3.2-1B. **Repo:** https://github.com/agiresearch/A-mem.
- **TiMem** ([arXiv:2026](https://arxiv.org/abs/2602.01869v1)) —
  temporal-hierarchical memory tree, distills trajectories into procedural
  abstractions without RL.
- **MemoryBank** ([arXiv:2305.10250](https://arxiv.org/abs/2305.10250)) —
  Ebbinghaus forgetting curve for utility-weighted eviction.
- **Nemori** ([arXiv:2025](https://arxiv.org/abs/2505.10250)) —
  episodic → semantic consolidation, expensive (~7M tokens for index
  build).

### 3.4 Structured & Hierarchical
Multi-tier / graph / RL-policy designs. Heavier; some are out of scope for
our local-only profile. Representative work:
- **MemGPT** ([arXiv:2310.08560](https://arxiv.org/abs/2310.08560)) —
  OS-inspired paging.
- **MemoryOS** ([arXiv:2506.06326](https://arxiv.org/abs/2506.06326)) —
  three-level hierarchy. *Anatomy* paper reports 32+ s latency per turn,
  unsuitable for interactive use.
- **MAGMA** ([arXiv:2026](https://arxiv.org/abs/2603.18718)) — knowledge
  graphs with semantic/temporal/causal/entity layers.
- **Zep** ([arXiv:2025](https://arxiv.org/abs/2501.13956)) — bi-temporal
  knowledge graph with episodic and semantic layers.
- **MEM1 / Memory-T1 / Mem-α** — RL-trained policies for memory CRUD.
  Out of scope: requires training infrastructure we do not have.
- **MemGen / TokMem** — latent memory tokens via LoRA. Out of scope:
  requires fine-tuning, breaks the external-llama-server invariant.

### 3.5 Learning-from-experience (procedural memory)

A parallel research community, almost no cross-citation with the memory
community (<1% per *Experience Compression Spectrum*). Representative work:

- **Voyager** ([arXiv:2305.16291](https://arxiv.org/abs/2305.16291),
  TMLR 2024) — skill library of executable code, automatic curriculum,
  iterative prompting with self-verification. 3.3× more unique items,
  15.3× faster tech-tree on Minecraft.
- **ExpeL** ([arXiv:2308.10144](https://arxiv.org/abs/2308.10144),
  AAAI 2024) — insights list with `ADD`/`UPVOTE`/`DOWNVOTE`/`EDIT`
  operations. Learns from success and failure across trajectories without
  fine-tuning. **Repo:** https://github.com/LeapLabTHU/ExpeL.
- **MemP** ([arXiv:2508.06433](https://arxiv.org/abs/2508.06433)) —
  procedural memory at two granularities: fine-grained step-by-step and
  script-like abstractions. Build / Retrieve / Update lifecycle. Empirically
  transferable from strong to weak models. **Repo:**
  https://github.com/zjunlp/MemP.
- **ProcMEM** ([arXiv:2602.01869](https://arxiv.org/abs/2602.01869v1),
  ICML 2026) — Skill-MDP formalization (activation / execution /
  termination conditions) + Non-Parametric PPO for skill evolution
  through semantic gradients and a clipped-surrogate "PPO Gate".
  **Repo:** https://github.com/Miracle1207/ProcMEM.
- **AutoSkill** / **CASCADE** / **EvoSkill** — skill lifecycle management
  (versioning, conflict detection, deprecation).

### 3.6 Spreading activation, latent memory, etc.
- **Synapse** ([arXiv:2601.02744](https://arxiv.org/abs/2601.02744)) —
  episodic-semantic memory via spreading activation with lateral inhibition
  and temporal decay instead of static cosine.
- **MemGen** — generative latent memory framework. Requires LoRA — out of
  scope.

### 3.7 Prior art: Hermes Agent (NousResearch) — independent validation and pitfalls

[`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent)
is the closest sibling system in the OSS local-agent space. Worth studying
because its community independently converged on essentially the same
design we are proposing here, and tried to ship it via
[PR #727](https://github.com/NousResearch/hermes-agent/pull/727) — which
was closed after a critical code review. The closed-PR review is the most
useful single document for our v2 risk register.

**Hermes built-in memory** is intentionally minimalist:

- Two flat markdown files in `~/.hermes/memories/`: `MEMORY.md`
  (~2200 chars / ~800 tokens) for agent notes, `USER.md`
  (~1375 chars / ~500 tokens) for user profile.
- **Frozen snapshot pattern**: memory is loaded into the system prompt
  exactly once at session start; mid-session writes persist to disk but
  do not reappear in the prompt until the next session. This is their
  KV-cache hygiene mechanism — different from ours, where the equivalent
  data lives in the variable tail and refreshes per turn.
- Agent-managed via a `memory.add/replace/remove` tool with substring
  matching.
- Plus `session_search`: SQLite FTS5 over the **entire raw session
  history**, with on-demand Gemini Flash summarization of hits. Different
  shape from our `MemoryStore` — they keep raw turns, we keep extracted
  notes.

Our current built-in is **architecturally richer** than theirs: contextual
gate on profile, auto-injection of recalled notes, structured tagged
entries, FTS5 over a curated set rather than raw history. Their lever for
"more memory" is the plugin layer.

**Hermes pluggable providers** (one active at a time, additive to built-in):
`honcho`, `mem0`, `hindsight`, `holographic`, `retaindb`, `byterover`,
`supermemory`, `openviking`. Most delegate to an external service or SaaS
(Honcho Cloud, mem0, etc.). This is a fundamentally different architectural
choice from ours — we stay local-first, in-process, no external
dependencies.

**Hermes PR #727 — closed cognitive memory system.** Filed by an external
contributor (`@0xbyt4`); 4169 LoC, 19 files, 177 tests; closed by
`@teknium1` with "Lets make this a plugin if we want this to live on".
What it tried to ship:

- Semantic recall via LiteLLM-routed embeddings (any provider).
- Composite scoring: `0.5×similarity + 0.3×recency + 0.2×importance`.
- Cognitive encoding: heuristic auto-classification into
  `fact / preference / procedure / environment / ...`.
- Contradiction detection: new entry conflicting with old →
  automatic supersede. (Same role as our bi-temporal `ProfileStore`.)
- Forgetting: `importance × 0.5^(days/half_life)`, prune below 0.05.
- Consolidation: pairwise cosine ≥ 0.92 → merge.
- Proactive storage without explicit user request.

Concept-for-concept, this overlaps with our combined B+C path
**plus embeddings**. The reasons it was rejected are exactly the risks
we name in §13 — see §13.7 below for the explicit list of pitfalls
transcribed into our design constraints.

### 3.8 Surveys / framing documents
- *Anatomy of Agentic Memory: Taxonomy and Empirical Analysis of Evaluation
  and System Limitations*, Jiang et al. 2026
  ([arXiv:2602.19320](https://arxiv.org/abs/2602.19320)).
- *Experience Compression Spectrum: Unifying Memory, Skills, and Rules in
  LLM Agents*, Zhang et al. 2026
  ([arXiv:2604.15877](https://arxiv.org/abs/2604.15877)).
- *Memory for Autonomous LLM Agents: Mechanisms, Evaluation, and Emerging
  Frontiers*, 2026 ([arXiv:2603.07670](https://arxiv.org/abs/2603.07670)).
- *From Human Memory to AI Memory: A Survey on Memory Mechanisms in the Era
  of LLMs*, 2025
  ([arXiv:2504.15965](https://www.arxiv.org/pdf/2504.15965)).

## 4. Conceptual frame: Experience Compression Spectrum

The unifying frame from
[*Experience Compression Spectrum*](https://arxiv.org/abs/2604.15877)
positions every reusable knowledge artefact along one axis of compression:

| Level | Content | Format | Compression | Where in our stack |
|---|---|---|---|---|
| **L0** raw trace | what happened, verbatim | session turns | 1:1 | `SessionState.turns[]`, `<stateDir>/traces/*.ndjson` |
| **L1** episodic memory | what happened, gist | k/v, summaries | 5–20× | our `MemoryStore`, also A-MEM, Mem0, MemoryOS |
| **L2** procedural skill | how to act in a class of situations | structured routines | 50–500× | Voyager, SkillWeaver, MemP, AutoSkill |
| **L3** declarative rule | what principles govern decisions | domain-invariant constraints | 1000×+ | hand-written `.cursorrules`, `CLAUDE.md`, RuleShaping |

Two empirical patterns from this paper that drive our design choices:

1. **Higher compression consistently wins on benchmarks.** SkillRL `L₂` vs
   `L₁` retrieval: **+68.5 pp on ALFWorld**. Trace2Skill `L₂` vs human-written
   skill: **+21.5 pp on SpreadsheetBench**. RuleShaping `L₃` constraints vs
   zero-shot: **+7–14 pp on SWE-bench**.
2. **Curation matters more than the level.** SkillsBench: curated `L₂` =
   **+16.2 pp**, self-generated `L₂` without curation = **+0.0 pp**.
3. **No surveyed system supports adaptive cross-level compression.** This is
   the "missing diagonal" — promoting episodes to lessons to rules as
   evidence accumulates, demoting on failure.

**Where we sit today:** dense `L₁`, partial entity-centric `L₁+`, and an
indirect `L₃` (hand-curated skills in `src/skills/`). We have no `L₂` learned
from interaction, and no promotion/demotion mechanism.

**Where v2 landed (implemented).** Path B+C (phases 1A–6, opt-in where
flagged) closes `L₁ → L₁+` and the first `L₁ → L₂-as-lessons` step.
**Phase 7 (shipped, opt-in)** adds (a) ExpeL-style vote curation
over everything we accumulate (so the corpus stays high-signal under self-
generation pressure — see §13.3 and §13.7.8), and (b) MemP-style structured
**procedure templates** as a parallel `L₂` artefact derived alongside
`lessons`. Phase 7 is **mandatory** for v2; without curation, the empirical
SkillsBench result (self-generated `L₂` without curation = +0.0 pp) makes
the lesson channel a wash. Voyager-style executable code-skills and
ProcMEM-style PPO-Gate skill evolution stay out of scope (§16) — they
require a different safety surface (sandbox, approval, signed artefacts)
and live behind the existing `Skill` mechanism in `src/skills/` rather
than inside `memory.sqlite`.

## 5. Design path B+C: combined reactive graph + periodic consolidation

We chose to combine two paths surfaced during analysis:

- **Path B** (Zettelkasten): A-MEM-style link generation between notes +
  reactive memory evolution + bi-temporal `ProfileStore` for conflict-aware
  versioning of identity facts. Operates on the **hot write path**, per
  turn.
- **Path C** (CLS-style two-layer): episodes + lessons + periodic
  consolidator that batches clustered episodes into higher-compression
  lessons. Operates on the **cold consolidation path**, via the existing
  `Scheduler`.

Combining them is not a forced marriage — it matches the
**Complementary Learning Systems** (CLS) theory from
[McClelland et al. 1995](https://psycnet.apa.org/record/1995-37607-001),
cited as the cognitive-science precedent for the Experience Compression
Spectrum paper:

| CLS analog | Our component | Spectrum level | Timescale |
|---|---|---|---|
| Hippocampus (fast episodic write) | `MemoryStore` + reflection | L1 | per turn |
| Synaptic plasticity (local) | A-MEM links + evolution (B) | L1++ | per turn |
| Gist of identity (semantic memory of self) | bi-temporal `ProfileStore` (B) | L1+ entity | per turn |
| Neocortex (slow consolidation) | Lessons store + consolidator (C) | L1 → L2 | per N hours |
| Forgetting / pruning | utility-eviction + demotion | meta | per N hours |

Path B provides path C with a **ready clustering signal**: connected
components in the link graph plus shared tags are natural distillation
candidates. Path C in return gives path B a **garbage-collection mechanism**:
once N episodes are consolidated into one lesson, the links between them are
rewired to dangle off the lesson node, and the graph stays sparse and
meaningful.

Phase 7 layers two more paths on top of B+C without disturbing them:

- **Path E (per-turn vote curation, ExpeL-style)** — after the existing
  reflection pipeline finishes, an additional micro-call examines what
  was actually surfaced in this turn's prompt (`### profile`, `### lessons`,
  `### procedures`, `### recalled`) and emits `UPVOTE` / `DOWNVOTE` / `EDIT`
  markers. Vote scores feed back into utility-eviction and recall ranking.
  Path E is the **selection pressure** that turns "self-generated L₂" from
  noise into signal.
- **Path P (cold procedure distillation, MemP-style)** — the consolidator
  in path C grows a sibling step: when a cluster's parent episodes contain
  a clear repeated tool-call sequence, the same distillation slot also
  produces a `Procedure` (activation + ordered steps + parameters), stored
  alongside the lesson. Procedures are **read-only guidance** rendered as
  `### procedures` between `### lessons` and `### recalled` — the agent
  reads them and decides; they never auto-execute. The Voyager-style
  executable seam stays at `src/skills/` and is not extended in v2.

CLS analog mapping extends accordingly: path E is the **synaptic-plasticity
gating** (Hebbian reinforcement of co-active traces); path P is the
**procedural / motor-learning** layer (basal-ganglia-style routine
abstraction), distinct from the neocortical declarative layer that path C
builds.

## 6. Architecture: three execution paths

### 6.1 Hot read path (per turn, same shape as today)

```text
runTurn(userMessage):
  memoryContextProvider.buildMemoryContext():   # optional rewriter (v2.5 A)
    recalled = MemoryStore.recallHybridAsync(userMessage)       # L1 (+ 1B vectors)
    recalled += LinkStore.expand(seedIds) when links on        # B
    lessons  = LessonStore.recall(userMessage) when lessons on # L2 (C)
    procedures = ProcedureStore.recall(...) when procedures on # P (7b)
    profile  = ProfileStore.list() + keyword gate + vote filter # B + 7a
    index    = MemoryStore.listIndex(excludeArchived) - recalled ids
  buildPrompt with tail order:
    ### loaded-skills?
    ### profile         # active version only, bi-temporal
    ### lessons         # NEW (phase 5) — compact pointer rows
    ### procedures      # NEW (phase 7b) — compact pointer rows
    ### recalled
    ### memory-index
    ### session-facts?
    ### world
    ### conversation
    ### respond
```

`### lessons` is a compact pointer view: one line per lesson, `*<id>
[scope/tags] one-line gist`, fed by `LessonStore.listIndex`. Full text of a
lesson is fetched via the new `memory.lessons.recall { id }` tool (so an
agent that wants more detail can drill down). Token budget:
`memory.lessons.maxTokens` (default `300`), subtracted from the
effective conversation cap in the same place we already subtract
`memory.profile.maxTokens`.

`### procedures` (phase 7b) follows the same shape: one line per procedure,
`*<id> [tags] activation`, fed by `ProcedureStore.listIndex`. Full body —
ordered steps, parameters, optional tool hints — fetched via
`memory.procedures.recall { id }`. Token budget
`memory.procedures.maxTokens` (default `400`), subtracted from the
effective conversation cap. Recall is keyword-matched against the current
`userMessage` via FTS5 over the `activation` field; top-K
(`memory.procedures.recallK`, default `2`) surface in the pointer view.
Vote scores from path E (see §6.4) re-rank both `### lessons` and
`### procedures` so consistently downvoted entries fall off the index
before they fall off storage.

### 6.2 Reactive write path (per turn, via reflection — path B)

Reflection grammar gains three new branches in addition to the existing
`NONE | SET | NOTE`:

```text
NONE
SET key=value
SET key=value [pinned=false; keywords=a,b]
SET key=value [valid_from=now; supersedes=key]         # NEW: bi-temporal
NOTE body [tags=a,b]
NOTE body [tags=a,b; links=#42,#103]                   # NEW: explicit links hint
EVOLVE #42 [context="..."; tags=a,b]                   # NEW: neighbor update
```

Pipeline inside `ReflectionRunner.runOne`:

1. Parse SET/NOTE/EVOLVE lines as today.
2. For each `NOTE`: after `MemoryStore.store(note)`, call
   `linkGenerator.generate({ note, k: memory.links.candidateK })`. This is
   **one extra LLM call on the reflection slot**, asking the model to choose
   `0..memory.links.maxPerNote` neighbours from a candidate list found via
   FTS5 / tags overlap.
3. For each link target, `neighborEvolver.tryEvolve({ target, newNote })`.
   This is bounded by `memory.evolution.maxPerWrite` (proposed default `2`)
   and updates only **metadata** of the neighbour (`tags`, `context`),
   never `content` — this preserves the append-only contract of
   `MemoryEntry.content` and keeps `trace-recorder.ts` invariants intact.
4. For each `SET` with `supersedes`: mark the existing row
   `superseded_by = newRowId`, insert the new row with
   `supersedes = oldRowId`. The renderer filters by
   `valid_from <= now AND superseded_by IS NULL`.

All of step 2–4 happens on the **same reflection slot** under the same
existing timeout (`memory.reflection.timeoutMs`). The total budget is shared
across SET / NOTE / link generation / evolution. Fire-and-forget remains the
contract.

### 6.3 Cold consolidation path (periodic — path C)

A new `ConsolidatorJob` registers with the existing `Scheduler`
([`src/scheduler/scheduler.ts`](src/scheduler/scheduler.ts)). Tick period
`memory.consolidation.intervalMs` (proposed default `21_600_000` = 6 hours).
On each tick:

1. **Select** candidates from `MemoryStore`:
   `created_at < now - memory.consolidation.cooldownMs`
   (proposed default `24h`, lets hot episodes cool down)
   AND `consolidated_into IS NULL`.
2. **Cluster** by graph connected-components (from `memory_links` introduced
   in B) intersected with `tags`. Minimum cluster size
   `memory.consolidation.minClusterSize` (proposed default `3`).
3. **Distill** each cluster via one LLM call on the reflection slot:
   "given these N related episodes, produce a lesson with `activation`
   (one sentence: when this lesson applies), `principle` (1–3 sentences:
   the durable observation), `example` (optional reference to one or
   two parent episode ids)". Output is GBNF-constrained (new
   `lesson-grammar.gbnf`).
4. **Persist** the lesson into `LessonStore` with a back-reference array of
   parent episode ids.
5. **Archive parents**: set `consolidated_into = <lessonId>`. They drop out
   of the hot `### memory-index` view but are **never deleted** — direct
   access via `memory.notes.recall { id }` still works (audit / trace
   integrity).
6. **Rewire links**: edges entirely inside the cluster are deleted; edges
   that cross the cluster boundary have their inside endpoint replaced
   with the new lesson id.
7. **Utility-eviction**: rows with
   `recall_count == 0 AND consolidated_into IS NULL AND age > memory.eviction.maxAgeMs`
   are deleted. This replaces the current
   FIFO-by-`updated_at`. Default `maxAgeMs` ~30 days, configurable.
8. **Lesson deprecation**: lessons with
   `success_count == 0 AND age > memory.lessons.deprecationAgeMs`
   are marked `status = "deprecated"` (excluded from `### lessons` and
   recall, kept on disk).

Failure modes: fire-safe like reflection. Errors logged, counted in
`agent.memory.consolidation.run{outcome=failed}`, never bubble into the
scheduler tick loop.

### 6.4 Vote curation path (phase 7a — ExpeL-style)

After the main reflection pipeline (§6.2) finishes its SET / NOTE /
EVOLVE work, `ReflectionRunner` issues **one additional sub-call on the
same reflection slot under the same shared timeout** asking the model to
review which items were actually surfaced in this turn's prompt and emit
zero or more vote markers:

```text
NONE
UPVOTE   <kind>:<id>                                # increment vote_score
DOWNVOTE <kind>:<id>                                # decrement vote_score
EDIT     <kind>:<id> [content="...", tags=a,b]      # metadata refinement
```

Where `<kind> ∈ { profile | lesson | procedure | memory }` and `<id>` is
the row id. The micro-prompt **explicitly enumerates the items eligible
to vote on** (the ones that were in this turn's variable tail) — the
parser rejects votes against any `<kind>:<id>` not in that allowlist.
This is the load-bearing anti-feedback-loop guard: the model cannot
upvote items it has not actually seen in context, so it cannot
hallucinate a phantom corpus into existence.

Vote application:

1. `vote_score` is a single `REAL` column on each of `memories`,
   `lessons`, `profile_facts`, `procedures`. Defaults to `0.0`.
2. UPVOTE adds `+1` clamped at `+memory.voting.maxVotePerItem` (default
   `50`); DOWNVOTE subtracts `1` clamped at `-memory.voting.maxVotePerItem`.
   The clamp is mandatory — unbounded scores let one obsessive run
   dominate ranking forever.
3. `EDIT` targets only metadata (`tags`, `keywords`, profile `value`); it
   never rewrites `content` of `memories` (append-only invariant from
   §6.2 step 3 still holds) and never rewrites the `principle` of a
   `lesson` (parents are still queryable; an EDIT against a lesson
   produces a new lesson row that supersedes the old one, preserving
   trace integrity).
4. Voting integrates with utility-eviction in §6.3 step 7: the eviction
   predicate becomes
   `recall_count == 0 AND vote_score <= 0 AND age > maxAgeMs`,
   and ordering favours lower `vote_score` first.
5. Voting integrates with lesson deprecation in §6.3 step 8:
   `success_count == 0 AND vote_score < 0 AND age > deprecationAgeMs`.
6. Vote-score decay: on each consolidator tick, all `vote_score` values
   are scaled by `memory.voting.signalDecay` (default `0.95`). Without
   decay, ancient upvotes pin items forever; this is the same
   Ebbinghaus-shaped pressure that MemoryBank applies to recall freshness,
   borrowed for selection pressure.

**Distinction from `success_count` / `failure_count` in phase 6.** The
phase-6 counters are **automatic** — bumped by the agent loop when a
turn that surfaced item X ends in `reply` vs `loop_failed`. Phase 7a
votes are **judged** — the reflection LLM evaluates whether the item was
actually relevant to *this* turn's outcome (an item can be surfaced and
ignored, or surfaced and helpful, or surfaced and misleading). Both
signals coexist; ranking combines them as
`combinedScore = 0.6 * vote_score + 0.4 * (success_count - failure_count)`
(weights configurable via `memory.voting.scoreBlend`).

Path E never blocks a turn: the voting sub-call is fire-and-forget under
the existing reflection timeout. Total reflection budget after phase 7a
is `1 (extract SET/NOTE/EVOLVE) + N (link generation) + M (neighbour
evolve) + 1 (votes)` LLM calls per turn, all on the reflection slot —
see §13.1 for updated latency analysis.

### 6.5 Procedure distillation path (phase 7b — MemP-style)

The consolidator in §6.3 gains a sibling step (3.5) that runs **on the
same distillation LLM call** as lesson creation. The distillation prompt
asks the model to produce **two** structured outputs from the cluster:

- A `Lesson` (existing): `activation`, `principle`, optional `example`.
- A `Procedure` (new, conditional): `activation` (when this procedure
  applies — one sentence), `steps[]` (ordered, 2–8 entries; each step
  has a free-text description and optional `toolHint` referencing a
  tool name from our registry), `parameters[]` (named slots with
  description), optional `tags[]` inherited from parents.

The model is instructed to emit a `Procedure` **only when the cluster's
parent episodes show a recognisable repeated tool-call sequence** (the
distillation prompt receives the compressed tool-result chains from
parent `memories` for that purpose). When no such pattern exists, the
distillation emits `procedure: null` and only the lesson is persisted —
this is the cheap path for clusters that are conceptual rather than
procedural. The lesson grammar is extended into a single
`lesson-and-procedure-grammar.gbnf` so the GBNF constraint covers both
shapes in one structured output (no second LLM call).

Procedures are **read-only guidance**:

1. They render as a compact pointer in `### procedures` (see §6.1) — full
   body fetched on demand via `memory.procedures.recall { id }`.
2. They are **never executed automatically**. The agent reads the steps
   like it reads a lesson and decides whether to follow them, deviate,
   or ignore. The runtime never inspects `Procedure.steps` to fire tool
   calls. This is the load-bearing line between phase 7b (textual
   guidance) and Voyager (executable code-skills) — see §16.
3. They participate in path E: vote_score, eviction, deprecation. A
   procedure that consistently leads to `loop_failed` and downvotes
   gets demoted to `status='deprecated'` (excluded from `### procedures`
   and recall, kept on disk for audit).
4. Hard cap `memory.procedures.maxEntries` (default `500`) with FIFO
   eviction by `(deprecated, vote_score ASC, updated_at ASC)` as
   belt-and-braces.

Agent-side tools: **`memory.procedures.recall`** shipped (frequent tier).
`memory.procedures.store` / `.list` / `.deprecate` remain deferred (§0).

## 7. Schema migrations

**Shipped:** `MEMORY_SCHEMA_VERSION = 10` in
[`src/memory/memory-schema.ts`](src/memory/memory-schema.ts). Migrations are
idempotent and run from `applyMigrations(db)` on every open of `memory.sqlite`.

The subsections below retain the **original design SQL** where still accurate;
see §0 for the **actual version map**. Early drafts incorrectly folded link
graph + `recall_count` into one step — the code split them as v4 / v5 / v6.

| Version | Phase | What landed |
|---------|-------|-------------|
| v3 | v1 profile | `pinned`, `keywords` on `profile_facts` |
| v4 | 1A | `recall_count`, `last_recalled_at`, `consolidating_at` on `memories` |
| v5 | 1B | `memory_embeddings` |
| v6 | 2 | `memory_links` |
| v7 | 4 | bi-temporal `profile_facts` rebuild |
| v8 | 5 | `lessons`, `consolidated_into` on `memories` |
| v9 | 7a | `vote_score` on `memories` / `lessons` / `profile_facts`; `vote_events` |
| v10 | 7b | `procedures` + `procedures_fts` |

### v6 → v7 (shipped): link graph

```sql
CREATE TABLE memory_links (
  from_id     INTEGER NOT NULL,
  to_id       INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  weight      REAL NOT NULL DEFAULT 1.0,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id, kind),
  FOREIGN KEY (from_id) REFERENCES memories(id) ON DELETE CASCADE,
  FOREIGN KEY (to_id)   REFERENCES memories(id) ON DELETE CASCADE
);
CREATE INDEX idx_memory_links_to ON memory_links(to_id);
CREATE INDEX idx_memory_links_kind ON memory_links(kind);
```

`kind` allowlist (implementation): `RELATES_TO`, `CAUSED_BY`, `REFERENCES`,
`CONTRADICTS`, `DUPLICATES`, `SUPERSEDES`. Self-loops rejected at insert.

### v8 (shipped): lessons and episode archival

```sql
ALTER TABLE memories ADD COLUMN recall_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN last_recalled_at INTEGER;
ALTER TABLE memories ADD COLUMN consolidated_into INTEGER;
ALTER TABLE memories ADD COLUMN consolidating_at INTEGER;   -- lease for B↔C lock
CREATE INDEX idx_memories_consolidated ON memories(consolidated_into);

CREATE TABLE lessons (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  activation      TEXT NOT NULL,
  principle       TEXT NOT NULL,
  tags            TEXT,                   -- JSON array, like memories.tags
  status          TEXT NOT NULL DEFAULT 'active',  -- active | deprecated
  success_count   INTEGER NOT NULL DEFAULT 0,
  failure_count   INTEGER NOT NULL DEFAULT 0,
  parent_ids      TEXT NOT NULL,          -- JSON array of memories.id
  working_dir     TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deprecated_at   INTEGER
);
CREATE VIRTUAL TABLE lessons_fts USING fts5(
  activation, principle, tags,
  content='lessons',
  content_rowid='id',
  tokenize='porter unicode61'
);
-- triggers to keep lessons_fts in sync, like memories_fts
```

### v7 (shipped): bi-temporal `ProfileStore`

```sql
-- Existing profile_facts table:
--   key TEXT PK, value TEXT, pinned INTEGER, keywords TEXT, updated_at INTEGER

-- Rebuild as a versioned table.
ALTER TABLE profile_facts RENAME TO profile_facts_legacy;
CREATE TABLE profile_facts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  key             TEXT NOT NULL,
  value           TEXT NOT NULL,
  pinned          INTEGER NOT NULL DEFAULT 1,
  keywords        TEXT,
  valid_from      INTEGER NOT NULL,
  superseded_by   INTEGER,                -- nullable; FK to self
  supersedes      INTEGER,                -- nullable; FK to self
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_profile_active_key
  ON profile_facts(key) WHERE superseded_by IS NULL;
CREATE INDEX idx_profile_chain ON profile_facts(superseded_by);
-- migrate legacy rows: each becomes a v6 row with valid_from = updated_at,
-- superseded_by = NULL, supersedes = NULL.
INSERT INTO profile_facts (key, value, pinned, keywords, valid_from,
                           superseded_by, supersedes, created_at, updated_at)
  SELECT key, value, pinned, keywords, updated_at, NULL, NULL,
         updated_at, updated_at FROM profile_facts_legacy;
DROP TABLE profile_facts_legacy;
```

The unique partial index `idx_profile_active_key` enforces "at most one
active version per key" at the storage layer.

### v9 (shipped): vote curation (phase 7a)

Adds `vote_score` to `memories`, `lessons`, and `profile_facts`, plus the
`vote_events` audit table (FIFO-capped). See [`vote-store.ts`](src/memory/voting/vote-store.ts).

### v10 (shipped): procedure templates (phase 7b)

Adds `procedures` + `procedures_fts` and `vote_score` on `procedures`. Steps are
JSON `[{ description, toolHint? }, ...]` — no separate `parameters` column.
See [`procedure-store.ts`](src/memory/procedures/procedure-store.ts).

The `vote_events` table is **append-only audit**, not the primary score
storage. Hard cap via FIFO eviction (`memory.voting.eventLogMaxRows`, default
`50000`).

## 8. Code map: new files and changes

> **Note:** §8 was written pre-implementation. Paths below are updated to match
> the tree; modules under `src/memory/consolidator/` (not `consolidation/`).

### 8.1 New files (shipped)

| Path | Responsibility |
|---|---|
| `src/memory/links/link-store.ts` | CRUD + BFS `expand` over `memory_links`. |
| `src/memory/links/link-store.test.ts` | Cascade delete, self-loop rejection, multi-hop. |
| `src/memory/links/link-generator-*.ts` | Reflection-slot LLM link generation + parser. |
| `src/memory/links/link-aware-reflection.ts` | Decorator: base reflection → link-generator. |
| `src/memory/lessons/lesson-store.ts` | CRUD + FTS5 recall over `lessons`. |
| `src/memory/lessons/lesson-store.test.ts` | Coverage. |
| `src/memory/lessons/lessons-renderer.ts` | `### lessons` tail section. |
| `src/memory/lessons/lessons-renderer.test.ts` | Coverage including token budget clipping. |
| `src/memory/evolution/neighbor-evolver.ts` | Applies `EVOLVE` tags via `MemoryStore.evolveTags`. Never touches `content`. |
| `src/memory/evolution/neighbor-evolver.test.ts` | Lease, allowlist, cap, content immutability. |
| `src/memory/consolidator/clustering.ts` | Undirected CC + optional shared-tag trim. |
| `src/memory/consolidator/clustering.test.ts` | Synthetic graphs, min-size, `maxClusters`. |
| `src/memory/consolidator/consolidator-job.ts` | Scoped `setInterval` → cluster → distill → archive → deprecation/vote sweeps. |
| `src/memory/consolidator/consolidator-job.test.ts` | Lease, abstain, per-cluster isolation, phase 6/7 sweeps. |
| `src/memory/consolidator/distill-grammar.ts` | GBNF: `LESSON` + optional `PROCEDURE` in **one** completion. |
| `src/memory/consolidator/distill-prompt.ts` | Distillation micro-prompt. |
| `src/memory/consolidator/distill-runner.ts` | Reflection-slot LLM call for distillation. |
| `src/tools/memory/lessons-recall.ts` | `memory.lessons.recall { id | query }`. |
| `src/tools/memory/lessons-recall.test.ts` | Recall tool tests. |
| *(deferred)* `memory.lessons.list` | Not shipped — use SQLite / future CLI. |
| `src/tools/memory/profile-history.ts` | `memory.profile.history { key }`. |
| `src/tools/memory/profile-history.test.ts` | Coverage. |
| `src/memory/voting/vote-store.ts` | CRUD over `vote_events`; clamped score updates on `memories` / `lessons` / `profile_facts` / `procedures`. |
| `src/memory/voting/vote-store.test.ts` | Coverage including clamp, decay, audit-log FIFO eviction. |
| `src/memory/voting/vote-grammar.ts` | GBNF for `UPVOTE` / `DOWNVOTE` / `NONE` (`EDIT` deferred). |
| `src/memory/voting/vote-prompt.ts` | Voting micro-prompt — receives the per-turn allowlist of surfaced item ids and asks the model to vote. |
| `src/memory/voting/vote-parser.ts` | Parses `UPVOTE`/`DOWNVOTE`/`EDIT` lines; rejects votes outside the allowlist. |
| `src/memory/voting/vote-runner.ts` | Wires `ReflectionRunner` → vote sub-call → `VoteStore` writes. Fire-safe. |
| `src/memory/voting/vote-runner.test.ts` | Coverage including allowlist enforcement and clamp behaviour. |
| `src/memory/procedures/procedure-store.ts` | CRUD + FTS5 recall over `procedures`. |
| `src/memory/procedures/procedure-store.test.ts` | Coverage including `maxEntries` FIFO. |
| `src/memory/procedures/procedures-renderer.ts` | `### procedures` tail section. |
| `src/memory/procedures/procedures-renderer.test.ts` | Coverage including token-budget clipping and vote-score-aware ranking. |
| `src/memory/embeddings/*` | Phase 1B: client, store, hybrid recall, writer. |
| `src/memory/retrieve/*` | v2.5 phase A: referential gate + query rewriter decorator. |
| `src/tools/memory/procedures-recall.ts` | `memory.procedures.recall { id \| query }` (frequent tier). |
| `src/tools/memory/procedures-recall.test.ts` | Procedure recall tests. |
| *(deferred)* `memory.procedures.{store,list,deprecate}` | Manual authoring / listing not shipped. |

### 8.2 Files to modify

| Path | Change |
|---|---|
| `src/memory/memory-schema.ts` | Migrations through v10, idempotent. |
| `src/memory/memory-store.ts` | Dedup, utility eviction, hybrid recall, `archiveInto`, `evolveTags`, vote-aware eviction order. |
| `src/memory/profile-store.ts` | Bi-temporal CRUD: `set` inserts a new row + flips old `superseded_by`. `list()` filters `superseded_by IS NULL`. `history(key)` new method. |
| `src/memory/profile-renderer.ts` | No behavioural change. Pinned by tests. |
| `src/memory/reflection/reflection-prompt.ts` | Add LINK / EVOLVE / supersedes-marker rules to the prefix. |
| `src/memory/reflection/reflection-grammar.ts` | Extend GBNF. |
| `src/memory/reflection/reflection-parser.ts` | New parsed shapes. |
| `src/memory/reflection/reflection-runner.ts` | Sequential pipeline SET → NOTE → link-generator → neighbor-evolver → vote-runner, all on the reflection slot, all under the shared timeout. |
| `src/memory/memory-context-provider.ts` | Add link-expansion of `recalled`, add `lessons` and `procedures` channels, dedup `index` against all of them, expose surfaced-id allowlist for vote sub-call. |
| `src/memory/consolidator/consolidator-job.ts` | Phase 7b: emit `Procedure` alongside `Lesson` from one distillation call. |
| `src/memory/consolidator/distill-prompt.ts` | Combined lesson + optional procedure instructions. |
| `src/memory/profile-store.ts` | Bi-temporal CRUD + `applyVote` / `applyEdit` hooks (phase 7a). |
| `src/memory/lessons/lesson-store.ts` | + `applyVote` / `applyEdit` / `decayScores` (phase 7a). |
| `src/memory/memory-store.ts` | + `applyVote` / `decayScores` + utility-eviction predicate update (phase 7a). |
| `src/prompt/build-prompt.ts` | Render `### lessons` between `### profile` and `### recalled`; render `### procedures` between `### lessons` and `### recalled`. |
| `src/prompt/token-budget.ts` | Subtract `memory.lessons.maxTokens` and `memory.procedures.maxTokens` from effective conversation cap. |
| `src/prompt/stable-prefix.ts` | Persona description: mention `### lessons` and `### procedures` (this changes the stable prefix **once** at v2 rollout; expected KV-cache invalidation). |
| `src/agent/agent-loop.ts` | After memory recall, bump `recall_count` exactly once per turn; on terminal verb (`reply` / `loop_failed`) bump `success_count` / `failure_count` on each surfaced lesson and procedure. |
| `src/runtime/bootstrap.ts` | Constructs stores, embedding daemon probe, consolidator `start()`/`stop()`, reflection decorators (links, vote), rewriter wrapper, tools. |
| `src/config/config-schema.ts` | `memory.*` blocks through v19; migrations from older config versions. |
| `src/tracing/agent-metrics.ts` | New counters and histograms (incl. votes and procedures). |
| `src/tracing/trace/trace-event.ts` | New trace events for vote application and procedure creation. |
| `src/tools/memory/index.ts` | Register `lessons-*`, `profile-history`, `procedures-*` tools. |
| `src/prompt/tool-descriptors.ts` | Descriptors for the new tools (probably tier `rare` so they live in `# extras` and are autoloaded on use). |
| `MEMORY.md` | Rewrite §2, §3, §4, §5; add §13 (lessons), §14 (consolidation), §15 (vote curation), §16 (procedures). |
| `AGENTS.md` | Update "Memory fabric" section to describe paths hot / write / cold / vote / procedure. |
| `PROMPT.md` | Update the variable-tail anatomy to include `### lessons` and `### procedures`. |

**Shipped scale (approx.):** 90+ files under `src/memory/` (incl. colocated
tests), plus tools in `src/tools/memory/`. See §0 ledger for entry points.

## 9. Invariants and pinned tests

These should be encoded as pinned tests so future agents (or humans) cannot
silently break them.

1. **Stable prefix byte-stability under all writes.** No memory mutation
   (link creation, evolution, lesson creation, consolidation) changes the
   stable prefix bytes within a session. Pinned by `build-prompt.test.ts`
   hash check across a battery of writes.
2. **Stable-prefix persona changes are one-time per feature.** Phase 5
   (`### lessons`) and phase 7b (`### procedures`) each touched
   [`stable-prefix.ts`](src/prompt/stable-prefix.ts) once — **two** planned
   main-slot KV-cache invalidations (see §0). Variable-tail sections alone
   do not change the stable prefix hash.
3. **All evolution and link-generation runs on the reflection slot.** The
   main agent slot's KV-cache is never touched. Pinned by
   `reflection-runner.test.ts` and `link-generator.test.ts`.
4. **The consolidator never calls `runTurn`.** Cold path only: scoped
   `setInterval` in `consolidator-job.ts` (not the task `Scheduler`). Pinned
   by `consolidator-job.test.ts`.
5. **Evolution mutates only metadata.** `MemoryEntry.content` is
   append-only — `neighborEvolver` only ever writes `tags` and `context`.
   Pinned by `neighbor-evolver.test.ts` (assert `content` byte-stable
   across N evolve calls).
6. **Bi-temporal active uniqueness.** `ProfileStore.list()` returns at
   most one row per `key`. Pinned by `profile-store.test.ts` + the
   partial-index DB constraint as belt-and-braces.
7. **`memory_links` cascades on delete.** Removing a note removes all
   incident edges. Pinned by `link-store.test.ts`.
8. **`recall_count` is bumped exactly once per turn.** Even when the same
   note surfaces both as `### recalled` and via graph expansion. Pinned
   by `memory-context-provider.test.ts`.
9. **Archived episodes are not deleted.** `memory.notes.recall { id }` of
   a consolidated episode returns the original `MemoryEntry`. Pinned by
   `consolidator-job.test.ts`.
10. **Lessons never carry the full content of their parents.** Distillation
    produces a bounded summary; parents stay queryable by id. Pinned by
    `lesson-store.test.ts` (max-length assertion on `principle`).
11. **B↔C lease respected.** `neighbor-evolver.tryEvolve` skips a row
    whose `consolidating_at` is fresh (within lease). Pinned by
    `neighbor-evolver.test.ts`.
12. **Lesson grammar rejects malformed output.** GBNF constraint matches
    `activation` + `principle` + optional `tags`; nothing else is parsed.
13. **`consolidator-job` is fire-safe.** Errors swallowed into logs/metrics,
    Scheduler tick continues. Pinned by `consolidator-job.test.ts` with a
    failing distill mock.
14. **Similarity-threshold ordering.** At bootstrap,
    `memory.dedup.similarityThreshold ≤ memory.consolidation.similarityThreshold`
    is asserted; bootstrap fails fast on violation. See §13.7.3.
15. **Clock-skew safe temporal scoring.** Every recency / age / decay
    function clamps `(now - timestamp) < 0` to the safe end (zero
    freshness, not maximum), and emits the
    `agent.memory.clock_skew_detected` counter. Pinned by per-function
    unit tests. See §13.7.2.
16. **No brute-force vector scans.** When/if embeddings land, code that
    performs exact cosine over more than 200 rows is forbidden — must
    be preceded by ANN or FTS5 prefilter. Lint rule (or test scan over
    `db.prepare`) enforces this. See §13.7.1.
17. **Bulk operations stay in SQL.** Pinned by integration test that
    runs decay + eviction on a synthetic 5000-row store and asserts
    no per-row JS-side round-trip pattern (statement count ceiling).
    See §13.7.6.
18. **Votes only against surfaced items.** The vote sub-call (§6.4)
    receives an allowlist of `<kind>:<id>` pairs that were rendered in
    this turn's variable tail. The parser **drops** any vote outside
    that allowlist and emits `agent.memory.voting.rejected{reason=
    not_surfaced}`. Pinned by `vote-parser.test.ts` and
    `vote-runner.test.ts`. This is the load-bearing anti-feedback-loop
    guard — the model cannot vote on items it has not actually seen.
19. **Vote scores are bounded.** `vote_score` is clamped to
    `[-memory.voting.maxVotePerItem, +memory.voting.maxVotePerItem]`
    on every write. Bootstrap rejects `maxVotePerItem <= 0` and
    `signalDecay ∉ (0, 1]`. Pinned by `vote-store.test.ts`.
20. **Procedures never auto-execute.** Nothing in the runtime reads
    `Procedure.steps` to fire tool calls. Procedures are textual
    guidance only — the agent reads them via the prompt and decides.
    Pinned by a runtime-wide grep test in `procedure-store.test.ts`
    asserting no caller of `ProcedureStore.recall` feeds the result
    into `toolRegistry.invoke`. The Voyager-style executable seam
    stays at `src/skills/`.
21. **Distillation produces lesson and optional procedure in one
    LLM call.** Phase 7b does **not** add a second slot turn per
    cluster. The combined GBNF in `lesson-and-procedure-grammar.ts`
    is the only structured-output contract for the consolidator's
    distill step. Pinned by `consolidator-job.test.ts` (mock counts
    LLM invocations per cluster).
22. **`vote_events` is append-only audit, not primary state.**
    Recomputing `vote_score` from scratch is **not** required to be
    correct (decay is lossy on purpose); the column is the source of
    truth. `vote_events` is bounded FIFO. Pinned by `vote-store.test.ts`.
23. **Vote decay runs on the consolidator tick, not per-turn.** Path E
    writes are O(votes per turn) on the hot path; decay is O(rows) and
    must stay on the cold path. Pinned by `consolidator-job.test.ts`.

## 10. Configuration surface

All under `memory.*` in [`src/config/config-schema.ts`](src/config/config-schema.ts)
(`USER_CONFIG_VERSION` **19**). Defaults below match
`USER_CONFIG_DEFAULTS` at time of writing — **not** the early "everything on"
proposal. Phases 2–7b and v2.5 ship **dark** until the operator flips flags.

| Key | Shipped default | Meaning |
|---|---|---|
| `memory.dedup.enabled` | `true` | Phase 1A near-match merge on `store`. |
| `memory.dedup.fts5Threshold` | `0.85` | BM25 merge threshold. |
| `memory.eviction.utilityWeighted` | `true` | Phase 1A utility eviction (vs FIFO). |
| `memory.eviction.maxAgeMs` | `30d` | Declared; phase 1A overflow does not use it yet. |
| `memory.embeddings.enabled` | `false` | Phase 1B hybrid recall (needs embedding daemon). |
| `memory.links.enabled` | `false` | Master switch for link generation + BFS expansion. |
| `memory.links.autoGenerate` | `true` | Link-generator after reflection (when links on). |
| `memory.links.expansionDepth` | `1` | BFS depth on recall (clamped 1–3 in store). |
| `memory.links.maxExpanded` | `12` | Cap on expanded ids per turn. |
| `memory.links.maxLinksPerCall` | `4` | Cap per link-generator call. |
| `memory.evolution.enabled` | `false` | `EVOLVE` branch + neighbor evolver. |
| `memory.evolution.maxPerWrite` | `2` | Cap on applied evolves per reflection. |
| `memory.evolution.leaseMs` | `60000` | B↔C lease read by `evolveTags`. |
| `memory.lessons.enabled` | `false` | `### lessons` + `memory.lessons.recall`. |
| `memory.lessons.recallK` | `2` | Top-K lesson pointers per turn. |
| `memory.lessons.maxTokens` | `300` | Token budget for `### lessons`. |
| `memory.lessons.maxEntries` | `500` | Active lesson cap (FIFO + age sweeps). |
| `memory.lessons.deprecationAgeMs` | `30d` | Age demotion when `success_count == 0`. |
| `memory.consolidation.enabled` | `false` | Consolidator `setInterval`. |
| `memory.consolidation.intervalMs` | `6h` | Tick period. |
| `memory.consolidation.cooldownMs` | `24h` | Min episode age before clustering. |
| `memory.consolidation.minClusterSize` | `3` | Cluster size floor. |
| `memory.consolidation.maxClustersPerTick` | `5` | Throughput cap per tick. |
| `memory.consolidation.requireSharedTag` | `true` | Trim CCs to majority shared tag. |
| `memory.consolidation.distillTimeoutMs` | `45000` | Per-cluster LLM timeout. |
| `memory.voting.enabled` | `false` | Vote sub-call + decay sweep. |
| `memory.voting.maxVotePerItem` | `50` | Clamp magnitude; bootstrap rejects `<= 0`. |
| `memory.voting.signalDecay` | `0.95` | Per-tick decay on consolidator. |
| `memory.voting.scoreBlend` | `0.6` | Lesson/procedure rerank blend. |
| `memory.voting.profileFilterThreshold` | `3` | Hide profile facts with `vote_score <= -threshold`. |
| `memory.procedures.enabled` | `false` | `### procedures` + combined distill grammar. |
| `memory.procedures.recallK` | `2` | Top-K procedure pointers. |
| `memory.procedures.maxTokens` | `400` | Token budget for `### procedures`. |
| `memory.procedures.maxEntries` | `500` | Active procedure cap. |
| `memory.retrieve.rewriter.enabled` | `false` | v2.5 phase A query rewriter. |

Bi-temporal profile (phase 4) has **no** feature flag — always on after v7
migration. Full tables: [`MEMORY.md`](MEMORY.md) and AGENTS.md §"Memory fabric".

## 11. Observability: metrics, logs, traces

Add the following to
[`src/tracing/agent-metrics.ts`](src/tracing/agent-metrics.ts).

### 11.1 Counters

- `agent.memory.links.created` (tags: `kind`)
- `agent.memory.links.skipped` (tags: `reason` ∈ `lease_held` | `cap_hit` | `parse_error`)
- `agent.memory.evolution.applied`
- `agent.memory.evolution.skipped` (tags: `reason`)
- `agent.memory.lessons.created`
- `agent.memory.lessons.deprecated`
- `agent.memory.lessons.recalled`
- `agent.memory.consolidation.run` (tags: `outcome` ∈ `ok` | `none` | `failed`)
- `agent.memory.consolidation.evicted`
- `agent.memory.profile.superseded`
- `agent.memory.voting.applied` (tags: `kind` ∈ `profile` | `lesson` | `procedure` | `memory`, `direction` ∈ `up` | `down` | `edit`)
- `agent.memory.voting.rejected` (tags: `reason` ∈ `not_surfaced` | `unknown_kind` | `parse_error` | `clamp_hit`)
- `agent.memory.voting.decayed` (per consolidator tick, count of rows touched)
- `agent.memory.procedures.created` (tags: `source` ∈ `consolidator` | `agent` | `user`)
- `agent.memory.procedures.deprecated`
- `agent.memory.procedures.recalled`
- `agent.memory.procedures.evicted`

### 11.2 Histograms

- `agent.memory.links.fanout` (per note)
- `agent.memory.consolidation.clusters_processed` (per tick)
- `agent.memory.consolidation.tick_duration_ms`
- `agent.memory.lessons.recall_latency_ms`
- `agent.memory.voting.subcall_duration_ms` (per turn)
- `agent.memory.voting.deltas_per_turn` (count of vote markers emitted per turn)
- `agent.memory.procedures.recall_latency_ms`
- `agent.memory.procedures.steps_per_procedure` (length distribution)

### 11.3 Trace events

Extend `TraceEvent` union with:

- `memory_link_created { from_id, to_id, kind }`
- `memory_evolved { target_id, fields_changed }`
- `lesson_created { lesson_id, parent_ids }`
- `lesson_deprecated { lesson_id, reason }`
- `consolidation_tick { clusters, lessons_created, procedures_created, episodes_archived, evicted, votes_decayed }`
- `vote_applied { kind, target_id, delta, reason }`
- `vote_rejected { reason, attempted_kind, attempted_id }`
- `procedure_created { procedure_id, parent_lesson_ids, parent_memory_ids, source }`
- `procedure_deprecated { procedure_id, reason }`

These propagate into `<stateDir>/traces/<sessionId>.ndjson` and are visible
to `atomic-agent trace show / replay`.

## 12. Conflicts between B and C, and how to resolve them

### 12.1 Evolution vs consolidation on the same nodes

Two paths might write to one node at the same time. Solution:
**`consolidating_at` lease**. When the consolidator picks up a cluster, it
atomically stamps `consolidating_at = now` on every parent. The reflection
write path (`neighborEvolver.tryEvolve`) checks
`consolidating_at IS NULL OR (now - consolidating_at) > memory.evolution.leaseMs`
before mutating; otherwise it skips and emits
`memory.evolution.skipped{reason=lease_held}`. Lease window defaults to
60 s — long enough for the consolidator to finish a cluster, short enough
that a crashed consolidator does not freeze writes forever.

### 12.2 Stale links pointing into archived episodes

If episodes are archived without rewiring, the graph fills with dead edges.
The consolidator explicitly rewires after lesson creation:
- Edges entirely between archived parents → **deleted**.
- Edges from an archived parent to an outside node → **`from_id` rewritten
  to `lessonId`**.
- Edges from outside to an archived parent → **`to_id` rewritten to
  `lessonId`**.

This collapses the cluster to a single node from the link graph's
perspective.

### 12.3 Bi-temporal profile and the contextual gate

If `language=ru` is superseded by `language=en`, only `en` is rendered. But
a current `userMessage` mentioning Russian could legitimately want to see
the historical fact.

**Resolution (deliberate trade-off):** the rendered `### profile` always
shows only the **active** version. History is accessible **only** via the
explicit `memory.profile.history { key }` tool. This keeps the prompt tail
bounded and predictable; it costs one extra tool call when the agent
genuinely needs the historical view. Documented as a known limitation.

### 12.4 Lesson recall outranking episode recall

If `### lessons` and `### recalled` both surface relevant material, the
agent might be biased toward whichever is rendered first. Resolution:
**section order is fixed** (`### profile` → `### lessons` → `### recalled`
→ `### memory-index`), and the persona explicitly tells the model that
`### lessons` are higher-confidence summaries while `### recalled` are
raw episodes. The contract is documented in `PROMPT.md`.

## 13. Risks and trade-offs

### 13.1 Reflection latency growth

Per turn, reflection now does up to:
- 1 distillation call (existing) for `SET` / `NOTE` extraction
- 1 link-generation call per new `NOTE`
- 1 evolution call per linked neighbour (capped at
  `memory.evolution.maxPerWrite`)

Worst case: 1 + 2 × (1 + 2) = 7 reflection calls on a 2-note turn. On the
reflection slot, with cache reuse, each call is ~200–600 ms; budget
~1.5–4 s total. Acceptable for fire-and-forget, but we should sanity-check
on real traces before declaring victory.

### 13.2 Consolidator throughput on local models

A 1000-note store with average cluster size 5 yields ~200 potential
clusters. Distillation is ~1.5–3 s per cluster on Qwen-3.5-30B / Gemma-4
locally. To consolidate a backlog from scratch: ~5–10 minutes. To stay
ahead of incoming writes: trivially easy at any reasonable user pace.

Rate-limit (`maxClustersPerTick`) keeps a single tick bounded. Manual
`atomic-agent memory consolidate` CLI command (out of scope here, but
trivial to add later) lets a user kick a one-shot full sweep.

### 13.3 Self-generated `L₂` lessons risk being noise

SkillsBench finding: self-generated `L₂` without curation = **+0.0 pp**.
We mitigate via:
- High `minClusterSize` (3 by default) — single-episode lessons are
  excluded.
- `success_count` / `failure_count` tracking: lessons that never lead to
  successful turns get deprecated.
- Future opt-in user curation surface (manual edit / delete via CLI or
  TUI — phase 4, out of scope for v2 launch).

### 13.4 Backbone sensitivity to structured outputs

*Anatomy* paper measured 30.38% format-error rate for Nemori on
Qwen-2.5-3B. We mitigate with:
- Hard GBNF grammars on every new write path (link generation, lesson
  distillation, EVOLVE markers).
- Single-shot retry on parse failure, then surface as
  `memory.consolidation.run{outcome=failed}` and move on.
- The reflection path is fire-and-forget; failure never reaches the user.

### 13.5 KV-cache invalidation at rollout

Adding `### lessons` to the variable tail and updating the persona is a
**one-time** stable-prefix change. Document it explicitly in the migration
notes. No hot path; restart with a fresh session pool.

### 13.6 Storage growth shape change

Today: bounded `O(memory.notes.maxEntries)` on `memories`.
After v2: bounded `O(memory.notes.maxEntries)` on raw + archived episodes,
plus `O(lessons)` unbounded but slow-growing. Lessons are small; even
10 000 lessons × 1 KB ≈ 10 MB. Add a hard cap
`memory.lessons.maxEntries` (proposed `5000`) with FIFO eviction by
`(deprecated, updated_at ASC)` as a belt-and-braces.

### 13.7 Pitfalls transcribed from Hermes Agent PR #727

The closed-PR code review on
[`NousResearch/hermes-agent#727`](https://github.com/NousResearch/hermes-agent/pull/727)
is the single most concentrated source of "ways this exact shape of system
goes wrong in practice". We treat each finding as a hard constraint on
our implementation. See §3.7 for the full context.

#### 13.7.1 No brute-force vector search (if/when embeddings land)
Their `store.py.search_similar` did `SELECT * FROM cognitive_memories
WHERE embedding IS NOT NULL`, deserialized every blob, and computed cosine
in pure Python on every recall. O(n) per query, O(stored × queries) total,
no ANN index. At 10k memories this is "prohibitively slow".

**Our constraint:** if/when we add embeddings (deliberately deferred —
not part of phases 1-6), the **first cut must use an ANN index**, not
brute force. Acceptable options:
- [`sqlite-vec`](https://github.com/asg017/sqlite-vec) — actively
  maintained extension, ships precompiled binaries, fits our
  `better-sqlite3` posture.
- [`sqlite-vss`](https://github.com/asg017/sqlite-vss) — older sibling
  of `sqlite-vec` based on FAISS; deprecated upstream in favour of
  `sqlite-vec`.
- `hnswlib` in-process alongside SQLite — works if we accept a separate
  index file kept in sync with `memories`.

**Hard rule:** no brute-force cosine over more than `N=200` rows. If a
candidate set can be that small (e.g. after FTS5 prefilter), exact
cosine is fine. Otherwise → ANN.

#### 13.7.2 Recency / age math is clock-skew safe
Their `compute_recency` returned `1.0` (max freshness) whenever
`now - last_accessed <= 0`. A future-dated timestamp (clock skew, manual
migration, malicious write) thereby boosted a row to the top of recall.

**Our constraint:** every temporal score in this design — recency in
utility eviction, age in lesson deprecation, age in episode cooldown —
must:
1. **Treat negative deltas as zero or as an explicit invalid signal.**
2. **Clamp at the safe end**, not the boosted end:
   `decay = (now - ts) < 0 ? 0 : 0.5 ** (Math.max(0, daysSince) / halfLife)`.
3. Emit a `agent.memory.clock_skew_detected` metric when a negative
   delta is observed, so we can spot DB-clock drift.

#### 13.7.3 Threshold ordering: dedup < consolidation
Their pre-write dedup fired at similarity ≥ 0.95, but periodic
consolidation merged at ≥ 0.92. Rows in the 0.92–0.94 band were therefore
admitted at write time and later merged anyway — wasted I/O, transient
duplicates surfacing in recall in between.

**Our constraint:** the inequality
`memory.dedup.similarityThreshold ≤ memory.consolidation.similarityThreshold`
is a checked invariant at bootstrap; bootstrap fails fast if violated.
Recommended ordering: dedup at the cheap end (0.85), consolidation
slightly stricter (0.92), evolution-vs-rewrite at the high end (0.95+).

Until embeddings land we operate on FTS5 near-match instead, but the
ordering rule still applies (FTS5 score thresholds analogue).

#### 13.7.4 Consolidation is not O(n²)
Their `_consolidate_memories` did a naive `for i in range(N): for j in
range(i+1, N)` pairwise scan. At 10k memories this is ~50M comparisons
per cycle on a Python loop.

**Our constraint:** the consolidator **must not** do full pairwise scans:
- Candidate pairs come from the link graph (B's product), which is
  sparse by construction (`memory.links.maxPerNote ≤ 5`).
- Tag-intersection acts as a second filter.
- Final merge decision happens **per cluster**, not per pair.
- `memory.consolidation.maxClustersPerTick` caps work per tick.

If we ever add pairwise-similarity inside a cluster, scan must terminate
at `cluster.size² ≤ memory.consolidation.maxClusterSize²` with
`maxClusterSize ≤ 16` enforced.

#### 13.7.5 Background scheduler is not optional
Their `ForgettingManager.maybe_run_cycle()` was only called on user
action. A quiet system never decayed, never pruned.

**Our constraint:** all of consolidation, deprecation sweeps, and
utility-eviction sweeps run on the existing `Scheduler` tick, **never**
piggybacked on a user turn. The single tick path keeps the runtime's
periodic-timer invariant intact and avoids surprise pauses on quiet
systems.

#### 13.7.6 Bulk operations stay in SQL, not in Python
Their importance-decay path did `SELECT *`, looped in Python, and issued
one `UPDATE` per row. On a hot store this is O(n) round-trips.

**Our constraint:** every periodic bulk operation must execute as a
single SQL statement when possible:
- `UPDATE memories SET recall_score = ... WHERE ...` for decay.
- `DELETE FROM memories WHERE id IN (SELECT id FROM ... ORDER BY ...
  LIMIT ?)` for eviction.
- `UPDATE memories SET consolidated_into = ? WHERE id IN (...)` for
  archival.

`better-sqlite3` is synchronous and very fast on bulk SQL; the rule is
"prefer one statement, fall back to a single transaction with prepared
statements, never use a Python/JS loop with per-row I/O".

#### 13.7.7 Avoid threshold/heuristic surprises in classification
Their `classify_content` divided match-count by `word_count × 0.3`, so a
single matching word in a one-word text returned a perfect 1.0 score.

**Our constraint:** any heuristic scoring (lesson `success_count` bumps,
note importance estimates, tag inference) must:
1. Saturate gracefully on tiny inputs — `score = matches /
   max(words, 3)` or `score = matches / words^0.5`.
2. Be unit-tested at the trivial boundary (1 word, 0 words, all
   stop-words).

#### 13.7.8 The maintainer's verdict was "make it a plugin"
For Hermes that meant rejecting the cognitive system from core entirely.
For us the analogous question is **opt-in vs default-on**.

**Our position:** the consolidator and links are enabled by default
because they directly improve agent behaviour on our intended workload
(long-running local operator). Each capability is gated by an `enabled`
config flag (see §10) so operators can disable them surgically without
removing the code. The reflection path remains fire-and-forget; nothing
in this design can stall a user turn.

### 13.8 Phase 7 risks

#### 13.8.1 Vote feedback loops
The model votes on the same items it itself produced earlier. Without a
guard, an enthusiastic reflection can upvote its own bad ideas into
permanence. **Our mitigation (load-bearing):** the vote sub-call sees
**only** the items that were rendered in this turn's variable tail
(verified against the prompt trace), and the vote parser drops anything
outside that allowlist (invariant 18, §9). So votes can only flow over
items that the agent **already used in context** — meaning their effect
on the turn's outcome is at least observable.

Secondary mitigation: the LLM-produced `combinedScore` always blends
`vote_score` with the **automatic** `success_count - failure_count`
counters from phase 6. A self-upvoted item that consistently leads to
`loop_failed` still gets demoted by the automatic signal even if votes
disagree. The blend weight `memory.voting.scoreBlend` (default `0.6`)
caps the model's influence at 60% of ranking.

#### 13.8.2 Procedure proliferation
Every cluster that *might* be procedural produces a procedure, leading
to many similar procedure rows. Mitigation: the distillation prompt is
explicitly conditional ("emit procedure only when the cluster shows a
recognisable repeated tool-call sequence"); the GBNF allows
`procedure: null`. Hard cap `memory.procedures.maxEntries` (default
`500`) with FIFO by `(deprecated, vote_score ASC, updated_at ASC)`.
Future opt-in: similarity-based dedup of procedures via the same
threshold ordering as §13.7.3.

#### 13.8.3 The "agent reads procedure but acts differently" gap
A procedure says "1) glob, 2) grep, 3) reply"; the agent reads it and
does "1) glob, 2) read, 3) reply" because the user's question changed.
This is **expected and healthy** — procedures are guidance, not gospel.
The risk is silent failure: if the agent always ignores procedures,
they accumulate dead weight. Mitigation: track `use_count` (incremented
when a procedure is rendered in `### procedures` and the next reply's
tool-call chain is edit-distance-close to its `steps[]`). Procedures
with `use_count == 0` and age `> deprecationAgeMs` get demoted. The
"close enough" heuristic has a known false-negative rate; for v2 we
accept it and re-evaluate after phase 7b ships.

#### 13.8.4 Vote sub-call latency
Phase 7a adds one more LLM call to the per-turn reflection budget.
Updated worst-case: existing `1 + N×(1 + M) = 7` calls plus 1 vote call
≈ 8 calls. At ~200–600 ms each on the reflection slot with cache reuse,
worst-case ~2–5 s wall. Still fire-and-forget; user-visible reply has
already been emitted. We monitor via `agent.memory.voting.subcall_duration_ms`
and tighten the prompt if p95 grows past 1 s.

#### 13.8.5 KV-cache hit on the reflection slot under more sub-calls
Each reflection sub-call (extract → link-gen → evolve → vote) reuses
the same reflection slot via `slotManager.reserveReflectionSlot()`.
Their stable prefixes are different (different micro-prompts), so the
reflection slot oscillates and KV-cache reuse drops. This is **already
true** for phases 1–6; phase 7a adds one more oscillation. Tracked via
`agent.memory.reflection.cache_reuse_rate` (proposed new gauge — fold
into existing reflection metrics). Mitigation if it bites: pin a second
reflection slot for the vote sub-call (`reserveVotingSlot()`),
analogous to how reflection got its own slot from the main agent slot.
Deferred until evidence demands it.

## 14. Phased rollout plan

Each phase is shippable in isolation and has clear acceptance criteria.
**Implementation status** is in §0; automated acceptance lives in colocated
`*.test.ts` files, §14 below, and [`eval-memory/PLAN.md`](eval-memory/PLAN.md).

### Phase 1A: utility eviction + content dedup + recall_count — **shipped**
**Goal:** stop deleting valuable old notes; stop duplicate writes.

- v3 → v4 migration partial: add `recall_count`, `last_recalled_at`,
  `consolidating_at` columns (links table can land empty).
- `MemoryStore`: bump `recall_count` on `recall`, switch eviction to
  utility-weighted.
- `MemoryStore.store`: dedup by FTS5 near-match before insert.
- No new prompt sections, no grammar changes, no new tools.

**Acceptance:** existing tests still pass; new eviction tests; near-duplicate
test (rapid identical `NOTE` lines produce one row).

### Phase 1B: hybrid FTS5 + embedding recall — **shipped (opt-in)**
**Goal:** paraphrase-tolerant recall via a second `llama-server` embedding daemon.

- v5 migration: `memory_embeddings`.
- See AGENTS.md §"Memory-v2 phase 1B" and [`src/memory/embeddings/`](src/memory/embeddings/).

**Acceptance:** pinned by `hybrid-recall.test.ts`, `embedding-store.test.ts`,
`daemon-lifecycle.test.ts`.

### Phase 2: link graph (B-half-1) — **shipped (opt-in)**
**Goal:** introduce structure between notes.

- v6 migration: `memory_links` table.
- `linkGenerator` + new reflection branch + grammar.
- `memoryContextProvider.expandViaLinks`.
- No `### lessons` section yet.

**Acceptance:** synthetic multi-hop recall demo (notes A→B→C linked, query
that only hits A surfaces B and C via expansion).

### Phase 3: memory evolution (B-half-2) — **shipped (opt-in)**
**Goal:** let new notes refine the metadata of old ones.

- `neighborEvolver` + lease check.
- New `EVOLVE` reflection branch.
- Tests for the lease and content-immutability invariant.

**Acceptance:** trace test showing `tags` enrichment without `content`
mutation across a series of related turns.

### Phase 4: bi-temporal `ProfileStore` (B-half-3) — **shipped (always-on post-migration)**
**Goal:** stop overwriting profile history.

- v5 → v6 migration.
- `ProfileStore.set` writes new versions; `list` filters active.
- `memory.profile.history` tool.

**Acceptance:** user changes their preferred language and asks "what did
I tell you before?" — agent successfully retrieves history via the tool.

### Phase 5: lessons + consolidator (C-half) — **shipped (opt-in)**
**Goal:** episode → lesson promotion.

- v8 migration: `lessons` table, `consolidated_into` column.
- `LessonStore`, `consolidator-job`, distill grammar, `memory.lessons.recall`.
- `### lessons` prompt section + **first** stable-prefix persona change.
- Consolidator: scoped `setInterval` in `consolidator-job.ts` (not `Scheduler`).

**Acceptance:** synthetic test where the consolidator runs over a fixture
of related notes and produces a lesson with parent back-refs; archived
notes are still recallable by id.

### Phase 6: lesson lifecycle and deprecation — **shipped**
**Goal:** keep the lessons set bounded and healthy.

- `success_count` / `failure_count` bumps wired into the agent loop
  (when an agent reply follows a lesson recall successfully / when a
  loop_failed event follows a lesson recall).
- Deprecation sweep inside `consolidator-job`.
- Hard cap `memory.lessons.maxEntries` with FIFO eviction.

**Acceptance:** lessons that consistently fail get demoted over time;
total lesson count stays bounded.

### Phase 7a: ExpeL-style vote curation (path E) — **shipped (opt-in)**
**Goal:** introduce the selection pressure that turns self-generated `L₂`
artefacts from noise into signal.

- v9 migration: `vote_score` columns + `vote_events` audit table.
- `VoteStore` with clamped score updates and FIFO-bounded audit log.
- `vote-grammar` with `UPVOTE | DOWNVOTE | NONE` (`EDIT` deferred).
- `vote-prompt.ts` micro-prompt that receives the surfaced-id allowlist.
- `vote-parser.ts` enforcing the allowlist (invariant 18).
- `vote-runner.ts` wired into `ReflectionRunner` as a final sub-call.
- `MemoryStore` / `LessonStore` / `ProfileStore` gain `applyVote` /
  `applyEdit` / `decayScores` methods.
- Utility-eviction predicate updated to include `vote_score <= 0`
  (§6.4 step 4).
- Lesson deprecation predicate updated to include `vote_score < 0`
  (§6.4 step 5).
- Consolidator tick scales every `vote_score` by `signalDecay`
  (invariant 23).
- Bootstrap rejects invalid `voting.*` config.
- Trace events: `vote_applied`, `vote_rejected`.
- Metrics under `agent.memory.voting.*`.

**Acceptance:**
- Synthetic 10-turn replay where reflection consistently downvotes a
  specific lesson; that lesson drops out of `### lessons` recall before
  its age would have evicted it under phase 6.
- Trace-replay test where a vote attempt against a non-surfaced id is
  rejected with `vote_rejected{reason=not_surfaced}`.
- Bootstrap fails fast with `voting.maxVotePerItem = 0` (clamp invariant).
- KV-cache health: `agent.memory.reflection.cache_reuse_rate` does not
  drop more than 10 percentage points compared to phase 6 baseline on a
  10-turn fixture.

### Phase 7b: MemP-style procedure templates (path P) — **shipped (opt-in)**
**Goal:** add a parallel `L₂` artefact for *how to act*, derived alongside
lessons by the same distillation slot.

- v10 migration: `procedures` + `procedures_fts`.
- `ProcedureStore` with FTS5 recall, vote-aware ranking, FIFO eviction.
- `distill-grammar.ts`: combined `LESSON` + optional `PROCEDURE` in **one**
  LLM call per cluster.
- `procedures-renderer.ts`: pointer-only `### procedures` between lessons
  and memory-index.
- Lesson lifecycle bumps procedures only where wired; `use_count` bump API
  exists but is not auto-triggered from tool-chain match (deferred).
- Shipped tool: `memory.procedures.recall` (frequent tier). List/store/
  deprecate tools deferred.
- **Second** stable-prefix persona change for `### procedures` (see §0).
- Trace events: `procedure_created`, `procedure_deprecated`.
- Metrics under `agent.memory.procedures.*`.

**Acceptance:**
- Synthetic test: a fixture of 4 episodes "compute X for CSV → glob → grep →
  reply" feeds the consolidator; it produces both a lesson and a
  procedure with `parent_memory_ids` pointing back at the four episodes.
- Synthetic test: a fixture of 4 conceptually-related but procedurally-
  divergent episodes produces a lesson with `procedure: null` (no
  procedure row created).
- Synthetic test: agent on a related fresh task surfaces the procedure in
  `### procedures`; manual inspection shows the steps are followed (or
  consciously deviated). `use_count` increments correctly on close
  edit-distance match.
- Invariant 20 pinned: no caller of `ProcedureStore.recall` feeds the
  result into `toolRegistry.invoke`.
- Invariant 21 pinned: distillation makes exactly **one** LLM call per
  cluster (not two).
- Token-budget test: `### procedures` is clipped at
  `memory.procedures.maxTokens` with `[truncated]` marker.

### Optional Phase 8 (future, out of scope for v2)
The artefacts in this phase require a fundamentally different safety
surface (sandbox, signed artefacts, approval-gated execution) than
`memory.sqlite` provides. The natural seam is the existing `Skill`
mechanism in `src/skills/`, not the memory fabric.

- Voyager-style executable code-as-skill library (skills auto-derived
  from full trajectories, then `skill.run_script`-able with approval).
- ProcMEM-style PPO-Gate skill evolution (clipped-surrogate update of
  skill activation conditions via semantic gradients).
- `L₃` rule induction (RuleShaping-style declarative guardrails synthesised
  from cross-session evidence).
- Promotion of frequently-followed `Procedure` rows into executable
  Skills with auto-generated GBNF for their parameters.

These remain explicitly out of scope; see §16.

## 15. Open questions for the author

**Resolved at implementation time** (kept for history):

1. **Plan style:** shipped as strict phases 1A→7b with colocated tests;
   operator scorecard added as slot 3.
2. **Phasing:** strict gates; phases 2–7b default **off** in config.
3. **Evolution depth on `content`:** the current proposal keeps
   `MemoryEntry.content` append-only and only allows evolution of
   `tags` / `context` metadata. A-MEM in its original form rewrites the
   `context` field which we make separate from `content`. Are we OK
   keeping `content` strictly append-only, or do we want to allow
   `EVOLVE` to also rewrite `content`? The append-only path keeps
   trace integrity simpler.
4. **Procedural memory next: RESOLVED.** Phase 7 ships ExpeL-style vote
   curation (7a) and MemP-style procedure templates (7b) as **mandatory**
   parts of v2. Voyager-style executable code-skills and ProcMEM-style
   PPO-Gate skill evolution are deferred to optional phase 8 because they
   require a different safety surface (sandbox, signed artefacts,
   approval-gated execution) and the natural seam for them is the
   existing `Skill` mechanism in `src/skills/`, not `memory.sqlite`.
   See §14 phases 7a/7b and §16.
5. **Embeddings:** **resolved — shipped as phase 1B** (opt-in hybrid recall;
   `sqlite-vec` / ANN still deferred).

**Still open (product / ops):**

- Default-on policy for phases 2–7b after scorecard green (today all dark).
- Whether to merge the two stable-prefix KV invalidations in a single
  operator-facing "memory v2 enable" wizard.
- `memory.procedures.store` / manual authoring UX (CLI or TUI).

## 16. Out of scope (deferred)

The following are explicitly **not** part of v2 core even after phases 1–7b:

- `sqlite-vec` / ANN indexes (phase 1B uses JS brute-force cosine up to
  `bruteForceCeiling`, default 200).
- Importance scoring or decay curves more complex than utility-eviction
  combined with vote-score decay.
- Cross-machine sync of memory.sqlite.
- Secret redaction in stored notes, profile facts, or procedure steps.
- Per-skill or per-task scoped memory pools.
- **Voyager-style executable code-as-skill library** — phase 8+. The
  natural seam is the existing `Skill` mechanism in `src/skills/`, which
  already has approval gating and `skill.run_script` semantics; we do not
  extend `memory.sqlite` with executable artefacts.
- **ProcMEM-style PPO-Gate skill evolution** — phase 8+. Requires
  training infrastructure we do not have.
- **Promotion of `Procedure` rows into executable Skills** — phase 8+.
  Procedures stay textual guidance in v2; the promotion step is the
  natural bridge to the Voyager seam in phase 8.
- `L₃` rule induction (RuleShaping-style guardrails synthesised
  cross-session) — phase 8+.
- RL-policy-based memory management (Memory-R1, Mem-α, MEM1).
- LoRA-based latent memory tokens (MemGen, TokMem).
- Spreading-activation retrieval (Synapse).
- Graph-based reasoning over the link graph beyond depth-1 expansion.

What v2 **does** ship at the `L₂` boundary (now in scope, see §14):

- ExpeL-style vote curation over `profile_facts`, `lessons`, `procedures`,
  and `memories` (phase 7a).
- MemP-style structured procedure templates derived alongside lessons by
  the same distillation slot (phase 7b).

## 17. References

### Core papers used in this design

- **A-MEM: Agentic Memory for LLM Agents** — Xu et al., NeurIPS 2025.
  [arXiv:2502.12110](https://arxiv.org/abs/2502.12110).
  Repo: https://github.com/agiresearch/A-mem.
- **MemP: Exploring Agent Procedural Memory** — 2025.
  [arXiv:2508.06433](https://arxiv.org/abs/2508.06433).
  Repo: https://github.com/zjunlp/MemP.
- **ProcMEM: Learning Reusable Procedural Memory from Experience via
  Non-Parametric PPO for LLM Agents** — 2026 (ICML).
  [arXiv:2602.01869](https://arxiv.org/abs/2602.01869v1).
  Repo: https://github.com/Miracle1207/ProcMEM.
- **Voyager: An Open-Ended Embodied Agent with Large Language Models** —
  Wang et al., TMLR 2024.
  [arXiv:2305.16291](https://arxiv.org/abs/2305.16291).
- **ExpeL: LLM Agents Are Experiential Learners** — Zhao et al., AAAI 2024.
  [arXiv:2308.10144](https://arxiv.org/abs/2308.10144).
  Repo: https://github.com/LeapLabTHU/ExpeL.
- **MemGPT: Towards LLMs as Operating Systems** — Packer et al., 2023.
  [arXiv:2310.08560](https://arxiv.org/abs/2310.08560).
- **MemoryBank: Enhancing Large Language Models with Long-Term Memory**
  — Zhong et al., 2024.
  [arXiv:2305.10250](https://arxiv.org/abs/2305.10250).
- **Synapse: Empowering LLM Agents with Episodic-Semantic Memory via
  Spreading Activation** — 2026.
  [arXiv:2601.02744](https://arxiv.org/abs/2601.02744).

### Surveys and framing documents

- **Anatomy of Agentic Memory: Taxonomy and Empirical Analysis of
  Evaluation and System Limitations** — Jiang et al. 2026.
  [arXiv:2602.19320](https://arxiv.org/abs/2602.19320).
- **Experience Compression Spectrum: Unifying Memory, Skills, and Rules
  in LLM Agents** — Zhang et al. 2026.
  [arXiv:2604.15877](https://arxiv.org/abs/2604.15877).
- **Memory for Autonomous LLM Agents: Mechanisms, Evaluation, and
  Emerging Frontiers** — 2026.
  [arXiv:2603.07670](https://arxiv.org/abs/2603.07670).
- **From Human Memory to AI Memory: A Survey on Memory Mechanisms in the
  Era of LLMs** — 2025.
  [arXiv:2504.15965](https://www.arxiv.org/pdf/2504.15965).

### Cognitive science precedents

- **Complementary Learning Systems (CLS)** — McClelland, McNaughton &
  O'Reilly, *Psychological Review* 102(3), 1995. The hippocampus /
  neocortex dual-system theory we use as the precedent for combining
  paths B and C.
- **ACT-R declarative/procedural distinction** — Anderson, 1983. The
  precedent for the `L₁` / `L₂` boundary in Experience Compression
  Spectrum.
- **Fitts & Posner skill acquisition** — 1967. Explicit rules compile
  into automatic procedures through practice; informs the future
  `L₃` → `L₂` demotion direction.

### Sibling OSS systems (prior art)

- **`NousResearch/hermes-agent`** — closest local-agent sibling. The
  built-in memory design (flat `MEMORY.md` + `USER.md`) and the
  pluggable-provider architecture are documented in
  [their persistent-memory guide](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory.md)
  and the
  [memory-providers reference](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers).
- **`NousResearch/hermes-agent` PR #727** — *feat: cognitive memory
  system — semantic recall, encoding & forgetting.* The closed pull
  request that independently converged on essentially the same shape we
  propose here. The PR description and code review are the source of
  every pitfall transcribed into §13.7. Closed by `@teknium1` with
  "Lets make this a plugin if we want this to live on".
  [PR link](https://github.com/NousResearch/hermes-agent/pull/727).
- **`sqlite-vec`** — the ANN-index extension we would use first if we
  ever add embeddings (see §13.7.1).
  [Repo](https://github.com/asg017/sqlite-vec).

### Companion documents in this repo

- [`MEMORY.md`](MEMORY.md) — operator-facing memory fabric (v1 + v2 surfaces).
- [`AGENTS.md`](AGENTS.md) — **runtime source of truth** for memory-v2 behaviour.
- [`MEMORY_FABRIC_V2.5.md`](MEMORY_FABRIC_V2.5.md) — v2.5 design + operator scenarios
  (phases A–C).
- [`PROMPT.md`](PROMPT.md) — variable tail anatomy.
- [`EVOLUTION.md`](EVOLUTION.md) — sibling planning docs.
- [`README.md`](README.md) — user-facing setup.
