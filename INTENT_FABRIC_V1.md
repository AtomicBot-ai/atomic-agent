# atomic-agent — intent fabric v1 (planning document)

> **Status:** design proposal, no code changes yet. This document captures the
> motivation, architecture, and a phased implementation plan for the **Intent
> Fabric** — a new subsystem layered on top of `MemoryFabric` and the
> `Scheduler/Tasks` durable queue that turns the agent from a reactive operator
> into a proactive predictive partner. Intended as the source-of-truth to
> "dance from" when we (or any future agent) sit down to build this.
>
> Companions:
> [`MEMORY.md`](MEMORY.md) (current memory subsystem),
> [`MEMORY_FABRIC_V2.md`](MEMORY_FABRIC_V2.md) (memory v2 plan we layer on),
> [`AGENTS.md`](AGENTS.md) (engineering invariants),
> [`PROMPT.md`](PROMPT.md) (variable tail anatomy),
> [`EVOLUTION.md`](EVOLUTION.md) (sibling planning docs).

## Table of contents

1. [Why this document exists](#1-why-this-document-exists)
2. [Current state: what we have today](#2-current-state-what-we-have-today)
3. [Conceptual frame: the reactive→predictive spectrum](#3-conceptual-frame-the-reactivepredictive-spectrum)
4. [Research and prior art](#4-research-and-prior-art)
5. [Architecture: the five-layer stack](#5-architecture-the-five-layer-stack)
6. [Layer-by-layer design](#6-layer-by-layer-design)
7. [Variable-tail integration](#7-variable-tail-integration)
8. [Schema: `intent.sqlite`](#8-schema-intentsqlite)
9. [Code map: new files and changes](#9-code-map-new-files-and-changes)
10. [Invariants and pinned tests](#10-invariants-and-pinned-tests)
11. [Configuration surface](#11-configuration-surface)
12. [Observability: metrics, logs, traces](#12-observability-metrics-logs-traces)
13. [Privacy posture](#13-privacy-posture)
14. [Risks and trade-offs](#14-risks-and-trade-offs)
15. [Phased rollout plan](#15-phased-rollout-plan)
16. [Open questions](#16-open-questions)
17. [Out of scope (deferred)](#17-out-of-scope-deferred)
18. [References](#18-references)

---

## 1. Why this document exists

Today `atomic-agent` is a strong reactive operator: the user types, the agent
acts. The runtime already has the substrate for proactivity —
[`Scheduler`](src/scheduler/scheduler.ts) + [`TaskRunner`](src/tasks/task-runner.ts)
let the agent self-schedule; the [`TelegramChannel`](src/channels/telegram/)
gives a 24/7 push surface; [`MemoryStore`](src/memory/memory-store.ts) and the
forthcoming [`LessonStore`](MEMORY_FABRIC_V2.md#52-lessonstore-fts5-freeform-notes)
let it remember across sessions. **What is missing is the layer that decides
*what* to push and *when*** — a model of the user's intentions, goals,
promises, and habits, plus the inference machinery to turn raw signals into
high-confidence proposals.

This document proposes `IntentFabric v1`, a five-layer subsystem that:

1. **Captures explicit intent** the user articulates ("I'll run eval by Sunday").
2. **Ingests passive signals** from the user's working environment
   (git, calendar, Slack, browser, Jira, …) at a measured cadence.
3. **Clusters signals into latent topics** over rolling time windows.
4. **Forecasts trajectories** of stated goals against current velocity.
5. **Synthesises proposals** — predictions, conflict warnings, blocker
   inferences, mitigation menus — and surfaces them through the existing
   Telegram + TUI channels with explicit confidence scores.

Every architectural invariant from [`AGENTS.md`](AGENTS.md) is preserved:
no new periodic timers outside `Scheduler`; no global singletons; per-session
FIFO via `TurnController`; reflection-slot isolation for new LLM calls;
stable-prefix byte-stability for KV-cache.

## 2. Current state: what we have today

| Capability | Where it lives | Reactive / Proactive |
|---|---|---|
| Per-turn execution | `src/agent/agent-loop.ts`, `runtime.runTurn` | reactive |
| Cron / interval / at scheduling | `src/scheduler/`, `src/tasks/` | proactive but **manually configured** |
| Self-scheduling via `tasks.*` tools | `src/tools/tasks/` | proactive but **agent must explicitly schedule** |
| Webhook ingress | `src/http/route-webhooks.ts` | reactive to external event |
| Push surface | `src/channels/telegram/` | reactive — only replies to user messages |
| Memory of past turns | `src/memory/` (v1) | reactive recall on user query |
| Reflection (end-of-turn fact extraction) | `src/memory/reflection/` | passive write, **not** action-forming |

What is **not** in the codebase today:

- No model of "the user has a goal G with deadline D and progress P".
- No model of "the user made a promise X with deadline Y".
- No continuous passive signal ingestion. Every external read is
  user-triggered today.
- No topic clustering over rolling time windows.
- No forecasting / velocity tracking of any kind.
- No confidence-calibrated prediction surface.
- No "should I interrupt the user right now?" gate.
- No feedback loop that learns from user reactions to proposals
  (accept / dismiss / mark-irrelevant).

`IntentFabric v1` fills all eight gaps.

## 3. Conceptual frame: the reactive→predictive spectrum

Intent surfaces exist along a spectrum of effort the agent invests before
talking to the user:

| Level | Trigger | Inference effort | Example |
|---|---|---|---|
| **L0 — Echo** | User says X | none | *"OK, I'll remember to remind you at 14:00."* |
| **L1 — Recall** | User asks "what did I say about X?" | retrieval | *"On Tuesday you mentioned …"* |
| **L2 — Reactive intent** | User states a promise / goal / deadline in chat | parse + schedule | *"You promised eval by Sunday. Reminder set."* |
| **L3 — Pattern intent** | Repeated behaviour over N turns | clustering | *"Every Monday at 10:00 you collect a weekly digest. Automate?"* |
| **L4 — Forecasting intent** | Stated goal + measurable velocity | statistical model | *"At current velocity you finish Aug 3. OKR says Jul 15. Options:…"* |
| **L5 — Latent intent** | Behavioural signals without verbal articulation | multi-source fusion + LLM | *"You've saved 12 Rust articles, watched 2h40m of Rust talks. Learning Rust? Build a plan?"* |
| **L6 — Blocker inference** | Cross-source signal correlation | causal heuristics + LLM | *"14 commits to api-migration + 3 unanswered Slack threads to @auth-team + zero calendar overlap with Elena → you're blocked on her review. Schedule sync?"* |

`L0`–`L2` are achievable on the current substrate plus a small reactive
intent extractor. `L3` reuses `MemoryFabric v2`'s consolidator. `L4`–`L6` are
the new ground this document breaks. The cost / quality / risk curve gets
steeper with each level — phasing reflects this.

## 4. Research and prior art

This subsystem is closer to applied product engineering than open research.
The relevant building blocks come from four directions:

### 4.1 Proactive assistants (recent OSS)

- **OpenHuman** ([`tinyhumansai/openhuman`](https://github.com/tinyhumansai/openhuman),
  trending late 2025) ships **passive signal ingestion** (auto-fetch every
  20 min from 118 integrations) plus a `subconscious` domain for background
  thinking. They have the *ingestion* and *background processing* shape we
  copy. They do **not** ship an explicit goal/promise/deadline model, no
  forecasting, no conflict detection, no calibrated prediction surface.
  Their `cron` is purely user-configured.
- **Hermes Agent** ([`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent))
  is reactive-only. Cognitive memory PR #727 was closed; their lever is
  pluggable providers.

### 4.2 Agent memory + reflection (already in our stack)

The Memory v2 plan ([`MEMORY_FABRIC_V2.md`](MEMORY_FABRIC_V2.md))'s
**Lessons** layer is the substrate for `L3` pattern intent. The
**Reflection** path is the substrate for `L2` reactive intent. The
**ProfileStore** is the substrate for user-stable preferences that the
`IntentSynthesizer` reads at inference time.

### 4.3 Forecasting (textbook statistics)

`L4` uses elementary techniques, no ML:

- **EWMA** (exponentially weighted moving average) for commit / PR rate.
- **Burndown linear regression** for story-point trajectories.
- **Calendar-aware capacity** for working-day adjusted ETA.

No new dependencies — implementable in TypeScript inside `better-sqlite3`
queries.

### 4.4 Calibration of LLM confidence

A small but real literature: LLM-self-reported confidence is **miscalibrated**
out of the box (overconfident, with broken ranking). For `IntentFabric` we
use **post-hoc structural calibration**, not LLM-self-reported scores:

`confidence = σ(α·signalDiversity + β·signalRecency + γ·signalCount + δ·LLM-vote)`

where coefficients are tuned from feedback (`[Accept]` / `[Dismiss]` /
`[Not my goal]` button events). This sidesteps the well-documented
unreliability of `Confidence: 85%` from raw LLM outputs.

## 5. Architecture: the five-layer stack

```
┌────────────────────────────────────────────────────────────────────┐
│ Telegram cards (prediction / goal / conflict / proposal / blocker) │  UX
│ TUI Intent tab + slash commands (/intent ...)                      │
└────────────────────────────────────────────────────────────────────┘
              ↑               ↑                ↑
┌────────────────────────────────────────────────────────────────────┐
│  WhisperPolicy — "should we push now? push / soft / silent / hold" │  Gate
└────────────────────────────────────────────────────────────────────┘
              ↑               ↑                ↑
┌────────────────────────────────────────────────────────────────────┐
│                    IntentSynthesizer  (L4–L6)                      │  Layer 5
│  ├─ LatentGoalDetector    (signals → "you seem to be doing X?")    │
│  ├─ ForecastEngine        (stated goal + velocity → ETA)           │
│  ├─ ConflictDetector      (stated_deadline vs ETA → red flag)      │
│  ├─ BlockerInferer        (cross-source fusion → blocker proposal) │
│  └─ MitigationProposer    (1..N action options per proposal)       │
└────────────────────────────────────────────────────────────────────┘
              ↑                                ↑
┌──────────────────────────────────┐  ┌────────────────────────────┐
│      TopicAggregator (L3)        │  │     VelocityTracker (L4)   │  Layer 4
│ rolling-window clustering of     │  │ EWMA over PR / commit /    │
│ signals + tags + entities        │  │ story-point streams        │
└──────────────────────────────────┘  └────────────────────────────┘
              ↑                                ↑
┌────────────────────────────────────────────────────────────────────┐
│                     SignalBus + Connectors                         │  Layer 3
│  git · github · linear · jira · slack · calendar · browser-history │
│  email · notion · filesystem-watcher · clipboard · meet-history    │
│  one entry per connector under src/intent/signals/                 │
└────────────────────────────────────────────────────────────────────┘
              ↑
┌────────────────────────────────────────────────────────────────────┐
│                          IntentStore (L0–L2)                       │  Layer 2
│  CRUD over goals / promises / rituals / suggestions                │
│  + IntentExtractor (reflection-time parser for explicit statements)│
└────────────────────────────────────────────────────────────────────┘
              ↑
┌────────────────────────────────────────────────────────────────────┐
│  Memory Fabric v2  ·  Scheduler + Tasks  ·  Reflection slot  ·     │  Substrate
│  Telegram + ApprovalBridge  ·  TurnController                      │  (existing)
└────────────────────────────────────────────────────────────────────┘
```

The runtime is the substrate. Every layer above is **new** under
`src/intent/`, with one exception: `IntentExtractor` is a small extension
to [`ReflectionRunner`](src/memory/reflection/reflection-runner.ts), wired
as an additional reflection branch (`PROMISE` / `GOAL` / `RITUAL` /
`OBSERVATION` extraction lines next to the existing `SET` / `NOTE`).

## 6. Layer-by-layer design

### 6.1 IntentStore (L0–L2 reactive intent)

A new SQLite-backed store at `<stateDir>/intent.sqlite`. Separate from
`memory.sqlite` because:
- Different write cadence (intents update frequently; memory is mostly
  append-only).
- Different access pattern (intent reads are by deadline / status; memory
  reads are by content / tags).
- Different retention policy (intents are pruned aggressively after
  fulfilment; memory ages slowly).

Schema (full DDL in §8):

```ts
type IntentKind =
  | "promise"    // explicit commitment with deadline
  | "goal"       // longer-horizon objective, decomposable into children
  | "ritual"     // recurring habit ("Monday 10:00 weekly digest")
  | "suggestion" // agent-prepared action, not yet acted on
  | "observation"; // latent inference, low-confidence "you seem to be X"

type IntentStatus =
  | "active"
  | "at_risk"      // approaching deadline / forecast slipping
  | "fulfilled"
  | "broken"       // deadline passed without resolution
  | "snoozed"
  | "cancelled"
  | "deprecated";  // ritual that user dismissed

interface IntentRecord {
  id: number;
  kind: IntentKind;
  subject: string;          // human-readable summary
  body?: string;            // optional expanded description
  owner: "user" | "agent";  // who promised it
  source: "extracted" | "manual" | "synthesised" | "ritual_detected";
  parentId?: number;        // for goal decomposition
  deadline?: number;        // unix ms
  schedule?: TaskSchedule;  // shared shape with src/tasks/
  status: IntentStatus;
  confidence: number;       // [0,1], 1.0 for explicit / user-confirmed
  evidenceIds: number[];    // foreign key into memories.id and signals.id
  lastTouchedAt: number;
  createdAt: number;
  updatedAt: number;
}
```

`IntentExtractor` runs as a new branch inside `ReflectionRunner`:

```text
NONE
SET key=value [...]                            (existing, ProfileStore)
NOTE body [...]                                (existing, MemoryStore)
PROMISE subject [deadline=<iso8601>; owner=user|agent]   NEW
GOAL subject [deadline=<iso8601>; parent=#42]            NEW
OBSERVATION subject [confidence=0.6]                     NEW
```

The reflection grammar gains three productions; the parser writes to
`IntentStore` instead of `MemoryStore` for these. Same fire-and-forget,
same shared timeout, same reflection-slot isolation.

### 6.2 SignalBus + Connectors

`SignalBus` is the entry-point for **passive** writes. One connector per
external source under `src/intent/signals/`. Each connector exposes:

```ts
interface SignalConnector {
  name: string;                                 // "git", "calendar", "slack"
  pollIntervalMs: number;                       // per-connector cadence
  isEnabled(config: Config): boolean;
  fetch(since: number): Promise<RawSignal[]>;   // delta since last cursor
}

interface RawSignal {
  source: string;                               // connector name
  sourceId: string;                             // de-dup key
  kind: string;                                 // "commit" | "pr_opened" | "meeting" | ...
  subject: string;
  body?: string;
  entities?: string[];                          // "@elena", "ATM-88", "auth-migration"
  timestamp: number;                            // event time, NOT fetch time
  url?: string;
  raw?: Record<string, unknown>;                // small structured payload
}
```

`SignalBus.ingest(signals[])` writes into the new `signals` table
(§8), applying per-source de-dup by `(source, sourceId)`. Pre-write filters
trim noise (heuristics per connector — e.g. ignore CI noise commits, ignore
auto-generated `[skip ci]` PRs).

**No new periodic timers outside `Scheduler`.** Each connector is invoked
via a `TaskRecord { kind: "ritual", schedule: { kind: "interval",
everyMs: connector.pollIntervalMs }, triggerSource: "scheduler" }` that
the runtime registers at bootstrap. The connector's `fetch(since)` is
called inside the task's `runTurn`-bypass path — connectors are **not**
agent turns, they are direct effectful functions invoked by a thin
`SignalIngestJob`. The `signals` table is **never** read by the LLM
directly — only `TopicAggregator` and `IntentSynthesizer` query it.

Connectors land in waves (see §15). The first wave (Phase 1) is
`git-local` + `calendar` + `filesystem-watcher` — three high-signal sources
that need no OAuth and produce immediate value. Phase 2 adds `github`,
`linear`. Phase 3 adds `slack`, `jira`, `notion`. Phase 4 adds
`browser-history`, `email`. Each connector is **always opt-in** via
`intent.signals.<name>.enabled`.

### 6.3 TopicAggregator (L3 pattern detection)

Periodic job under `Scheduler` (default `intent.aggregator.intervalMs =
3_600_000` = 1 h). On each tick:

1. Pull signals from the last `intent.aggregator.windowMs` (default
   `21d`).
2. Cluster by `(entity, kind)` overlap — same Linear ticket id, same
   repo, same person.
3. Tag clusters with statistical summary: signal count, source diversity,
   first/last timestamp, dominant entities.
4. Write clusters into the `topics` table (§8), upserting by stable
   cluster key. Each cluster carries a `momentum` field —
   `signals_last_7d / signals_last_28d` — used by the synthesiser to
   decide whether the topic is "rising", "steady", or "fading".

`TopicAggregator` is **statistical only** — no LLM calls. It is cheap,
runs hourly, and produces a small structured corpus of "what the user
has been doing lately, grouped". This is the substrate `LatentGoalDetector`
consumes.

### 6.4 VelocityTracker (L4 forecasting)

A second statistical job, also under `Scheduler` (default
`intent.velocity.intervalMs = 3_600_000`). For each tracked goal in
`IntentStore`:

1. Collect signals tagged with the goal's entities (`api-migration`,
   `ATM-88`, …).
2. Compute three rolling rates over `intent.velocity.windowMs` (default
   `21d`):
   - **`commitRate`** — commits per working day.
   - **`prRate`** — PRs merged per working day.
   - **`completionRate`** — for goals with story points, points closed
     per working day.
3. Apply EWMA with `α = 0.3` (configurable) to smooth.
4. Persist into `goal_velocity` table (§8).

`ForecastEngine` reads `goal_velocity` and produces:

```ts
interface Forecast {
  goalId: number;
  asOf: number;
  velocity: number;                  // points/day or PRs/day depending on goal shape
  remainingWork: number;             // points or PRs left
  etaWorkingDays: number;
  etaCalendarDate: number;           // unix ms, accounting for weekends/holidays
  slippageMs: number;                // etaCalendarDate - goal.deadline (negative if on track)
  confidence: number;                // shrinks with low signal count / high variance
}
```

ETA uses a calendar-aware capacity model: working-day count via a small
holiday table per user locale (default to weekday-only; the user can drop
a `<stateDir>/holidays.json` for higher fidelity).

### 6.5 IntentSynthesizer (L4–L6 predictive intent)

The synthesiser is the only `IntentFabric` layer that issues LLM calls.
It runs as a `Scheduler` job (`intent.synthesizer.intervalMs`, default
`900_000` = 15 min) plus on-demand triggers (post-`ReflectionRunner`,
post-user-confirmation of a goal, post-signal-burst).

Five sub-components:

#### 6.5.1 LatentGoalDetector (L5)

Reads top topics from `TopicAggregator`. For each topic with
`momentum > intent.synthesizer.latentMomentumThreshold` (default `1.5`)
and `signalCount > intent.synthesizer.latentMinSignals` (default `8`),
asks a constrained LLM micro-prompt:

> *"Given these signals about <topic>: <bullet list of subjects>, is the
> user pursuing a latent goal? If yes, what is it?  Respond `NONE` or
> `GOAL <one-line summary> [signals=N; diversity=K]`."*

GBNF-constrained, reflection-slot. On `GOAL <...>`, writes an
`IntentRecord { kind: "observation", confidence }` where `confidence`
combines:

- `min(signalCount / 20, 1.0)` × 0.4
- `min(sourceDiversity / 4, 1.0)` × 0.3
- `momentum_normalised` × 0.2
- `LLM_yes_vote` × 0.1

The observation is **not pushed to Telegram immediately**. It enters
`WhisperPolicy` review, and only surfaces if confidence ≥
`intent.surface.minConfidence` (default `0.7`) and the user has not
recently dismissed similar observations.

#### 6.5.2 ConflictDetector (L4)

For each `IntentRecord { kind: "goal" | "promise", deadline != null,
status ∈ {active, at_risk} }`:

1. Read latest `Forecast`.
2. If `slippageMs > intent.synthesizer.slippageThreshold` (default
   `0` — i.e. forecast crosses deadline), generate a conflict proposal.
3. Confidence = `forecast.confidence` clamped to `[0.5, 0.99]`.

No LLM call needed for the detection itself — the proposal text is
templated. LLM is invoked only by `MitigationProposer`.

#### 6.5.3 BlockerInferer (L6)

The hardest sub-component. Operates only on goals with `status == "active"`.
For each:

1. Collect recent signals tagged with the goal's entities.
2. Apply structural heuristics:
   - "Many writes by user + many open-state pending reviews from
     non-user" → reviewer-blocked.
   - "Many writes + no recent signals from a known external dependency"
     → dependency-stalled.
   - "Recent ticket transitions to `blocked` / `waiting`" → explicitly
     blocked.
3. For each heuristic that fires with sufficient signal strength,
   construct a `BlockerHypothesis`.
4. Pass top hypotheses to an LLM micro-prompt: *"Given this evidence,
   is the user blocked? On whom? Suggested next action?"*. GBNF-constrained.
5. Emit a `proposal` row with `kind: "blocker"` if confidence ≥
   `intent.surface.minConfidence`.

Conservative by design — false positives here are the most damaging
(*"you're blocked on Elena"* when Elena was on vacation = trust loss).
Minimum confidence threshold for blockers is configurable separately
(`intent.surface.minBlockerConfidence`, default `0.8`).

#### 6.5.4 MitigationProposer

For every proposal of any kind, generate up to N action options
(default 3). LLM call, GBNF-constrained:

```text
OPTION 1: <title>
  effect: <one line>
  cost: <small | medium | large>
  irreversible: <true | false>
OPTION 2: ...
```

The proposer has access to the agent's tool registry abstractly — it
knows about `tasks.schedule`, `os.shell.run`, `os.fs.edit`, `vision.describe`
and can reference them in option bodies. The user clicks an option →
`runtime.runTurn({ origin: "scheduler", userMessage: option.executePrompt })`.

#### 6.5.5 Proposal lifecycle

Proposals are durable rows in the `proposals` table (§8). States:
`pending → surfaced → accepted | dismissed | ignored | expired`.
`ignored` fires when a proposal sits for `intent.surface.expiryMs`
(default 48 h) without any user reaction; `expired` is a hard stop after
which it cannot resurface.

Acceptance / dismissal feeds the calibration coefficients via
`CalibrationStore.recordFeedback`. Over time, dismissals of a particular
shape (e.g. *"goal detected: learning Rust"* dismissed three times) lower
the score of future similar proposals.

### 6.6 WhisperPolicy

The gate between "the synthesiser produced a proposal" and "the user gets
a Telegram ping". Inputs:

- proposal `confidence`
- proposal `kind` (predictions < blockers < conflicts < user-deadline-soon)
- current time vs `quietWindow` (`/intent quiet 2h` or `workhours`)
- recent acceptance rate (>50% → keep volume; <20% → halve)
- whether the user is currently active in TUI (avoid Telegram if TUI
  session in progress)
- whether a recent proposal of the same shape was dismissed

Output is one of four routes:

| Route | UX |
|---|---|
| `push` | Telegram message with sound + inline keyboard |
| `soft` | Telegram silent message with inline keyboard |
| `whisper` | TUI banner on next IDE open; no Telegram |
| `hold` | Persist in proposals table; surface only on `/intent list` |

A small set of unit tests pin the routing decisions per input
combination. The policy is **deterministic** — no LLM call here.

## 7. Variable-tail integration

A new section `### intents` is rendered into the variable tail of the
prompt, between `### profile` and `### lessons` (which Memory v2
introduces between `### profile` and `### recalled`). Order becomes:

```
### loaded-skills?
### loaded-tools?
### profile         (existing, gated)
### intents         NEW — active goals, promises, at-risk items
### lessons         (Memory v2)
### memory-index
### session-facts?
### recalled
### world
### conversation
### respond
```

`### intents` is a compact pointer view; a single line per intent:

```
* #42 [goal/at_risk] ship beta atomic-agent (deadline 2026-05-31, ETA 2026-06-07, 50%)
* #58 [promise/active] run eval:full (owner=user, due Sun 23:59)
* #61 [promise/at_risk] mmproj spec → Alex (overdue 1d)
```

Token budget: `intent.tail.maxTokens` (default `400`), subtracted from
the effective conversation cap in
[`src/prompt/token-budget.ts`](src/prompt/token-budget.ts). Filtered to
`status ∈ {active, at_risk}` only; fulfilled / cancelled / deprecated
intents do not pollute the tail.

Adding `### intents` to the variable tail and mentioning it in the
persona is a **one-time stable-prefix change**, identical in shape to
the one Memory v2 plans for `### lessons`. Document and announce at the
v1 release; expected one-time KV-cache invalidation.

## 8. Schema: `intent.sqlite`

`INTENT_SCHEMA_VERSION = 1`. Idempotent migrations under
`src/intent/intent-schema.ts`. All tables use `INTEGER PRIMARY KEY
AUTOINCREMENT` ids.

```sql
-- 8.1 intents
CREATE TABLE intents (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL,        -- promise|goal|ritual|suggestion|observation
  subject         TEXT NOT NULL,
  body            TEXT,
  owner           TEXT NOT NULL,        -- user|agent
  source          TEXT NOT NULL,        -- extracted|manual|synthesised|ritual_detected
  parent_id       INTEGER,
  deadline        INTEGER,
  schedule_kind   TEXT,                 -- at|cron|interval, null for ad-hoc
  schedule_value  TEXT,                 -- JSON, parsed via task-schedule
  status          TEXT NOT NULL,        -- active|at_risk|fulfilled|broken|snoozed|cancelled|deprecated
  confidence      REAL NOT NULL,
  evidence_ids    TEXT NOT NULL,        -- JSON array of mixed memory/signal/topic ids
  last_touched_at INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  FOREIGN KEY (parent_id) REFERENCES intents(id) ON DELETE SET NULL
);
CREATE INDEX idx_intents_deadline ON intents(deadline) WHERE deadline IS NOT NULL;
CREATE INDEX idx_intents_status_kind ON intents(status, kind);
CREATE INDEX idx_intents_parent ON intents(parent_id) WHERE parent_id IS NOT NULL;

-- 8.2 signals
CREATE TABLE signals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,            -- connector name
  source_id   TEXT NOT NULL,            -- de-dup key from source
  kind        TEXT NOT NULL,            -- commit|pr_opened|meeting|...
  subject     TEXT NOT NULL,
  body        TEXT,
  entities    TEXT,                     -- JSON array
  timestamp   INTEGER NOT NULL,         -- event time, NOT fetch time
  url         TEXT,
  raw         TEXT,                     -- JSON, small payload only
  ingested_at INTEGER NOT NULL,
  UNIQUE (source, source_id)
);
CREATE INDEX idx_signals_ts ON signals(timestamp DESC);
CREATE INDEX idx_signals_source_ts ON signals(source, timestamp DESC);

-- 8.3 topics
CREATE TABLE topics (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  cluster_key     TEXT NOT NULL UNIQUE, -- stable key, e.g. "entity:api-migration"
  subject         TEXT NOT NULL,
  entities        TEXT NOT NULL,        -- JSON array
  signal_count    INTEGER NOT NULL,
  source_count    INTEGER NOT NULL,
  first_seen_at   INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  momentum        REAL NOT NULL,        -- last_7d / last_28d
  computed_at     INTEGER NOT NULL
);
CREATE INDEX idx_topics_momentum ON topics(momentum DESC);

-- 8.4 goal_velocity
CREATE TABLE goal_velocity (
  goal_id           INTEGER NOT NULL,
  computed_at       INTEGER NOT NULL,
  commit_rate       REAL,               -- per working day, EWMA
  pr_rate           REAL,
  completion_rate   REAL,
  remaining_work    REAL,
  eta_calendar_date INTEGER,
  slippage_ms       INTEGER,
  confidence        REAL NOT NULL,
  PRIMARY KEY (goal_id, computed_at),
  FOREIGN KEY (goal_id) REFERENCES intents(id) ON DELETE CASCADE
);
CREATE INDEX idx_velocity_goal_latest ON goal_velocity(goal_id, computed_at DESC);

-- 8.5 proposals
CREATE TABLE proposals (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_id        INTEGER,             -- nullable; latent observations have none yet
  kind             TEXT NOT NULL,       -- prediction|goal_detected|conflict|blocker|ritual_proposal|suggestion
  subject          TEXT NOT NULL,
  body             TEXT NOT NULL,
  options          TEXT NOT NULL,       -- JSON array of MitigationOption
  signals_used     TEXT NOT NULL,       -- JSON array, surfaces under "Signals used:"
  confidence       REAL NOT NULL,
  status           TEXT NOT NULL,       -- pending|surfaced|accepted|dismissed|ignored|expired
  created_at       INTEGER NOT NULL,
  surfaced_at      INTEGER,
  resolved_at      INTEGER,
  resolution_note  TEXT,
  FOREIGN KEY (intent_id) REFERENCES intents(id) ON DELETE SET NULL
);
CREATE INDEX idx_proposals_status ON proposals(status);
CREATE INDEX idx_proposals_created ON proposals(created_at DESC);

-- 8.6 feedback_events (calibration)
CREATE TABLE feedback_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id INTEGER NOT NULL,
  reaction    TEXT NOT NULL,            -- accepted|dismissed|ignored|not_my_goal|wrong_signals
  reacted_at  INTEGER NOT NULL,
  features    TEXT NOT NULL,            -- JSON snapshot of confidence inputs at decision time
  FOREIGN KEY (proposal_id) REFERENCES proposals(id) ON DELETE CASCADE
);
CREATE INDEX idx_feedback_proposal ON feedback_events(proposal_id);

-- 8.7 quiet_windows (WhisperPolicy)
CREATE TABLE quiet_windows (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  starts_at    INTEGER NOT NULL,
  ends_at      INTEGER NOT NULL,
  reason       TEXT,                    -- "/intent quiet 2h" | "workhours" | "manual"
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_quiet_active ON quiet_windows(ends_at);
```

Storage caps:
- `signals` — FIFO eviction by `ingested_at` when count exceeds
  `intent.signals.maxRows` (default `50_000`).
- `topics` — recomputed each tick, no manual cap needed.
- `proposals` — FIFO eviction by `created_at` for `status ∈ {dismissed,
  ignored, expired}` when total exceeds `intent.proposals.maxRows`
  (default `5000`).
- `feedback_events` — keep for `intent.feedback.retentionDays` (default
  `180`).

## 9. Code map: new files and changes

### 9.1 New files

| Path | Responsibility |
|---|---|
| `src/intent/intent-schema.ts` | DDL + idempotent migrations for `intent.sqlite`. |
| `src/intent/intent-store.ts` | CRUD over `intents`. |
| `src/intent/intent-store.test.ts` | Coverage incl. deadline indexes, status transitions. |
| `src/intent/intent-types.ts` | `IntentRecord`, `IntentKind`, `IntentStatus`, `Proposal`, `Forecast`. |
| `src/intent/intent-extractor.ts` | Reflection-time parser for `PROMISE`/`GOAL`/`OBSERVATION` lines. |
| `src/intent/intent-extractor.test.ts` | Coverage including malformed inputs. |
| `src/intent/signals/signal-bus.ts` | Ingestion entry-point + dedup + cap eviction. |
| `src/intent/signals/signal-store.ts` | CRUD over `signals`. |
| `src/intent/signals/signal-connector.ts` | `SignalConnector` interface. |
| `src/intent/signals/git-local.ts` | git connector — reads `git log` since cursor. |
| `src/intent/signals/calendar.ts` | calendar connector — local `.ics` or skill-backed. |
| `src/intent/signals/filesystem-watcher.ts` | one-shot fs.watch with throttling. |
| `src/intent/signals/<...other connectors>.ts` | phased; see §15. |
| `src/intent/signals/signal-ingest-job.ts` | Scheduler-registered task that fans out to connectors. |
| `src/intent/topics/topic-aggregator.ts` | Statistical clustering job. |
| `src/intent/topics/topic-store.ts` | CRUD over `topics`. |
| `src/intent/forecast/velocity-tracker.ts` | EWMA computation job. |
| `src/intent/forecast/velocity-store.ts` | CRUD over `goal_velocity`. |
| `src/intent/forecast/forecast-engine.ts` | Combines goals + velocity → `Forecast`. |
| `src/intent/forecast/working-day-calendar.ts` | Holiday-aware date arithmetic. |
| `src/intent/synthesizer/intent-synthesizer.ts` | Top-level orchestrator. |
| `src/intent/synthesizer/latent-goal-detector.ts` | L5 LLM micro-prompt. |
| `src/intent/synthesizer/latent-goal-grammar.ts` | GBNF for L5 output. |
| `src/intent/synthesizer/conflict-detector.ts` | L4 deterministic. |
| `src/intent/synthesizer/blocker-inferer.ts` | L6 heuristic + LLM. |
| `src/intent/synthesizer/blocker-grammar.ts` | GBNF for blocker output. |
| `src/intent/synthesizer/mitigation-proposer.ts` | Generates 1..N options per proposal. |
| `src/intent/synthesizer/mitigation-grammar.ts` | GBNF. |
| `src/intent/proposals/proposal-store.ts` | CRUD over `proposals`. |
| `src/intent/proposals/proposal-renderer.ts` | Telegram / TUI card rendering. |
| `src/intent/policy/whisper-policy.ts` | Push/soft/whisper/hold decision. |
| `src/intent/policy/calibration.ts` | Confidence coefficient tuning from `feedback_events`. |
| `src/intent/policy/quiet-window-store.ts` | CRUD over `quiet_windows`. |
| `src/intent/intent-renderer.ts` | Builds `### intents` tail section. |
| `src/intent/intent-renderer.test.ts` | Coverage + budget clipping. |
| `src/intent/intent-context-provider.ts` | Per-turn `### intents` provider, plugs into `agent-loop`. |
| `src/tools/intent/intent-add.ts` | Tool `intent.add`. |
| `src/tools/intent/intent-list.ts` | Tool `intent.list`. |
| `src/tools/intent/intent-show.ts` | Tool `intent.show`. |
| `src/tools/intent/intent-snooze.ts` | Tool `intent.snooze`. |
| `src/tools/intent/intent-close.ts` | Tool `intent.close`. |
| `src/tools/intent/intent-suggest.ts` | Tool `intent.suggest` (let the agent propose a suggestion). |
| `src/tools/intent/intent-quiet.ts` | Tool `intent.quiet` (set whisper window). |
| `src/tools/intent/*.test.ts` | Coverage for each. |
| `src/channels/telegram/proposal-card.ts` | Renders proposal as Telegram HTML + inline keyboard. |
| `src/tui/intent/` | TUI Intent tab (mirror of Tasks tab pattern). |
| `INTENT.md` | User-facing description (sibling to `MEMORY.md`). |

### 9.2 Files to modify

| Path | Change |
|---|---|
| `src/runtime/bootstrap.ts` | Construct `IntentStore`, `SignalBus`, ingest job, aggregator, velocity tracker, synthesiser. Register tools. |
| `src/memory/reflection/reflection-prompt.ts` | Add `PROMISE`/`GOAL`/`OBSERVATION` rules. |
| `src/memory/reflection/reflection-grammar.ts` | Extend GBNF. |
| `src/memory/reflection/reflection-parser.ts` | New parsed shapes — dispatch to `IntentExtractor`. |
| `src/scheduler/scheduler.ts` | No structural change; new jobs register via existing `TaskRunner.create`. |
| `src/agent/agent-loop.ts` | After memory recall, pull active intents via `intent-context-provider`. |
| `src/prompt/build-prompt.ts` | Render `### intents` between `### profile` and `### lessons`. |
| `src/prompt/token-budget.ts` | Subtract `intent.tail.maxTokens`. |
| `src/prompt/stable-prefix.ts` | Persona mentions `### intents`. (One-time stable-prefix change.) |
| `src/prompt/tool-descriptors.ts` | Descriptors for `intent.*` tools (tier `rare`). |
| `src/config/config-schema.ts` | New `intent.*` block. Bump `USER_CONFIG_VERSION`. |
| `src/channels/telegram/inbound-handler.ts` | Recognise inline-keyboard callbacks for proposal responses; recognise `/intent ...` slash. |
| `src/channels/telegram/outbound-sender.ts` | No change; proposal cards reuse the path. |
| `src/tracing/agent-metrics.ts` | New counters and histograms. |
| `AGENTS.md` | New section "Intent fabric". |
| `PROMPT.md` | Variable-tail anatomy updated. |
| `README.md` | Mention proactive surface in the feature list. |

Total: **~35 new files**, **~14 files to modify**. Estimated production
code: ~3000–4000 lines; tests: ~3500–5000 lines.

## 10. Invariants and pinned tests

These should be encoded as pinned tests so future agents (or humans) cannot
silently break them.

1. **No new periodic timers outside `Scheduler`.** Every connector, the
   aggregator, the velocity tracker, and the synthesiser register as
   `TaskRecord`s on the existing scheduler. Pinned by
   `bootstrap.test.ts` — count `setInterval` calls under `src/intent/`
   stays at 0.
2. **Stable prefix byte-stability under all intent writes.** No
   intent / signal / proposal write changes the stable prefix bytes
   within a session. Pinned by `build-prompt.test.ts` hash check.
3. **One-time prefix change at v1 rollout.** Adding `### intents`
   changes the stable prefix once; subsequent operation is stable.
4. **`### intents` filters by status.** Only `active` and `at_risk`
   ever render. Pinned by `intent-renderer.test.ts`.
5. **All synthesiser LLM calls run on the reflection slot.** The main
   agent slot's KV-cache is never touched. Pinned by
   `intent-synthesizer.test.ts`.
6. **Synthesiser is fire-safe.** Errors logged + counted; the
   `Scheduler` tick continues. Pinned by `intent-synthesizer.test.ts`
   with a failing LLM mock.
7. **Connectors never call `runTurn`.** They write to `SignalBus` only;
   the agent loop is unaffected by ingestion. Pinned by per-connector
   tests with a mock `runtime`.
8. **`signals` table dedup by `(source, source_id)`.** Re-ingestion
   of the same event is idempotent. Pinned by `signal-store.test.ts`.
9. **Calibration uses only `feedback_events`, never raw LLM scores.**
   Pinned by `calibration.test.ts`.
10. **WhisperPolicy is deterministic.** No LLM call inside. Pinned by
    `whisper-policy.test.ts`.
11. **Proposals carry `signalsUsed`.** A proposal without provenance is
    rejected at insert time. Pinned by `proposal-store.test.ts`.
12. **Blocker confidence threshold ≥ generic surface threshold.**
    `intent.surface.minBlockerConfidence ≥ intent.surface.minConfidence`
    is checked at bootstrap; bootstrap fails fast on violation.
13. **`### intents` budget is hard-capped.** Render truncates to
    `intent.tail.maxTokens` with a `[truncated]` marker. Pinned by
    `intent-renderer.test.ts`.
14. **Clock-skew safe deadlines.** Every `(now - deadline)` math clamps
    negative deltas to the safe end (treat future-dated intents as
    "not yet due"). Mirrors the rule in `MEMORY_FABRIC_V2.md §13.7.2`.
15. **Goals' `parent_id` cannot form cycles.** Insert and update reject
    cycles via depth-bounded walk; depth cap `intent.goals.maxDepth`
    (default 5). Pinned by `intent-store.test.ts`.
16. **No connector writes secrets to `signals.raw`.** Each connector
    has a redaction pass; the pinned test scans a synthetic OAuth-bearing
    payload and asserts no token characters survive in stored rows.
17. **Bulk signal eviction is one SQL statement.** Mirrors
    `MEMORY_FABRIC_V2.md §13.7.6`. Pinned by an integration test on a
    synthetic 50k-row store.
18. **Proposals expire deterministically.** A pending proposal older
    than `intent.surface.expiryMs` flips to `expired` on the next
    synthesiser tick. Pinned by `intent-synthesizer.test.ts`.

## 11. Configuration surface

All keys under `intent.*` in
[`src/config/config-schema.ts`](src/config/config-schema.ts). Defaults
below are **proposed**; tune in Phase 3+ evaluation.

| Key | Proposed default | Meaning |
|---|---|---|
| `intent.enabled` | `true` | Master switch. Disables every job + tool registration. |
| `intent.tail.enabled` | `true` | Render `### intents` in the variable tail. |
| `intent.tail.maxTokens` | `400` | Token budget for `### intents`. |
| `intent.extractor.enabled` | `true` | Run `IntentExtractor` inside reflection. |
| `intent.signals.<name>.enabled` | `false` | Per-connector switch. **All connectors opt-in by default.** |
| `intent.signals.<name>.pollIntervalMs` | varies | Per-connector cadence. Defaults: `git-local` 300 s, `calendar` 600 s, `github` 600 s, `slack` 600 s, etc. |
| `intent.signals.maxRows` | `50_000` | Storage cap for `signals`. |
| `intent.aggregator.enabled` | `true` | Run topic clustering. |
| `intent.aggregator.intervalMs` | `3_600_000` (1 h) | Tick period. |
| `intent.aggregator.windowMs` | `1_814_400_000` (21 d) | Rolling window. |
| `intent.velocity.enabled` | `true` | Run velocity tracker. |
| `intent.velocity.intervalMs` | `3_600_000` | Tick period. |
| `intent.velocity.windowMs` | `1_814_400_000` | Rolling window. |
| `intent.velocity.ewmaAlpha` | `0.3` | EWMA smoothing factor. |
| `intent.synthesizer.enabled` | `true` | Run synthesiser. |
| `intent.synthesizer.intervalMs` | `900_000` (15 m) | Tick period. |
| `intent.synthesizer.latentMomentumThreshold` | `1.5` | Topic momentum gate for L5. |
| `intent.synthesizer.latentMinSignals` | `8` | Min signals for L5. |
| `intent.synthesizer.slippageThresholdMs` | `0` | Slippage gate for L4 conflict. |
| `intent.surface.minConfidence` | `0.7` | Hard floor for push surface. |
| `intent.surface.minBlockerConfidence` | `0.8` | Hard floor for blocker proposals. |
| `intent.surface.expiryMs` | `172_800_000` (48 h) | Expiry for unattended proposals. |
| `intent.proposals.maxRows` | `5000` | Storage cap for `proposals`. |
| `intent.feedback.retentionDays` | `180` | Retention for `feedback_events`. |
| `intent.whisper.defaultRoute` | `soft` | Route when ambiguous. |
| `intent.whisper.acceptanceTuning` | `true` | Adjust volume from recent acceptance rate. |
| `intent.goals.maxDepth` | `5` | Goal decomposition depth cap. |

Env overrides only for operational toggles
(`intent.enabled`, `intent.synthesizer.enabled`,
`intent.synthesizer.intervalMs`).

## 12. Observability: metrics, logs, traces

Extend [`src/tracing/agent-metrics.ts`](src/tracing/agent-metrics.ts).

### 12.1 Counters

- `agent.intent.created` (tags: `kind`, `source`)
- `agent.intent.transitioned` (tags: `from`, `to`)
- `agent.intent.fulfilled`
- `agent.intent.broken`
- `agent.signals.ingested` (tags: `source`)
- `agent.signals.deduplicated` (tags: `source`)
- `agent.topics.clustered` (per tick)
- `agent.velocity.computed`
- `agent.synthesizer.ran` (tags: `outcome` ∈ `ok | empty | failed`)
- `agent.proposals.created` (tags: `kind`)
- `agent.proposals.surfaced` (tags: `route`)
- `agent.proposals.resolved` (tags: `reaction`)
- `agent.whisper.routed` (tags: `route`, `reason`)

### 12.2 Histograms

- `agent.signals.ingestion_latency_ms` (per connector)
- `agent.aggregator.tick_duration_ms`
- `agent.aggregator.clusters_per_tick`
- `agent.velocity.tick_duration_ms`
- `agent.synthesizer.tick_duration_ms`
- `agent.synthesizer.proposals_per_tick`
- `agent.proposal.surface_to_resolve_ms`
- `agent.proposal.confidence` (tagged by `kind`, `outcome`)

### 12.3 Trace events

Extend `TraceEvent` union with:

- `intent_created { intent_id, kind, source }`
- `intent_transitioned { intent_id, from, to }`
- `signal_ingested { source, kind, entities[] }` (sampled — high volume)
- `topic_clustered { cluster_key, signal_count }`
- `forecast_computed { goal_id, eta_calendar_date, slippage_ms }`
- `proposal_created { proposal_id, kind, confidence }`
- `proposal_surfaced { proposal_id, route }`
- `proposal_resolved { proposal_id, reaction }`

These propagate into `<stateDir>/traces/<sessionId>.ndjson` and are
visible to `atomic-agent trace show / replay`.

## 13. Privacy posture

`IntentFabric` widens the local data footprint considerably. Three
explicit commitments preserve the local-first contract from
[`AGENTS.md`](AGENTS.md):

1. **All ingestion is local.** Connectors talk to external APIs only
   from the user's machine. Nothing leaves the host. The `signals` table
   lives in `intent.sqlite` under `<stateDir>`. No telemetry, no
   "anonymous usage statistics".
2. **All connectors are opt-in.** `intent.signals.<name>.enabled`
   defaults to `false`. The first run of every connector emits a
   one-time consent prompt in the TUI / Telegram explaining what it
   reads and where it stores it.
3. **Secrets are redacted before storage.** Connectors that handle
   OAuth tokens (Slack, GitHub, Linear, etc.) keep tokens in the
   already-existing `<stateDir>/.env` (see `AGENTS.md §"Secrets and
   process environment"`). `signals.raw` never contains a token; the
   redaction pass is per-connector and pinned by tests (§10 invariant
   16).

Out of scope for v1:
- Per-skill or per-connector environment isolation (currently every
  subprocess sees the full `<stateDir>/.env`).
- Encryption-at-rest for `intent.sqlite`.
- Audit log of connector reads (deferrable to v2 if a user requests it).

## 14. Risks and trade-offs

### 14.1 Local-model prediction quality

The synthesiser's L5/L6 proposals lean on the LLM's ability to reason
about "is this a goal?" / "is the user blocked?". On Qwen-3.5-30B and
similar local models, ability degrades meaningfully vs frontier cloud
models. We mitigate via:

- Conservative confidence thresholds (default surface at 0.7; blocker
  at 0.8).
- Structural calibration that down-weights LLM-self-confidence and
  up-weights signal-side features.
- Phased rollout: L4 (forecasting) ships first because its quality is
  determined by statistics, not the LLM.
- Optional cloud-fallback for L5/L6 only is **deliberately not
  designed in v1** — it would violate the local-first contract; the
  v1 stance is "what local models can do, we ship; what they can't,
  we hold back".

### 14.2 Notification fatigue

Even a high-confidence proposal that lands at the wrong moment damages
trust. `WhisperPolicy` is the central defence; in addition:

- Default routing biases to `soft` over `push` for non-deadline
  proposals.
- A "graveyard" feedback loop: 3 dismissals of the same proposal-shape
  raise the confidence threshold for that shape by 0.05.
- A hard global cap on `push` proposals per day
  (`intent.whisper.maxPushesPerDay`, default `5`). When exceeded, the
  excess proposals are routed to `soft` or `hold`.

### 14.3 Storage growth

`signals` is the heaviest table. 50k rows × ~500 bytes ≈ 25 MB cap by
default. At a heavy ingestion rate (8 connectors × 10 events/h =
80 events/h ≈ 1900/day), the cap saturates in ~26 days. FIFO eviction
keeps the file bounded.

Proposals and feedback are small. `topics` and `goal_velocity` are
recomputed and bounded by goal count.

### 14.4 Connector breakage and silent failure

External APIs change shape and rate-limit. A broken connector should
**never** silently degrade the surface — proposals that depend on a
broken connector look high-confidence but are wrong because the
freshest signals are stale.

Mitigation:
- Per-connector freshness gauge (`agent.signals.last_success_ts{source}`).
- Synthesiser **downweights** proposals whose evidence is older than
  `intent.synthesizer.maxEvidenceAgeMs` (default 7 d).
- A `connector_unhealthy` proposal (kind: `system`) surfaces when a
  connector has not produced a signal in twice its expected cadence;
  this is the agent telling the user "I'm partly blind".

### 14.5 Reflection latency growth

Per turn, `IntentExtractor` runs inside the existing reflection slot.
It does not add a new LLM call — it adds new branches to the same
grammar / output. Cost is parsing only.

The synthesiser, by contrast, is **off the user's critical path**
entirely — it runs on `Scheduler` ticks, never inside `runTurn`.

### 14.6 KV-cache invalidation at rollout

Adding `### intents` to the variable tail and mentioning it in the
persona changes the stable prefix once. Restart with a fresh session
pool. Same mechanic as Memory v2's `### lessons` rollout.

### 14.7 Cross-contamination with Memory v2

`IntentFabric` and `MemoryFabric v2` ship roughly in parallel.
Order-of-operations risk:

- If v2's `### lessons` ships first, v1 reuses `LessonStore` for
  ritual proposals. If v1 ships first, ritual proposals are stored in
  `intents` with `kind: "ritual"` and migrated to `LessonStore` later.
- Two new tail sections (`### intents`, `### lessons`) compound the
  one-time stable-prefix change. Bundle them in the same release if
  feasible to share the cache flush.

## 15. Phased rollout plan

Each phase is shippable in isolation and has clear acceptance criteria.

### Phase 0: IntentStore + IntentExtractor (L0–L2)

**Goal:** capture explicit promises and goals from chat; render in the
tail; reactive escalation.

- `intent.sqlite` schema v1.
- `IntentExtractor` + reflection grammar branches.
- `### intents` tail render (one-time stable-prefix change here — bundle
  with Phase 1 only if Memory v2 lessons land in the same release).
- `intent.add` / `list` / `show` / `snooze` / `close` tools.
- `/intent ...` slash commands in Telegram + TUI.
- `IntentSentinel` (a tiny `Scheduler` job, **not** the full synthesiser)
  that scans for `deadline < now + 24h` and emits reminder proposals.

**Acceptance:** user says *"I'll run eval by Sunday"*, agent records,
reminds 4 h before deadline, marks fulfilled when user confirms.

### Phase 1: SignalBus + git-local + calendar + filesystem (L3 base)

**Goal:** start passive ingestion from sources that need no OAuth.

- `signal-bus`, `signal-store`, `signal-connector` interface.
- Three connectors: `git-local`, `calendar` (local `.ics`),
  `filesystem-watcher`.
- `SignalIngestJob` registered with `Scheduler`.
- `TopicAggregator` initial implementation.

**Acceptance:** brief signals show up in `topics`; morning brief (still
manual scaffolding) includes git activity context.

### Phase 2: Forecasting + ConflictDetector (L4)

**Goal:** first predictive surface — deadline slippage warnings.

- `VelocityTracker` + `ForecastEngine`.
- `ConflictDetector` inside an initial `IntentSynthesizer` skeleton.
- `MitigationProposer` for conflict-kind proposals.
- `WhisperPolicy` initial implementation.
- Telegram proposal cards (conflict shape only).

**Acceptance:** a goal with `deadline` and demonstrable signal stream
produces an accurate ETA + slippage card after 7+ days of data.

### Phase 3: OAuth connectors (github + linear)

**Goal:** richer signal coverage for the typical developer workflow.

- `github` connector (PRs, issues, reviews, CI status).
- `linear` connector (issues, transitions, comments).
- Per-connector redaction tests.
- Per-connector first-run consent prompt UX.

**Acceptance:** synthetic test: open a PR locally, the github connector
ingests it, it appears in the topic clustered around the active goal.

### Phase 4: BlockerInferer (L6)

**Goal:** cross-source fusion for blocker detection.

- `BlockerInferer` + heuristics + GBNF + grammar.
- Stricter confidence gate (`minBlockerConfidence`).
- Calibration: collect 4 weeks of feedback before tightening thresholds.

**Acceptance:** synthetic fixture (commits + open PR + unanswered
Slack threads) reliably produces a blocker proposal with confidence ≥
0.8; false-positive rate on a held-out dev workflow under 10%.

### Phase 5: LatentGoalDetector (L5)

**Goal:** the *"you seem to be learning Rust"* card.

- `LatentGoalDetector` + GBNF.
- `OBSERVATION`-kind intents flow into the tail only above
  `minConfidence`.
- Feedback button `[Not my goal]` wired with calibration update.

**Acceptance:** synthetic fixture (12 saved articles, 2h40m YouTube,
4 starred repos on a topic) produces a goal-detected proposal with
confidence between 0.65 and 0.8; dismissal cleanly lowers re-emission
probability of the same shape.

### Phase 6: Remaining connectors (slack, jira, notion, browser, email)

**Goal:** signal coverage for full proactive surface.

- Each connector phased in with its own enable flag, consent prompt,
  rate-limit, redaction tests.
- Drop-in to the existing `SignalBus`; no architecture changes.

**Acceptance:** end-to-end demo on a real developer's workflow for a
week; user satisfaction subjectively positive; quantitative measure:
proposal acceptance rate ≥ 40% over surfaced proposals.

### Phase 7 (optional, deferred): cloud fallback for L5/L6

Out of scope for v1. If product evidence demands it, we add an
explicitly user-controlled cloud-fallback for synthesiser LLM calls
only. Surface a clear opt-in toggle; default `false`. Never for
signals — only for inference text.

## 16. Open questions

These are explicit decision points that must be resolved before Phase 1
ships:

1. **`intent.sqlite` vs reusing `memory.sqlite`.** Separate file is
   the proposal (§6.1 rationale). Are we OK with two files in
   `<stateDir>` instead of one? Both will already coexist with
   `tasks.sqlite` and `sessions.sqlite`.
2. **`### intents` ordering vs `### lessons`.** Today the proposal
   is `### profile` → `### intents` → `### lessons` → `### memory-index`
   → `### recalled`. Is `### intents` the right placement? Argument for
   placing it before `### lessons`: intents are more time-critical and
   user-actionable. Argument against: `### lessons` is a more compact
   distillation and arguably belongs higher.
3. **Confidence numeric in UX.** The screenshots show explicit `82%`,
   `71%`, `91%`. Do we render the numeric, or do we show a categorical
   badge (`low / medium / high`)? Numeric is informative but invites
   over-trust in calibration accuracy. Recommend numeric **only** above
   confidence floor, hidden otherwise.
4. **Feedback button taxonomy.** Beyond `[Accept]` / `[Dismiss]`, do we
   ship `[Not my goal]` / `[Wrong signals]` / `[Right idea, wrong time]`?
   More options = better calibration, also more UI surface.
5. **Connector cadence model.** Single per-connector interval, or
   adaptive (faster when signals are fresh, slower on quiet hours)?
   Adaptive is better UX, costs complexity. Recommend interval v1,
   adaptive v2 if needed.
6. **OAuth flow location.** Tokens live in `<stateDir>/.env`. Should the
   bootstrap UX include an in-process OAuth bouncer (so the user does
   the dance once in browser, agent grabs the token), or do we require
   manual paste? Manual paste ships faster; in-process bouncer is the
   product-grade answer.
7. **Single-user assumption.** Each connector ingests on behalf of one
   user. The agent runtime is already single-user (`AGENTS.md`). Do we
   accept that proactive surface inherits this constraint, or do we
   want to design a multi-user shape now? Recommend explicit single-user
   for v1.

## 17. Out of scope (deferred)

The following are explicitly **not** part of v1:

- Cloud-backed inference fallback (Phase 7 optional).
- Multi-user / team-wide intent fabric (a different product shape;
  needs a redesign).
- RL-trained calibration coefficients (post-hoc heuristic is good
  enough for v1).
- Encrypted-at-rest `intent.sqlite` (state dir is already user-only).
- Embeddings-based topic clustering (statistical clustering on
  entities + tags is sufficient for v1).
- Cross-connector entity resolution (e.g. "this Slack thread mentions
  the same ticket as this Linear issue"). Phase 6+ if signal coverage
  warrants.
- Voice surface for proposals.
- Proposal-driven UI overlay outside Telegram/TUI (e.g. a dedicated
  Tauri sidecar app).
- Auto-execution of approved proposals without user click (always
  require explicit accept, even for low-risk).
- Long-horizon goal templates (e.g. shared OKR libraries, project
  templates).

## 18. References

### Sibling planning docs in this repo

- [`MEMORY.md`](MEMORY.md) — current memory subsystem (v1).
- [`MEMORY_FABRIC_V2.md`](MEMORY_FABRIC_V2.md) — proposed memory v2;
  the substrate `IntentFabric` builds on.
- [`AGENTS.md`](AGENTS.md) — engineering invariants.
- [`PROMPT.md`](PROMPT.md) — variable-tail anatomy.
- [`EVOLUTION.md`](EVOLUTION.md) — sibling planning docs.

### Prior art

- **OpenHuman** ([`tinyhumansai/openhuman`](https://github.com/tinyhumansai/openhuman))
  — closest OSS sibling; passive ingestion + Memory Tree + subconscious
  domain. No explicit intent / goal / promise model, no forecasting,
  no calibrated prediction surface, cloud-backed inference. We mirror
  their ingestion shape (one connector per source, scheduled fetch)
  and depart on everything above the signal layer.
- **Hermes Agent** ([`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent))
  — reactive-only; pluggable memory providers. No proactive surface.
- **GitHub Copilot Workspace / Cursor agent** — task-driven, reactive.
  No long-horizon intent model.

### Cognitive science precedents

- **Goal-Setting Theory** — Locke & Latham, 1990. The empirical
  basis for explicit goals + feedback loops driving performance.
- **Implementation Intentions** — Gollwitzer, 1999. The reason
  proactive *"shall we do X now?"* prompts work better than passive
  *"X is on your todo list"*.
- **Endsley's Situation Awareness model** — Endsley, 1995. The
  Level-1 (perception) / Level-2 (comprehension) / Level-3 (projection)
  hierarchy maps cleanly onto our signal → topic → forecast layering.

### Forecasting techniques

- **Exponentially weighted moving averages** — standard textbook,
  e.g. Hyndman & Athanasopoulos, *Forecasting: Principles and
  Practice*, 3rd ed., 2021.
- **Working-day calendar arithmetic** — see ISO 8601 + country
  holiday calendars; we ship weekday-only by default.

### Calibration

- *On Calibration of Modern Neural Networks*, Guo et al., 2017
  — the original demonstration that softmax probabilities are
  miscalibrated. The same shape applies to LLM-self-reported
  confidence; structural post-hoc calibration is the safer default.

---

**End of `INTENT_FABRIC_V1.md`.**
