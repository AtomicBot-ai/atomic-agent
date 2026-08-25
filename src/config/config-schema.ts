import type { TaskSchedule } from "../tasks/task-types.js";
import type { ApprovalLevel } from "../approval/approval-level.js";
import {
  parseUserLlmFileConfig,
  type UserLlmFileConfig,
} from "./llm-config.js";

export type { ApprovalLevel } from "../approval/approval-level.js";
import type { DotenvLoadResult } from "./load-dotenv.js";
import {
  isKnownLocalModelId,
  type LocalModelDef,
} from "../local-llm/models-catalog.js";
import { parseCustomLocalModels } from "./custom-models-schema.js";
import {
  MCP_SERVER_NAME_MAX_LENGTH,
  MCP_SERVER_NAME_RE,
  type McpServerConfig,
  type McpTransport,
  type McpTrustLevel,
} from "../mcp/mcp-types.js";

export type {
  McpServerConfig,
  McpTransport,
  McpTrustLevel,
  McpStdioTransport,
  McpStreamableHttpTransport,
  McpSseTransport,
} from "../mcp/mcp-types.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type BrowserChannel = "chrome" | "msedge" | "chromium";

export type WebSearchProviderName = "duckduckgo" | "searxng" | "exa" | "brave";

/**
 * Tunables for `os.web.fetch` (config v38). Before v38 the tool hard-coded a
 * 30s overall budget with no connect timeout and no retries, so a single
 * unreachable host burned 30s of the task budget and a transient 503 (the
 * bulk of them from `web.archive.org`, which serves the same URL seconds
 * later) ended the fetch outright.
 */
export interface WebFetchConfig {
  /**
   * Overall per-attempt budget in milliseconds, passed to curl `--max-time`.
   * Kept at the historical 30_000 so unconfigured installs behave exactly as
   * before. A per-call `timeoutMs` tool argument overrides it.
   */
  timeoutMs: number;
  /**
   * TCP/TLS connect budget in milliseconds, passed to curl `--connect-timeout`.
   * Much smaller than `timeoutMs` because a host that has not completed a
   * handshake in 10s is almost never merely slow — it is firewalled, dead, or
   * blackholing packets, and waiting the full overall budget for it is pure
   * loss. A slow but reachable server still gets the whole `timeoutMs` to
   * stream its body, since `--connect-timeout` only covers the handshake.
   */
  connectTimeoutMs: number;
  /**
   * Extra attempts after the first for retryable failures (429/502/503/504 and
   * curl exit 28 "operation timed out"). `0` disables retrying. Deliberately
   * small: `os.web.fetch` is GET-only, so retries are always safe, but each one
   * spends task budget.
   */
  maxRetries: number;
  /**
   * Base delay in milliseconds for exponential backoff between retries
   * (attempt N waits `retryBaseDelayMs * 2^(N-1)`). A server-sent `Retry-After`
   * header wins over the computed delay when it is shorter than the cap.
   */
  retryBaseDelayMs: number;
  /**
   * Upper bound in milliseconds on any single backoff wait, including one
   * derived from `Retry-After`. Stops a hostile or overloaded origin from
   * parking the agent for minutes on a header value.
   */
  retryMaxDelayMs: number;
}

export interface WebSearchConfig {
  enabled: boolean;
  provider: WebSearchProviderName;
  maxResults: number;
  timeoutMs: number;
  /**
   * Per-runtime result cache TTL in minutes. `0` disables caching. The cache
   * is the primary defence against provider rate-limiting on repeated queries.
   */
  cacheTtlMinutes: number;
  /**
   * Ordered fallback providers tried (after the primary) when a search is
   * blocked / empty / throws. Default `["duckduckgo"]` — the keyless Exa
   * primary degrades to DuckDuckGo's keyless HTML endpoint. Both are
   * config-free; `searxng` (needs `instanceUrl`) and `brave` (needs an API
   * key) are skipped by the orchestrator until configured. Set to `[]` to
   * disable fallback entirely. The primary is always deduped out of this list.
   */
  fallback: WebSearchProviderName[];
  searxng: {
    instanceUrl: string | null;
  };
  exa: {
    endpoint: string;
    apiEndpoint: string;
    apiKeyEnv: string;
  };
  brave: {
    apiKeyEnv: string;
  };
}

/**
 * Declarative binding between an inbound webhook URL path and the task
 * it materialises. Per-webhook config lets operators point external
 * systems (e.g. a GitHub hook, a cron-like SaaS) at atomic-agent
 * without writing code — the HTTP layer turns each hit into a task.
 *
 * `sessionMode` drives session continuity across repeated hits:
 *  - `ephemeral`   — fresh ephemeral session per hit (default when no
 *    schedule is set; matches CLI one-shot behaviour)
 *  - `persistent`  — a single session created on the first hit and
 *    reused forever; sessionId persisted in
 *    `<stateDir>/webhook-sessions.json` keyed by webhook name
 *  - `named`       — explicit `sessionId` supplied by the operator; no
 *    persistence file, no auto-creation
 *
 * `userMessageTemplate` supports `{{body.<json.path>}}` placeholders
 * against the parsed JSON request body. `secret`, when set, is
 * matched against the `x-webhook-secret` request header in addition
 * to the global API-key check.
 */
export interface WebhookConfig {
  userMessageTemplate: string;
  secret?: string;
  schedule?: TaskSchedule;
  sessionMode?: "ephemeral" | "persistent" | "named";
  sessionId?: string;
}

/**
 * Full runtime config assembled from the user config file (6 user-facing
 * keys) plus environment variables (bootstrap paths, browser, local-LLM
 * timeouts, etc.). All consumers outside `src/config/` depend only on
 * this shape.
 */
export interface AtomicAgentConfig {
  localModels: {
    url: string;
    apiKey: string | null;
    healthPath: string;
    completionPath: string;
    /** Upper bound on `n_predict` for each completion when the caller omits `maxTokens`. */
    completionMaxTokens: number;
    healthTimeoutMs: number;
    requestTimeoutMs: number;
    healthRetries: number;
    healthRetryBackoffMs: number;
    /**
     * Maximum number of attempts for `complete()` and the initial
     * non-streaming fetch of `completeStream()`. Retries apply only to
     * transport-level errors (network failures, HTTP 5xx) — 4xx grammar
     * or validation errors short-circuit immediately.
     */
    completionRetries: number;
    /** Base delay between completion retries; grows exponentially with jitter. */
    completionRetryBackoffMs: number;
    defaultSlotId: number;
    /** `external` uses `url`; `managed` overrides runtime `url` to localhost + `managed.port`. */
    mode: LocalLlmMode;
    managed: UserManagedLocalLlmConfig;
    /**
     * Memory-v2 phase 1B. Second managed daemon for `/embedding`.
     * Mirrors `UserConfigFile.localModels.embeddings`. The runtime
     * connects to `http://127.0.0.1:<embeddings.port>` for embedding
     * requests when `embeddings.enabled` is true and the daemon is
     * healthy. Disabled / unreachable ⇒ FTS5-only recall path.
     */
    embeddings: UserManagedEmbeddingLlmConfig;
  };
  /**
   * Outcome of the startup `<stateDir>/.env` load performed by
   * `loadConfig`. Carries variable names and read-failure metadata only,
   * never values. Frontends surface `dotenv.error` to the user (TUI chat
   * warning) because a `.env` that exists but cannot be read means stored
   * secrets were silently dropped (#59).
   */
  dotenv: DotenvLoadResult;
  paths: {
    stateDir: string;
    sessionsDbFile: string;
    memoryDbFile: string;
    /**
     * SQLite file backing the durable task queue. Kept separate from
     * `sessionsDbFile` and `memoryDbFile` because tasks have a
     * different lifecycle than sessions and a different access pattern
     * than the memory fabric. Cross-file FKs are not used; `session_id`
     * validity is checked at runtime by `TaskRunner`.
     */
    tasksDbFile: string;
    tracesDir: string;
    grammarsDir: string;
    browserProfileDir: string;
    globalSkillsDir: string;
    projectSkillsDirName: string;
    userConfigFile: string;
    /** Resolved root for managed llama.cpp data (`backend/`, `models/`). */
    localModelsDataDir: string;
  };
  agent: {
    tokenBudget: number;
    maxSteps: number;
    toolTimeoutMs: number;
    /**
     * Boot value for the five-step approval ladder (1 = ask for
     * everything … 5 = approve everything). The live value is owned by
     * the ApprovalGate; see `runtime.setApprovalLevel`.
     */
    approvalLevel: ApprovalLevel;
    stablePrefixHashSalt: string;
    /**
     * Safety-net ceiling for the `### conversation` section of the prompt.
     * Typical sessions stay well under this cap — it exists to prevent
     * pathological growth, not to be a regular truncation mechanism.
     */
    conversationMaxTokens: number;
    /**
     * Safety-net ceiling for the `### world` section. ARIA snapshots are
     * already compressed at the browser layer; this cap guards against
     * edge cases where compression misses (huge SVG trees, etc.).
     */
    worldSnapshotMaxTokens: number;
    /**
     * Max `### loaded-tools` rare-schema entries kept per session (LRU
     * by `loadedAt`). Env-only: `ATOMIC_AGENT_LOADED_TOOLS_CAP`.
     */
    loadedToolsCap: number;
    /**
     * Safety cap for the `### loaded-tools` section in the variable tail.
     * Env-only: `ATOMIC_AGENT_LOADED_TOOLS_MAX_TOKENS`.
     */
    loadedToolsMaxTokens: number;
    /**
     * On rare-tool execution error, auto-inject the full schema into
     * `### loaded-tools` for the next step. Env-only:
     * `ATOMIC_AGENT_AUTO_EXPAND_RARE_ON_ERROR`.
     */
    autoExpandRareOnError: boolean;
    /**
     * Maximum number of tool calls the model may emit in a single
     * inference step (a "batch"). The grammar caps the array at 16
     * structurally; this knob is the runtime soft cap and also drives
     * the prompt instructions paragraph. Env-only:
     * `ATOMIC_AGENT_MAX_PARALLEL_TOOL_CALLS`. Hard upper bound: 16.
     */
    maxParallelToolCalls: number;
    /**
     * Soft cap on the combined character length of all tool-result
     * summaries appended in a single batched step. When exceeded the
     * oldest within-batch results get an extra truncation pass before
     * being added to the conversation transcript. Env-only:
     * `ATOMIC_AGENT_BATCH_TOOL_RESULT_CHAR_CAP`.
     */
    batchToolResultCharCap: number;
    /**
     * No-progress loop detection (OpenClaw-style `ToolLoopTracker`).
     * `loopWarningThreshold` — args-only repeat count that injects a
     * `### notice` (env `ATOMIC_AGENT_LOOP_WARNING_THRESHOLD`).
     * `loopCriticalThreshold` — identical args+result streak that vetoes
     * the call before dispatch (env `ATOMIC_AGENT_LOOP_CRITICAL_THRESHOLD`).
     * `loopBreakerVetoStreak` — consecutive vetoes of one signature that
     * force a graceful reply (env `ATOMIC_AGENT_LOOP_BREAKER_VETO_STREAK`).
     * `loopHistorySize` — sliding window size for the tracker's history
     * ring (env `ATOMIC_AGENT_LOOP_HISTORY_SIZE`).
     * `loopWanderingThreshold` — distinct-args spread on a wandering-prone
     * tool (web/http/browser) that injects an actionable redirect notice
     * (env `ATOMIC_AGENT_LOOP_WANDERING_THRESHOLD`).
     * `loopWanderingEscalation` — distinct-args spread that escalates to a
     * forced graceful reply (env `ATOMIC_AGENT_LOOP_WANDERING_ESCALATION`).
     * All env-only.
     */
    loopWarningThreshold: number;
    loopCriticalThreshold: number;
    loopBreakerVetoStreak: number;
    loopHistorySize: number;
    loopWanderingThreshold: number;
    loopWanderingEscalation: number;
  };
  browser: {
    /**
     * Master switch for the interactive `browser.*` tool surface. When
     * `false`, every `browser.*` descriptor is dropped from the stable
     * prefix via `filterToolDescriptorsByConfig` so the model never sees
     * (and therefore never reaches for) the live browser — web work is
     * funnelled to `os.web.search` + `os.web.fetch`. The tools
     * stay registered and grammar-valid so an explicit fallback can
     * still drive them. Env `ATOMIC_AGENT_BROWSER_ENABLED`, default `true`.
     */
    enabled: boolean;
    channel: BrowserChannel;
    headless: boolean;
    cdpUrl: string | null;
    executablePath: string | null;
    noSandbox: boolean;
    launchTimeoutMs: number;
  };
  skills: {
    catalogTokenBudget: number;
    /**
     * Names of installed skills that should be hidden from the
     * registry. A disabled name is filtered out of `SkillRegistry.list()`
     * entirely — the catalog row in `### skills` disappears and
     * `skill.view` returns `SkillNotFoundError`. Mirrors
     * `UserConfigFile.skills.disabled`. Editing the list invalidates
     * KV-cache once because the stable prefix changes.
     */
    disabled: string[];
    /**
     * GitHub `owner/repo` repositories the skill hub browses for
     * installable SKILL.md skills. Mirrors `UserConfigFile.skills.taps`.
     */
    taps: string[];
    /**
     * ClawHub registry (https://clawhub.ai) — the primary skill
     * marketplace. Mirrors `UserConfigFile.skills.clawhub`.
     */
    clawhub: {
      enabled: boolean;
      apiBase: string;
      browseLimit: number;
      nonSuspiciousOnly: boolean;
    };
  };
  http: {
    enabled: boolean;
    approvalMode: HttpApprovalMode;
    hostAllowlist: string[] | null;
    maxResponseBytes: number;
    defaultTimeoutMs: number;
  };
  web: {
    search: WebSearchConfig;
    fetch: WebFetchConfig;
  };
  /**
   * User-declared project root directories consumed by
   * `os.fs.locate_project` (fuzzy project-name resolution, issue #77).
   * Mirrors `UserConfigFile.projects`. Default `[]` — with no declared
   * roots the tool falls back to the session working dir chain and
   * recent session dirs only.
   */
  projects: {
    roots: string[];
  };
  log: {
    level: LogLevel;
  };
  tracing: {
    trace: {
      /**
       * Trace recording toggle.
       * - `true`  / `false`: explicit user choice (wins over the entry-point default).
       * - `null`: defer to the entry point. `createAgentRuntime` resolves it
       *   via `traceDefault`: CLI / TUI / serve use `true`, sidecar uses
       *   `false`. This keeps local debugging observable by default while
       *   embedded hosts stay silent unless they opt in.
       */
      enabled: boolean | null;
      /** Directory for per-session NDJSON trace files. */
      dir: string;
      /** Hard cap on a single session's trace file before writes stop. */
      maxBytesPerSession: number;
    };
  };
  /**
   * Durable task queue. All values are env-only operational tuning —
   * not part of the user config file because the queue is an
   * infrastructure detail, not a user-facing knob. When `enabled` is
   * `false`, `TaskStore` is still constructed (it owns the SQLite
   * connection) but `TaskRunner.drainPending` becomes a no-op and
   * the HTTP / CLI surfaces refuse to dispatch.
   */
  tasks: {
    enabled: boolean;
    /** Hard upper bound on `attempts` per task. */
    maxAttempts: number;
    /** Base delay between retries; doubled on each subsequent attempt. */
    backoffInitialMs: number;
    /** Cap for the exponential backoff curve. */
    backoffMaxMs: number;
    /**
     * When `true`, `TaskStore.create` triggers an immediate `drainPending`
     * for the new task's session. Disabling this turns the create
     * surface into a pure persistence operation; the operator must then
     * trigger the drain explicitly via CLI / HTTP.
     */
    runOnCreate: boolean;
    /**
     * Tasks left in `running` longer than this on bootstrap are
     * recovered to `pending` so the next drain picks them up. Guards
     * against orphan rows after process crashes.
     */
    staleAfterMs: number;
    /**
     * Background-autonomy kill switch. When `false` the scheduler is
     * never constructed, `runDue` becomes a no-op, and the CLI `task
     * tick` subcommand short-circuits. Independent of `tasks.enabled`
     * so operators can keep the durable queue alive while disabling
     * the periodic wakeup loop.
     */
    schedulerEnabled: boolean;
    /** Scheduler polling interval. Default 5 000 ms. */
    schedulerTickMs: number;
    /**
     * Upper bound on the number of due tasks consumed per tick. The
     * runner still enforces per-session FIFO, so larger batches let
     * more independent sessions fire in parallel within one tick.
     */
    schedulerBatch: number;
    /**
     * Agent-side `tasks.*` tools kill switch. When `false`, the five
     * tools (`tasks.schedule|cron|list|cancel|show`) are not
     * registered and the agent cannot self-schedule. Independent of
     * `tasks.enabled` so operators can keep the CLI / HTTP surfaces
     * alive while denying the agent write access.
     */
    agentToolsEnabled: boolean;
    /**
     * Lower bound on `interval` schedule `everyMs`. Cannot go below
     * `SCHEDULE_INTERVAL_MIN_MS` (1 000 ms) in `task-schedule.ts`;
     * this knob lets operators enforce a larger floor.
     */
    minIntervalMs: number;
  };
  /**
   * Self-update controls. Env-only operational tuning (not user-config
   * file material). The TUI checks GitHub Releases on startup and, when
   * a newer version is published, offers an in-app update that re-runs
   * the canonical `install.sh`.
   */
  update: {
    /**
     * Fire the startup version check in the TUI. Env-only:
     * `ATOMIC_AGENT_UPDATE_CHECK_ON_STARTUP`. Set to `false` to disable
     * the network call and the update prompt entirely.
     */
    checkOnStartup: boolean;
    /**
     * GitHub `owner/repo` queried for the latest release and used as the
     * `install.sh` source. Env-only: `ATOMIC_AGENT_REPO`.
     */
    repo: string;
  };
  /**
   * Cross-session memory fabric. The profile store is a durable SQLite
   * key/value table rendered into the prompt tail on every turn. The
   * reflection layer runs at the end of every turn (fire-and-forget) to
   * distil durable facts out of the last exchange and write them back
   * into the profile store. The notes store is a separate FTS5-backed
   * table that the agent reads/writes explicitly via dedicated tools —
   * it never touches the prompt on its own, so growing the notes corpus
   * does not invalidate the KV-cached stable prefix.
   */
  memory: {
    profile: {
      enabled: boolean;
      /** Safety-net ceiling for the rendered `### profile` section. */
      maxTokens: number;
      /**
       * Master switch for the contextual-keyword gate applied by
       * `profile-renderer`. When `true` (default), facts stored with
       * `pinned=false` render into `### profile` only when one of
       * their `keywords` hits the current user message. Flip to
       * `false` to force every fact to render regardless of gating
       * (pre-v3 behaviour) — useful for debugging and for callers
       * that have no user message to key off.
       */
      contextualKeywordGate: boolean;
    };
    reflection: {
      enabled: boolean;
      /** Hard timeout per reflection call (ms). */
      timeoutMs: number;
      /** Upper bound on profile facts written per reflection. */
      maxFactsPerCall: number;
      /**
       * Master switch for the NOTE extraction channel. When `false`,
       * the reflection runner still honours SET facts but drops every
       * NOTE line even if `memoryStore` is wired — useful for rolling
       * out the new behaviour gradually or disabling it if MemoryStore
       * growth becomes a concern.
       */
      autoStoreNotes: boolean;
      /**
       * Upper bound on freeform notes written per reflection call.
       * Mirrors `maxFactsPerCall` for the MemoryStore channel. `0`
       * disables note extraction even when `autoStoreNotes` is true.
       */
      maxNotesPerCall: number;
      /** v2.5 typed-NOTE extraction. See UserConfigFile.memory.reflection.typedNotes. */
      typedNotes: {
        enabled: boolean;
      };
      /** v2.5 sliding-window reflection segmentation. See UserConfigFile.memory.reflection.segmentation. */
      segmentation: {
        enabled: boolean;
        triggerEveryTurns: number;
        windowTurns: number;
      };
      /**
       * Multi-party reflection mode (config v19+). See
       * UserConfigFile.memory.reflection.anySpeaker for rationale.
       * When `true`, the reflection prompt switches to a prefix
       * that treats every speaker in the USER channel as a source
       * worth extracting (e.g. third-party dialog dumps from
       * LoCoMo / LongMemEval benchmarks). Default `false`.
       */
      anySpeaker: boolean;
    };
    notes: {
      enabled: boolean;
      /** Hard cap on stored memory rows. Oldest rows are evicted on overflow. */
      maxEntries: number;
      /** Per-call input ceiling for `memory.notes.store.content`. */
      maxContentChars: number;
      /** Default `k` when `memory.notes.recall` omits it. */
      recallDefaultK: number;
    };
    /**
     * Pre-step recall injection: each turn, the agent-loop can pre-fetch
     * the top-K notes most relevant to the user message and render them
     * as `### recalled` in the prompt tail. `k=0` or `enabled=false`
     * disables the section entirely.
     *
     * Kept strictly in the variable tail (never the stable prefix) so
     * the KV cache of the persona/tools/skills slab stays intact across
     * turns with different recalled sets.
     */
    recallInjection: {
      enabled: boolean;
      /** Top-K notes to include. Applied after BM25 ranking. */
      k: number;
      /** Per-line preview clip length (chars) in the `### recalled` block. */
      previewChars: number;
      /** Safety-net ceiling for the rendered `### recalled` section. */
      maxTokens: number;
    };
    /**
     * Memory index: compact `#id tags preview` pointers rendered as the
     * `### memory-index` section. Lets the agent know *what notes exist*
     * without paying the full body cost — drilling in is via
     * `memory.notes.recall { id }`.
     */
    index: {
      enabled: boolean;
      /** How many most-recent note pointers to advertise. */
      limit: number;
      /** Per-line preview clip length (chars). */
      previewChars: number;
      /** Safety-net ceiling for the rendered `### memory-index` section. */
      maxTokens: number;
    };
    /** Phase 1A: pre-insert near-match deduplication. See UserConfigFile.memory.dedup. */
    dedup: {
      enabled: boolean;
      fts5Threshold: number;
    };
    /** Phase 1A: utility-weighted overflow eviction. See UserConfigFile.memory.eviction. */
    eviction: {
      utilityWeighted: boolean;
      maxAgeMs: number;
    };
    /**
     * Phase 1B: hybrid FTS5 + cosine recall. See
     * UserConfigFile.memory.embeddings. Default **disabled** — the
     * runtime only attempts to talk to the embedding daemon when this
     * flag flips on AND a model is configured AND the daemon is
     * reachable.
     */
    embeddings: {
      enabled: boolean;
      fts5Weight: number;
      vectorWeight: number;
      bruteForceCeiling: number;
    };
    /**
     * Phase 2: reactive link graph. See UserConfigFile.memory.links.
     * Default disabled — the link-generator LLM sub-call is opt-in,
     * and recall-side expansion only fires when enabled is true.
     */
    links: {
      enabled: boolean;
      autoGenerate: boolean;
      expansionDepth: number;
      maxExpanded: number;
      maxLinksPerCall: number;
      minCandidates: number;
      generatorTimeoutMs: number;
    };
    /**
     * Phase 3: memory evolution (neighbor-evolver). Default disabled
     * — without it the parser still recognises `EVOLVE` lines but
     * silently drops them. See UserConfigFile.memory.evolution.
     */
    evolution: {
      enabled: boolean;
      maxPerWrite: number;
      leaseMs: number;
    };
    /**
     * Phase 5: distilled lessons + cold-path consolidator. See
     * UserConfigFile.memory.lessons for full doc. Default disabled —
     * with the master switch off, `### lessons` is not rendered,
     * `memory.lessons.recall` returns `LessonsDisabledError`, and
     * the consolidator never registers its periodic timer.
     */
    lessons: {
      enabled: boolean;
      recallK: number;
      maxTokens: number;
      indexLimit: number;
      maxEntries: number;
      deprecationAgeMs: number;
    };
    /**
     * Phase 7b: MemP-style advisory procedures distilled alongside
     * lessons. Default disabled — when off, the `### procedures`
     * section is not rendered, `memory.procedures.recall` returns a
     * `ProceduresDisabledError`, and the consolidator emits only the
     * `LESSON` half of the combined grammar.
     */
    procedures: {
      enabled: boolean;
      recallK: number;
      maxTokens: number;
      indexLimit: number;
      maxEntries: number;
      deprecationAgeMs: number;
    };
    consolidation: {
      enabled: boolean;
      intervalMs: number;
      cooldownMs: number;
      minClusterSize: number;
      maxClustersPerTick: number;
      requireSharedTag: boolean;
      distillTimeoutMs: number;
    };
    /**
     * Phase 7a: ExpeL-style vote curation. The reflection slot grows
     * one extra sub-call per turn (after link-generator and
     * neighbor-evolver) that asks the model to UPVOTE/DOWNVOTE the
     * items surfaced in this turn's variable tail. See
     * `UserConfigFile.memory.voting` for full doc. Default disabled
     * — flipping it on adds the extra LLM call on the shared
     * reflection slot.
     */
    voting: {
      enabled: boolean;
      maxVotePerItem: number;
      signalDecay: number;
      scoreBlend: number;
      eventLogMaxRows: number;
      profileFilterThreshold: number;
    };
    /**
     * v2.5 heuristic-gated query rewriter for recall. See
     * UserConfigFile.memory.retrieve.rewriter for full doc. Default
     * disabled — the provider chain is byte-identical to pre-v18
     * behaviour when off.
     */
    retrieve: {
      rewriter: {
        enabled: boolean;
        timeoutMs: number;
        historyTurns: number;
        gateMode: RewriterGateMode;
        embeddingGate: {
          threshold: number;
          exemplars: string[] | null;
        };
      };
    };
  };
  /**
   * Webhook ingress bindings. Mirrors `UserConfigFile.webhooks` —
   * loaded from disk on startup and handed to the HTTP layer so the
   * `POST /api/webhooks/:name` route can resolve bindings without
   * reaching back into the user config file.
   */
  webhooks: Record<string, WebhookConfig>;
  /**
   * Multimodal (vision) input configuration. The runtime registers the
   * `vision.describe` tool only when (a) `vision.enabled` is true AND
   * (b) the connected llama-server reports `mmproj`/clip support via
   * `/props` (probed at bootstrap by `detectModelProfile`). When
   * `autoDetect` is `false` the capability check is skipped and the
   * tool is registered unconditionally — useful for headless test
   * runs where `/props` is mocked. Limits guard the `image_data`
   * transport against accidentally embedding a 100 MB screenshot.
   */
  vision: {
    /** Master kill switch. Disables the tool, skips capability detection. */
    enabled: boolean;
    /** When `false`, treat any vision-capable model as supported regardless of `/props`. */
    autoDetect: boolean;
    /** Hard upper bound on a single image's decoded byte length. */
    maxImageBytes: number;
    /** Hard upper bound on the number of images per `vision.describe` call. */
    maxImagesPerCall: number;
  };
  /**
   * TUI appearance and input. Mirrors `UserConfigFile.tui`. `theme` is
   * `"auto"` (OSC 11 autodetect) or a registered theme name; `mouse`
   * toggles terminal mouse reporting. Consumed by the TUI startup path;
   * the rest of the runtime ignores it.
   */
  tui: {
    theme: string;
    whileBusySubmit: WhileBusySubmitMode;
    mouse: boolean;
    onboarding: OnboardingState;
  };
  /**
   * Anonymous product analytics (PostHog). Mirrors
   * `UserConfigFile.analytics`. Only `{ provider, model }` and a random
   * anonymous install id ever leave the machine — never message content,
   * paths, tool args, or the machine's IP (see `src/analytics/`).
   */
  analytics: {
    enabled: boolean;
  };
  /**
   * Telegram remote-control channel. Mirrors `UserConfigFile.telegram`.
   * The bot token is **not** stored here — it lives in
   * `<stateDir>/.env` as `TELEGRAM_BOT_TOKEN` and is loaded at
   * bootstrap by `loadDotenvFromStateDir`. This block only carries
   * the master kill switch and the single-operator owner id.
   */
  telegram: TelegramConfig;
  /**
   * MCP (Model Context Protocol) client configuration. Mirrors
   * `UserConfigFile.mcp`. Each entry in `servers[]` becomes a
   * lifecycle-managed connection to an external MCP server. Tools
   * are exposed through the regular `ToolRegistry` as
   * `mcp.<server>.<tool>`. See AGENTS.md §"MCP client".
   */
  mcp: {
    servers: McpServerConfig[];
  };
  /**
   * LLM provider registry (local llama-server + cloud). When omitted,
   * the runtime synthesizes a single `local-llama` entry from
   * `localModels.*`.
   */
  llm?: {
    activeTextProvider: string;
    activeEmbeddingProvider: string;
    providers: ReadonlyArray<{
      id: string;
      kind: string;
      url?: string;
      apiKey?: string;
      model?: string;
      baseUrl?: string;
      defaultChatModel?: string;
      defaultEmbeddingModel?: string;
      headers?: Record<string, string>;
      /**
       * Header carrying this entry's API key for services that do not
       * accept `Authorization: Bearer` (Anthropic wants `x-api-key`).
       */
      apiKeyHeader?: string;
      supportsTools?: boolean;
      supportsVision?: boolean;
      requestTimeoutMs?: number;
      promptCache?: "auto" | "off" | "explicit-markers";
      providerPreferences?: Record<string, unknown>;
      /**
       * Vendor-specific fields merged into the OpenAI-compatible chat
       * body. Reserved keys (`model`, `messages`, `stream`, `tools`)
       * are re-applied after the merge and cannot be overridden.
       */
      extraBody?: Record<string, unknown>;
      /**
       * Settings for a `subscription-cli` provider: which already
       * signed-in vendor CLI to drive (`claude`, `codex`) and how to
       * invoke it. There is no API key on these entries — the CLI
       * authenticates from its own session.
       */
      subscriptionCli?: {
        cli: "claude" | "codex";
        binPath?: string;
        extraArgs?: string[];
        streaming?: boolean;
        maxBudgetUsd?: number;
      };
      userModels?: ReadonlyArray<{
        id: string;
        kind: "chat" | "embedding";
        contextWindow?: number;
        dim?: number;
        supportsVision?: boolean;
        supportsTools?: "none" | "basic" | "parallel" | "strict";
        supportsPromptCache?: boolean;
        reasoningFormat?:
          | "none"
          | "delta_reasoning"
          | "delta_thinking"
          | "delta_reasoning_content";
        pricing?: {
          input: number;
          output: number;
          cacheRead?: number;
          cacheWrite?: number;
        };
      }>;
    }>;
    toolTransport: "auto" | "grammar" | "native_tools";
    allowCloudSampling?: boolean;
    costTracking?: {
      enabled: boolean;
      showInStatusBar: boolean;
      dailyResetHourUtc: number;
    };
    /**
     * Cross-provider fallover. `chain` is an ordered list of provider ids
     * (primary first) tried in turn when the active provider is
     * unavailable; the local llama-server provider is auto-appended
     * unless `appendLocal` is false. Timing knobs default to the
     * circuit-breaker numbers in AGENTS.md §"Provider fallback chain".
     */
    fallback?: {
      chain?: readonly string[];
      appendLocal?: boolean;
      failureThreshold?: number;
      cooldownMs?: readonly number[];
      probeThrottleMs?: number;
      failureWindowMs?: number;
    };
  };
}

/**
 * Telegram parse mode applied to *agent replies* on outbound. Slash
 * commands, failure messages, and approval keyboards always send as
 * plain text regardless of this setting (see AGENTS.md §"Telegram
 * remote-control channel"). MarkdownV2 is intentionally excluded —
 * the escape surface is too wide for typical LLM output.
 */
export type TelegramParseMode = "plain" | "html";

/**
 * Telegram channel configuration. Single-operator semantics: only
 * messages whose `from.id` matches `ownerUserId` are dispatched into
 * the agent loop. Group chats are dropped unconditionally.
 */
export interface TelegramConfig {
  /** Master kill switch. When `false`, the channel is constructed but never started. */
  enabled: boolean;
  /**
   * Numeric Telegram user id of the sole permitted operator. `null`
   * means "not configured yet" — the channel refuses to start until
   * an id is set (manually or via the slice-3 pairing flow).
   */
  ownerUserId: number | null;
  /**
   * Render mode for agent-driven outbound replies. Defaults to
   * `"html"` (markdown → Telegram HTML subset). Set `"plain"` to
   * disable formatting entirely — useful as an escape hatch if the
   * formatter ever misbehaves in the wild. Added in config v10;
   * older files transparently get `"html"` via the migration in
   * `parseUserConfigFile`.
   */
  parseMode: TelegramParseMode;
  /**
   * Live progress indicator in the Telegram channel: a single editable
   * "Thinking…" bubble that mirrors the turn's activity and deletes
   * itself when the reply lands. Enabled by default; `false` is the
   * kill switch if the always-on behavior surprises anyone in
   * production. Added in config v34; older files transparently get
   * `true` via the defaults-fallback in `parseUserConfigFile`.
   */
  progressIndicator: boolean;
}

/**
 * When to require approval for outbound HTTP calls via `os.http.request`.
 *  - `never`:   trust the LLM blindly (not recommended outside sandboxes).
 *  - `writes`:  GET + HEAD bypass approval; anything with a body (POST…) needs it.
 *  - `always`:  every call goes through the approval gate.
 */
export type HttpApprovalMode = "never" | "writes" | "always";

export type LocalLlmMode = "external" | "managed";

export interface UserManagedLocalLlmConfig {
  modelId: string | null;
  port: number;
  dataDirOverride: string | null;
  /**
   * When true, managed-mode start (TUI auto-start / `s`, CLI
   * `models start`) checks GitHub Releases and replaces the llama.cpp
   * zip if a newer tag (or a stale Windows variant) is available.
   * Default `true` since config v41. Older files stored an unused
   * `false` default — those migrate to `true`. Set `false` to pin the
   * installed backend.
   */
  autoUpdate: boolean;
  /**
   * Compute-device preference for the managed llama.cpp daemon:
   *   - `"auto"` (default) — enumerate via `llama-server --list-devices`
   *     at start and pick the best discrete GPU; CPU fallback when none.
   *   - a concrete backend device id (e.g. `"Vulkan0"`) — pin offload to
   *     that device.
   *   - `"cpu"` — force CPU-only (`-ngl 0`).
   * Resolved in `startDaemon` via `resolveManagedDevice`.
   */
  device: string;
  /**
   * llama-server context window (`--ctx-size`) for the managed chat
   * daemon.
   *   - `0` (default) — auto: fit the context to the target device's
   *     free VRAM at start (see `estimateContextSize`).
   *   - a positive value — pin `--ctx-size` exactly, clamped only to the
   *     model's trained context ceiling.
   */
  contextSize: number;
  /**
   * Stop the managed chat daemon when the last CLI session exits.
   * `true` (default) — closing the terminal frees the RAM/VRAM the
   * model was holding; a second live session keeps the daemon up (see
   * `session-registry.ts`). `false` — keep the model warm between
   * sessions; the operator stops it via `atomic-agent models stop`.
   * Standalone daemons started with `models start` are never touched.
   * Added in config v34; older files transparently get `true`.
   */
  stopOnExit: boolean;
}

/**
 * Memory-v2 phase 1B. Second managed `llama-server` instance dedicated
 * to `/embedding`. Lives next to the chat daemon in `<stateDir>/llamacpp/`
 * but runs as a separate OS process on its own port. The reason is
 * structural: `--embeddings` switches llama-server to pooling-only
 * mode, so the same process cannot serve `/completion` and `/embedding`
 * simultaneously.
 *
 * Lifecycle is tied to the chat daemon at the CLI level
 * (`atomic-agent models start` brings both up, `models stop` brings
 * both down) but failure isolation is preserved: if the embedding
 * daemon refuses to start, the chat daemon still runs and the memory
 * subsystem transparently falls back to FTS5-only recall.
 *
 * `enabled=false` (default) ⇒ no second daemon, no embedding writes,
 * no hybrid recall — observably identical to phase 1A.
 */
export interface UserManagedEmbeddingLlmConfig {
  enabled: boolean;
  /** `EmbeddingModelId` from the catalog, or `null` when not chosen. */
  modelId: string | null;
  port: number;
  /** Base URL of the embedding-only llama-server. */
  url: string;
}

/**
 * User-facing keys that live in `<stateDir>/config.json`. The file
 * format is versioned; bump `USER_CONFIG_VERSION` on breaking schema
 * changes and add a migration step in `parseUserConfigFile`.
 */
export interface UserConfigFile {
  /**
   * The on-disk schema version. Usually `USER_CONFIG_VERSION`, but a file
   * written by a NEWER build keeps its own (higher) number all the way
   * through parse and write-back, so an older build can never label a
   * newer file with its own version. See `parseUserConfigFile`.
   */
  version: number;
  // NB: keys from a newer schema ride along on the object at runtime (see
  // `unknownTopLevelKeys`) but are deliberately absent from this type. An
  // index signature here would make every property name valid on the type
  // the whole tree writes back — `{ ...file, viison: … }` would compile.
  localModels: {
    url: string;
    mode: LocalLlmMode;
    /**
     * Upper bound on `n_predict` for grammar-constrained tool-call
     * completions. Added in config v7 to let users raise the cap
     * without juggling the `ATOMIC_AGENT_LLAMA_MAX_TOKENS` env var.
     * Range [64, 131072]. The env var, when set, still wins over
     * this file value (operator override).
     */
    completionMaxTokens: number;
    managed: UserManagedLocalLlmConfig;
    /**
     * Memory-v2 phase 1B. Optional second managed daemon for
     * embeddings. Added in config v12; older files are upgraded with
     * `{ enabled: false, modelId: null, port: 19092 }`.
     */
    embeddings: UserManagedEmbeddingLlmConfig;
    /**
     * GGUF models the operator added from an arbitrary Hugging Face repo
     * (config v44). Each entry is a whole `LocalModelDef` with a
     * `custom-` prefixed id; `loadConfig()` publishes them to the catalog
     * registry so curated and added models resolve through one lookup.
     * Older files inherit `[]`.
     */
    customModels: LocalModelDef[];
  };
  log: { level: LogLevel };
  agent: {
    tokenBudget: number;
    maxSteps: number;
    toolTimeoutMs: number;
    /**
     * Five-step approval ladder (config v37). Replaces the binary
     * `approvalRequired`; the legacy key is still read once for
     * migration (see `resolveApprovalLevel`) and never written back.
     */
    approvalLevel: ApprovalLevel;
    conversationMaxTokens: number;
    worldSnapshotMaxTokens: number;
  };
  http: {
    enabled: boolean;
    approvalMode: HttpApprovalMode;
    hostAllowlist: string[] | null;
    maxResponseBytes: number;
    defaultTimeoutMs: number;
  };
  web: {
    search: WebSearchConfig;
    fetch: WebFetchConfig;
  };
  /**
   * Project path resolution (config v36). `roots` lists directories
   * whose direct children are the user's projects; `os.fs.locate_project`
   * matches fuzzy project names against them (one level, never
   * recursive). Empty by default so the agent never scans anything the
   * user did not explicitly declare.
   */
  projects: {
    roots: string[];
  };
  tracing: {
    trace: {
      enabled: boolean | null;
      maxBytesPerSession: number;
    };
  };
  memory: {
    profile: {
      enabled: boolean;
      maxTokens: number;
      contextualKeywordGate: boolean;
    };
    reflection: {
      enabled: boolean;
      timeoutMs: number;
      maxFactsPerCall: number;
      autoStoreNotes: boolean;
      maxNotesPerCall: number;
      /**
       * v2.5 (config v18). Typed-NOTE extraction:
       * when `enabled`, the reflection prompt forces every NOTE to
       * carry a `[type=event|behavior|knowledge|skill]` marker that
       * the parser projects into a synthetic `type:X` tag on the
       * stored memory. Default `false` — legacy untyped NOTEs are
       * byte-stable. Flipping the flag invalidates the reflection
       * slot's KV cache once on the next call (the main agent slot
       * is unaffected).
       */
      typedNotes: {
        enabled: boolean;
      };
      /**
       * v2.5 (config v18). Sliding-window
       * reflection segmentation: instead of firing reflection after
       * every turn with only the last user/assistant pair, accumulate
       * up to `windowTurns` exchanges and fire reflection once every
       * `triggerEveryTurns` turns. Reflection still fires
       * unconditionally on `reason: "finish"` so the trailing partial
       * window is never lost. Default `enabled = false` preserves the
       * per-turn behaviour exactly.
       */
      /**
       * Multi-party / "any-speaker" reflection mode (config v19+).
       * When `true`, the reflection prompt switches to
       * `REFLECTION_STABLE_PREFIX_ANY_SPEAKER` so the extractor
       * treats every named speaker in the USER channel — including
       * third parties — as a valid source for SET / NOTE
       * extraction. Designed for evaluation benchmarks (LoCoMo,
       * LongMemEval) where the USER message is a dump of a
       * multi-party dialog rather than the user's own statements.
       *
       * Default `false`. Production personal-assistant users keep
       * the user-centric prefix that rejects "content not stated
       * by the user". Flipping the flag invalidates the reflection
       * slot's KV cache once on the next call; the main agent slot
       * is unaffected. Wins over `typedNotes` because the
       * any-speaker prefix already enforces typed NOTEs.
       */
      anySpeaker: boolean;
      segmentation: {
        enabled: boolean;
        /**
         * Trigger reflection every N turns. Must be a positive
         * integer; `1` is functionally equivalent to disabled mode
         * (reflection fires every turn).
         */
        triggerEveryTurns: number;
        /**
         * Number of trailing user/assistant pairs to feed into the
         * reflection prompt. Bounded by `triggerEveryTurns` from
         * below — the runtime clamps the slice to whatever is
         * available so an early-session turn never blows past the
         * existing transcript.
         */
        windowTurns: number;
      };
    };
    notes: {
      enabled: boolean;
      maxEntries: number;
      maxContentChars: number;
      recallDefaultK: number;
    };
    recallInjection: {
      enabled: boolean;
      k: number;
      previewChars: number;
      maxTokens: number;
    };
    index: {
      enabled: boolean;
      limit: number;
      previewChars: number;
      maxTokens: number;
    };
    /**
     * Memory-v2 phase 1A: opt-in pre-insert dedup. Added in config v11;
     * older files transparently upgraded with the defaults below.
     */
    dedup: {
      enabled: boolean;
      fts5Threshold: number;
    };
    /**
     * Memory-v2 phase 1A: utility-weighted overflow eviction. Added in
     * config v11.
     */
    eviction: {
      utilityWeighted: boolean;
      maxAgeMs: number;
    };
    /**
     * Memory-v2 phase 1B: hybrid FTS5 + embedding recall. Added in
     * config v12. Default **disabled** — the runtime won't try to
     * embed anything until this flips on and a second daemon is
     * available.
     */
    embeddings: {
      enabled: boolean;
      fts5Weight: number;
      vectorWeight: number;
      bruteForceCeiling: number;
    };
    /**
     * Memory-v2 phase 2: reactive link graph. Added in config v13.
     * Default **disabled** — the link-generator reflection sub-call
     * (an extra LLM round-trip on the reflection slot at end of
     * turn) is opt-in, and recall-side BFS expansion is gated on
     * `enabled` as well so the legacy hybrid-recall path stays
     * byte-stable.
     *
     *  - `enabled`            master switch (covers both recall
     *                         expansion and link generation).
     *  - `autoGenerate`       fire the `link-generator` sub-call
     *                         after main reflection. Set to `false`
     *                         to keep the schema + expansion
     *                         machinery but never grow the graph
     *                         automatically (manual `LinkStore.add`
     *                         still works).
     *  - `expansionDepth`     BFS depth on recall. Clamped to [1, 3].
     *  - `maxExpanded`        Hard cap on expanded-id count per
     *                         recall turn.
     *  - `maxLinksPerCall`    Hard cap on persisted edges per
     *                         link-generator call.
     *  - `minCandidates`      Skip the LLM call when the surfaced
     *                         set has fewer than this many ids
     *                         (zero useful links possible).
     *  - `generatorTimeoutMs` Hard timeout for the LLM call.
     */
    links: {
      enabled: boolean;
      autoGenerate: boolean;
      expansionDepth: number;
      maxExpanded: number;
      maxLinksPerCall: number;
      minCandidates: number;
      generatorTimeoutMs: number;
    };
    /**
     * Memory-v2 phase 3: neighbor-evolver. Added in config v14.
     * Default **disabled** — when off the parser still recognises
     * `EVOLVE` lines but the runner drops them silently. Flip on to
     * let reflection refine `tags` on existing memories.
     *
     *  - `enabled`     master switch. Default `false`.
     *  - `maxPerWrite` Hard cap on number of EVOLVE directives
     *                  actually applied per reflection. Default `2`.
     *  - `leaseMs`     B↔C lease window in ms. EVOLVE skips any
     *                  target whose `consolidating_at` lies within
     *                  `now - leaseMs`. Default `60000` (1 min).
     */
    evolution: {
      enabled: boolean;
      maxPerWrite: number;
      leaseMs: number;
    };
    /**
     * Memory-v2 phase 5. Distilled lessons + cold-path consolidator.
     * Default disabled because rolling phase 5 on flips the stable
     * prefix bytes once (see AGENTS.md "Memory fabric phase 5"), so
     * deployments choose an explicit upgrade window.
     *
     * `lessons` keys:
     *   - `enabled`            master switch for `### lessons`
     *                          rendering + `memory.lessons.recall` +
     *                          `ConsolidatorJob.start`. Default
     *                          `false`.
     *   - `recallK`            top-K lessons surfaced per turn (BM25).
     *                          Default `2`.
     *   - `maxTokens`          hard cap on the rendered `### lessons`
     *                          block. Default `300`.
     *   - `indexLimit`         row cap on `LessonStore.listIndex`.
     *                          Default `20`.
     *   - `maxEntries`         hard cap on active lessons. Default
     *                          `500`. Phase 6 owns the deprecation
     *                          sweep — phase 5 plumbs it dormant.
     *   - `deprecationAgeMs`   phase 6 hook (still wired in phase 5):
     *                          lessons with `success_count == 0`
     *                          older than this become deprecated.
     *                          Default `2_592_000_000` (30 days).
     *
     * `consolidation` keys:
     *   - `enabled`              master switch on the consolidator
     *                            timer. Default `false`. Independent
     *                            from `lessons.enabled` so the schema
     *                            can be inspected without ticking.
     *   - `intervalMs`           consolidator tick period. Default
     *                            `21_600_000` (6 h).
     *   - `cooldownMs`           episodes younger than this are
     *                            ineligible (must "cool down" before
     *                            distillation). Default `86_400_000`
     *                            (24 h).
     *   - `minClusterSize`       minimum cluster size to distill.
     *                            Default `3`.
     *   - `maxClustersPerTick`   throughput cap on a single tick.
     *                            Default `5`.
     *   - `requireSharedTag`     when `true`, every member of a CC
     *                            must share at least one tag with
     *                            every other member. Default `true`
     *                            for semantic cohesion.
     *   - `distillTimeoutMs`     per-cluster LLM timeout. Default
     *                            `45_000` ms.
     */
    lessons: {
      enabled: boolean;
      recallK: number;
      maxTokens: number;
      indexLimit: number;
      maxEntries: number;
      deprecationAgeMs: number;
    };
    /**
     * Memory-v2 phase 7b. Procedures (MemP-style how-to templates)
     * mirroring `lessons.*`:
     *   - `enabled`           master switch. Default `false`.
     *   - `recallK`           top-K procedures surfaced per turn
     *                         via BM25 against the current user
     *                         message. Default `2`.
     *   - `maxTokens`         hard cap on the rendered `### procedures`
     *                         block. Default `400`.
     *   - `indexLimit`        row cap on `ProcedureStore.listIndex`.
     *                         Default `20`.
     *   - `maxEntries`        hard cap on active procedures. Default
     *                         `500`. Overflow triggers FIFO eviction
     *                         in the consolidator (scenario 7b.F.2).
     *   - `deprecationAgeMs`  procedures with `success_count == 0`
     *                         AND `use_count == 0` older than this
     *                         are deprecated. Default `2_592_000_000`
     *                         (30 days).
     */
    procedures: {
      enabled: boolean;
      recallK: number;
      maxTokens: number;
      indexLimit: number;
      maxEntries: number;
      deprecationAgeMs: number;
    };
    consolidation: {
      enabled: boolean;
      intervalMs: number;
      cooldownMs: number;
      minClusterSize: number;
      maxClustersPerTick: number;
      requireSharedTag: boolean;
      distillTimeoutMs: number;
    };
    /**
     * Memory-v2 phase 7a. Vote curation (ExpeL-style). Adds a vote
     * sub-call to the reflection pipeline that emits UPVOTE /
     * DOWNVOTE markers against items surfaced in the current turn,
     * plus a cold-path decay applied by `ConsolidatorJob`.
     *
     * `voting` keys:
     *   - `enabled`               master switch. When `false` the
     *                              vote sub-call is skipped, decay
     *                              does not run, and the lesson
     *                              recall reranker treats every
     *                              row as if `vote_score = 0`.
     *                              Default `false`.
     *   - `maxVotePerItem`        clamp on `|vote_score|`. Each
     *                              UPVOTE/DOWNVOTE is `+1`/`-1` and
     *                              the row is pinned in
     *                              `[-maxVotePerItem, +maxVotePerItem]`.
     *                              Must be > 0; bootstrap rejects 0.
     *                              Default `50`.
     *   - `signalDecay`           per-tick scaling factor applied
     *                              to every `vote_score` value on
     *                              the consolidator tick. Range
     *                              `(0, 1]`; `1.0` disables decay,
     *                              `0.95` matches the spec default.
     *                              Bootstrap rejects `<= 0` and
     *                              `> 1`. Default `0.95`.
     *   - `scoreBlend`            weight of `vote_score` in
     *                              `combinedScore = scoreBlend *
     *                              vote_score + (1 - scoreBlend) *
     *                              (success_count - failure_count)`.
     *                              Range `[0, 1]`. Default `0.6`.
     *   - `eventLogMaxRows`       FIFO cap on the `vote_events`
     *                              audit log. Default `50_000`;
     *                              `0` disables eviction (the row
     *                              count is then bounded only by
     *                              disk space).
     *   - `profileFilterThreshold` minimum `|vote_score|` at which a
     *                              `profile_facts` row is hidden
     *                              from `### profile`. Negative
     *                              votes ≤ `-profileFilterThreshold`
     *                              mute the fact; positive scores
     *                              never hide a fact. Default `3`.
     */
    voting: {
      enabled: boolean;
      maxVotePerItem: number;
      signalDecay: number;
      scoreBlend: number;
      eventLogMaxRows: number;
      profileFilterThreshold: number;
    };
    /**
     * v2.5 memory fabric additions (config v18). Heuristic-
     * gated query rewriter for recall. The rewriter runs as a
     * decorator wrapped around `createDefaultMemoryContextProvider`:
     * before BM25/cosine recall, if the current user message looks
     * referential (short, pronouns, conjunction-starter), one LLM
     * call rewrites it into a self-contained query using the last
     * few turns of conversation; otherwise the raw message is used
     * as today. The rewriter uses `slotId = -1` so the **main agent
     * slot** and the **reflection slot** are both untouched.
     *
     * `retrieve.rewriter` keys:
     *  - `enabled`       master switch. Default `false`.
     *  - `timeoutMs`     hard per-call timeout. Default `3000`.
     *  - `historyTurns`  trailing turns fed into the rewriter
     *                    prompt. Default `3`.
     *  - `gateMode`      `heuristic` | `embedding` | `always`.
     *                    Default `heuristic`. Eval profiles often
     *                    use `embedding` for multilingual recall.
     *  - `embeddingGate.threshold` cosine floor when
     *                    `gateMode=embedding`. Default `0.65`.
     *  - `embeddingGate.exemplars` custom EN referential phrases;
     *                    `null` uses built-in defaults.
     */
    retrieve: {
      rewriter: {
        enabled: boolean;
        timeoutMs: number;
        historyTurns: number;
        gateMode: RewriterGateMode;
        embeddingGate: {
          threshold: number;
          exemplars: string[] | null;
        };
      };
    };
  };
  /**
   * Keyed map of webhook ingress bindings. Each entry is mounted at
   * `POST /api/webhooks/<name>`. Added in config v3; older files are
   * transparently upgraded with `webhooks: {}`.
   */
  webhooks: Record<string, WebhookConfig>;
  /**
   * Multimodal (vision) input. Added in config v6; older files are
   * transparently upgraded with the `USER_CONFIG_DEFAULTS.vision`
   * defaults.
   */
  vision: {
    enabled: boolean;
    autoDetect: boolean;
    maxImageBytes: number;
    maxImagesPerCall: number;
  };
  /**
   * Skill management. Added in config v8 so installed skills can be
   * turned off without removing their files from disk. `disabled`
   * holds kebab-case skill names; older files are transparently
   * upgraded with `skills: { disabled: [] }`.
   *
   * `taps` (added in config v30) holds GitHub `owner/repo`
   * repositories the skill hub browses for installable SKILL.md
   * skills. Older files are upgraded with the default tap set
   * (`anthropics/skills`, `openai/skills`, `vercel-labs/agent-skills`).
   *
   * `clawhub` (added in config v31) configures the ClawHub registry
   * (https://clawhub.ai) — the primary skill marketplace, browsed and
   * searched server-side. Older files are upgraded with it enabled,
   * pointed at the public registry, hiding suspicious skills by default.
   */
  skills: {
    disabled: string[];
    taps: string[];
    clawhub: {
      enabled: boolean;
      apiBase: string;
      browseLimit: number;
      nonSuspiciousOnly: boolean;
    };
  };
  /**
   * TUI appearance. Added in config v29. `theme` is either the literal
   * `"auto"` (default — detect the terminal background via OSC 11 and pick
   * the matching classic theme) or a registered theme name (e.g.
   * `khorne-red`, `moon-yellow`). Names the registry used to carry are
   * rehomed to the nearest surviving palette by `resolveThemeName`, so
   * an older file never loses its theme silently. Persisted from the
   * in-app `/theme` picker. Older files are
   * transparently upgraded with `tui: { theme: "auto" }`.
   *
   * `mouse` (config v38, default `true`) turns terminal mouse reporting
   * on: clicking panels, list rows, the nav bar and the prompt, plus
   * wheel scrolling. Turning it off restores the terminal's own
   * drag-to-select, which mouse reporting takes over — see `/mouse` and
   * `--no-mouse`. Older files are upgraded with `mouse: true`.
   */
  tui: {
    theme: string;
    whileBusySubmit: WhileBusySubmitMode;
    mouse: boolean;
    onboarding: OnboardingState;
  };
  /**
   * Anonymous product analytics (PostHog). Added in config v33. Older
   * files are transparently upgraded with `analytics: { enabled: true }`.
   * Opt-out only via this flag — set `enabled: false` to disable. Only
   * `{ provider, model }` plus a random anonymous install id are sent;
   * message content, file paths, tool arguments, and the machine's IP
   * are never transmitted (see `src/analytics/`).
   */
  analytics: {
    enabled: boolean;
  };
  /**
   * Telegram remote-control channel. Added in config v9. Older files
   * are transparently upgraded with `telegram: { enabled: false,
   * ownerUserId: null }`. The bot token is intentionally not stored
   * here — see `TelegramConfig` for rationale.
   */
  telegram: TelegramConfig;
  /**
   * MCP client servers. Added in config v23. Each entry declares one
   * external MCP server the runtime will connect to at bootstrap and
   * whose tools / resources / prompts will be exposed through the
   * agent's tool registry (namespaced as `mcp.<server>.<tool>`).
   * Older files are transparently upgraded with `mcp: { servers: [] }`.
   */
  mcp: {
    servers: McpServerConfig[];
  };
  /**
   * LLM provider registry (v24). Optional — when absent the runtime
   * synthesizes a single `local-llama` entry from `localModels.*`.
   */
  llm?: import("./llm-config.js").UserLlmFileConfig;
}

// v28: web.search gains `cacheTtlMinutes` (result cache TTL) and `fallback`
// (provider chain). Older files transparently inherit the defaults
// (cacheTtlMinutes: 15, provider: "exa", fallback: ["duckduckgo"] — the keyless
// Exa→DDG degrade path).
// v30: skills gains `taps` (GitHub owner/repo repositories browsed by the
// skill hub). Older files inherit the default tap set.
// v31: skills gains `clawhub` (ClawHub registry — the primary skill
// marketplace). Older files inherit it enabled against the public registry
// with suspicious skills hidden.
// v34: localModels.managed gains `stopOnExit` (stop the managed daemon when
// the last CLI session exits). Older files transparently inherit `true`.
// v35: telegram gains `progressIndicator` (live "Thinking…" bubble toggle).
// Older files transparently inherit `true`.
// v36: new `projects` block. `projects.roots` lists user-declared project
// root directories for `os.fs.locate_project` (issue #77 fuzzy
// project-name resolution). Older files transparently inherit `[]` —
// no directory is ever scanned unless the user declares it.
// v37: `agent.approvalRequired` (binary) became `agent.approvalLevel`
// (five-step ladder, 1 = ask for everything … 5 = approve everything).
// Migration is presence-driven, not version-gated: whenever the new key
// is absent, a legacy `approvalRequired: false` maps to level 5 and
// `true`/absent maps to level 1 — both preserve the old behaviour
// exactly. The legacy key is never written back.
// v39: new `web.fetch` block (`timeoutMs`, `connectTimeoutMs`, `maxRetries`,
// `retryBaseDelayMs`, `retryMaxDelayMs`) making `os.web.fetch` timeouts and
// retry/backoff configurable. Older files transparently inherit the defaults,
// and `timeoutMs` keeps its historical 30_000 value, so the migration does not
// change behaviour for anyone who does not opt in.
// v40: new `tui.mouse` flag gating the mouse layer. Defaults to true, so an
// older file inherits mouse support on upgrade; `--no-mouse` and `/mouse off`
// override it without rewriting the file.
// v41: `localModels.managed.autoUpdate` is wired to managed start
// (TUI auto-start / CLI `models start`) and defaults to `true`. Pre-v41
// files stored an unused `false` default — those migrate to `true` so
// existing installs pick up newer llama.cpp zips. Explicit `false` on
// a v41+ file is honoured.
// v43: new `tui.onboarding` block — four nullable ISO timestamps recording
// that the first-run flow was seen, skipped, completed, and that the
// "configure the other backend too" screen was already offered. Additive:
// an older file parses with all four `null`, which reads as "never
// onboarded" and opens the flow exactly once, instead of re-deriving the
// answer from a health probe on every launch.
// v42: no schema change. The bump exists to carry the forward-compat
// rules below: a file whose `version` is *newer* than this constant is
// now read instead of rejected, its version is preserved rather than
// stamped down, and unknown top-level keys survive the round trip. See
// `parseUserConfigFile` and `ensureUserConfigFileSync`.
// v44: localModels gains `customModels` — GGUF models the operator pointed
// at on Hugging Face, stored as full catalog entries. Older files inherit
// `[]`, which is exactly the behaviour they had before the key existed.
// v45: a fifth stamp in `tui.onboarding` — `localSetupSeenAt`, written
// when the first run reaches the local model list rather than when a
// model comes out of it. It is what stops the "set up local models too"
// screen being pitched to an operator who already walked through that
// list and walked back out. Additive: a v43 file parses with it `null`,
// which reads as "never opened", the same answer that file has always
// implied. (It was drafted as a second v44, but v44 was already spent on
// `customModels` in the same release — the stamp ships as v45 so the two
// additive changes keep distinct numbers.)
export const USER_CONFIG_VERSION = 45;

/**
 * Config v21+ flips the full memory-v2 fabric on by default. Upgrades
 * from versions below v22 force `enabled: true` (and a default embedding
 * model id when unset) so existing installs inherit product defaults;
 * explicit overrides on v22+ files are still honoured.
 */
const MEMORY_V2_OPT_IN_DEFAULTS_VERSION = 22;

/** Pre-v41 `autoUpdate: false` was a dead default; force the live default. */
const MANAGED_AUTO_UPDATE_DEFAULTS_VERSION = 41;

export type RewriterGateMode = "heuristic" | "embedding" | "always";

/**
 * Config versions that `parseUserConfigFile` still accepts on input.
 * v5 renamed the `llama` block to `localModels` to remove the Meta
 * "Llama" conflation — the runtime never ran Llama family models
 * specifically. v6 added the optional `vision.*` block; v7 added
 * `localModels.completionMaxTokens` so users can raise the
 * tool-call `n_predict` cap from the file. v8 added the optional
 * `skills.*` block so installed skills can be turned off without
 * removing files from disk. v9 added the optional `telegram.*`
 * block so the Telegram remote-control channel can be enabled and
 * scoped to a single owner. v10 added `telegram.parseMode` so
 * agent replies render as Telegram HTML by default. v11 added
 * `memory.dedup.*` and `memory.eviction.*` for memory-v2 phase 1A
 * (utility-weighted eviction + FTS5 near-match dedup). v12 added
 * `memory.embeddings.*` and `localModels.embeddings.*` for memory-v2
 * phase 1B (hybrid recall via a second managed `llama-server`
 * dedicated to `/embedding`). v13 added `memory.links.*` for memory-v2
 * phase 2 (link graph + link-generator reflection sub-call). v14 added
 * `memory.evolution.*` for memory-v2 phase 3 (neighbor-evolver +
 * EVOLVE grammar branch + B↔C lease). v15 added `memory.lessons.*` and
 * `memory.consolidation.*` for memory-v2 phase 5 (distilled lessons +
 * cold-path consolidator + first stable-prefix bump for `### lessons`).
 * v16 added `memory.voting.*` for memory-v2 phase 7a (ExpeL-style vote
 * curation — UPVOTE/DOWNVOTE sub-call on the reflection slot + decay
 * on the consolidator tick + utility-eviction + lesson recall reranker).
 * v17 added `memory.procedures.*` for memory-v2 phase 7b (MemP-style
 * advisory procedures distilled alongside lessons + second
 * stable-prefix bump for `### procedures`).
 * v18 added three v2.5 memory fabric additions:
 * `memory.reflection.typedNotes.*` (Phase C — typed-NOTE extraction
 * with per-type forbidden lists),
 * `memory.reflection.segmentation.*` (Phase B — sliding-window
 * reflection segmentation), and `memory.retrieve.rewriter.*` (Phase
 * A — heuristic-gated query rewriter for recall). All three default
 * to disabled so v17 → v18 is a transparent migration.
 * v19 added `memory.reflection.anySpeaker` for multi-party / dialog
 * extraction mode (default `false` — production users keep the
 * user-centric prefix, evaluation benchmarks like LoCoMo flip the
 * flag to true so reflection can extract facts about third-party
 * speakers in the USER channel). Flipping the flag invalidates the
 * reflection slot's KV cache once on the next call.
 * v21 enables memory-v2 advanced layers by default
 * (`memory.evolution`, `memory.lessons`, `memory.procedures`,
 * `memory.consolidation`, `memory.voting`, `memory.retrieve.rewriter`).
 * Upgrades from v20 and below force those `enabled` flags to `true`.
 * v22 also enables `memory.links` by default. Hybrid embedding recall
 * (`memory.embeddings` + `localModels.embeddings`) stays off in the
 * config file until the operator enables it from the TUI Models tab
 * (download + start). Upgrades from v21 and below apply the v22
 * switches for the advanced memory layers only.
 * v23 added the optional `mcp.*` block (MCP client). Upgrades from
 * v22 and below get `mcp: { servers: [] }` — no connections are
 * opened until the operator adds entries to the list.
 * v24 added the optional `llm.*` provider registry block. When
 * absent, the runtime synthesizes `local-llama` from `localModels.*`
 * (byte-stable for existing installs).
 * v25→v26 added `localModels.managed.device` (default `"auto"`) so the
 * managed daemon auto-picks the best GPU at start; older files inherit
 * `"auto"` transparently. v27 added `web.search.*` for the native
 * keyless-first `os.web.search` tool and provider selection.
 * v31→v32 added `localModels.managed.contextSize` (default `0` = auto):
 * the managed chat daemon fits `--ctx-size` to the target device's free
 * VRAM at start; a positive value pins the context explicitly. Older
 * files inherit `0` transparently.
 * v32→v33 added the optional `analytics.*` block (anonymous PostHog
 * product analytics — opt-out via `analytics.enabled: false`). Older
 * files inherit `analytics: { enabled: true }` transparently.
 * v40→v41 wired `localModels.managed.autoUpdate` (default `true`):
 * managed start pulls a newer llama.cpp zip from GitHub Releases when
 * one exists. Pre-v41 the field was stored but never read, so a `false`
 * there carried no meaning and is migrated to `true` — including one a
 * user set deliberately, since the two are indistinguishable on disk.
 * An explicit `false` on a v41+ file is honoured.
 * Older files are transparently upgraded by filling missing
 * blocks/fields from `USER_CONFIG_DEFAULTS`. Anything older than v5
 * is not migrated: this is active development, callers delete their
 * `config.json` and start over.
 */
const SUPPORTED_INPUT_VERSIONS: readonly number[] = [
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  16,
  17,
  18,
  19,
  20,
  21,
  22,
  23,
  24,
  25,
  26,
  27,
  28,
  29,
  30,
  31,
  32,
  33,
  34,
  35,
  36,
  37,
  38,
  39,
  40,
  41,
  42,
  43,
  44,
  USER_CONFIG_VERSION,
];

export const USER_CONFIG_DEFAULTS: UserConfigFile = {
  version: USER_CONFIG_VERSION,
  localModels: {
    url: "http://127.0.0.1:8080",
    mode: "external",
    completionMaxTokens: 8192,
    managed: {
      modelId: null,
      port: 19091,
      dataDirOverride: null,
      autoUpdate: true,
      stopOnExit: true,
      device: "auto",
      contextSize: 0,
    },
    embeddings: {
      enabled: false,
      modelId: null,
      port: 19092,
      url: "http://127.0.0.1:19092",
    },
    customModels: [],
  },
  log: { level: "info" },
  agent: {
    tokenBudget: 3000,
    maxSteps: 25,
    toolTimeoutMs: 60_000,
    approvalLevel: 1,
    conversationMaxTokens: 32_000,
    worldSnapshotMaxTokens: 8_000,
  },
  http: {
    enabled: true,
    approvalMode: "never",
    hostAllowlist: null,
    maxResponseBytes: 1_048_576,
    defaultTimeoutMs: 30_000,
  },
  web: {
    search: {
      enabled: true,
      provider: "exa",
      maxResults: 8,
      timeoutMs: 15_000,
      cacheTtlMinutes: 15,
      fallback: ["duckduckgo"],
      searxng: {
        instanceUrl: null,
      },
      exa: {
        endpoint: "https://mcp.exa.ai/mcp",
        apiEndpoint: "https://api.exa.ai/search",
        apiKeyEnv: "EXA_API_KEY",
      },
      brave: {
        apiKeyEnv: "BRAVE_SEARCH_API_KEY",
      },
    },
    fetch: {
      timeoutMs: 30_000,
      connectTimeoutMs: 10_000,
      maxRetries: 2,
      retryBaseDelayMs: 500,
      retryMaxDelayMs: 5_000,
    },
  },
  projects: {
    roots: [],
  },
  tracing: {
    trace: {
      enabled: null,
      maxBytesPerSession: 10 * 1024 * 1024,
    },
  },
  memory: {
    profile: {
      enabled: true,
      maxTokens: 512,
      contextualKeywordGate: true,
    },
    reflection: {
      enabled: true,
      timeoutMs: 10_000,
      maxFactsPerCall: 3,
      autoStoreNotes: true,
      maxNotesPerCall: 2,
      typedNotes: {
        // v2.5 (v18). Off by default — flipping it
        // on switches the reflection prompt to the typed prefix and
        // invalidates the reflection slot's KV cache once on the
        // next call. The main agent slot is untouched.
        enabled: false,
      },
      // Multi-party reflection mode (v19). Off by default —
      // production personal-assistant users keep the user-centric
      // prefix. Evaluation benchmarks (LoCoMo, LongMemEval) flip
      // this to true so reflection can extract third-party
      // speakers from prefill conversation transcripts.
      anySpeaker: false,
      segmentation: {
        // v2.5 (v18). Off by default — when on,
        // reflection fires every `triggerEveryTurns` turns over the
        // last `windowTurns` exchanges instead of every turn. The
        // final flush on `reason: "finish"` is unconditional.
        enabled: false,
        triggerEveryTurns: 3,
        windowTurns: 5,
      },
    },
    notes: {
      enabled: true,
      maxEntries: 1_000,
      maxContentChars: 4_000,
      recallDefaultK: 5,
    },
    recallInjection: {
      enabled: true,
      k: 3,
      previewChars: 160,
      maxTokens: 400,
    },
    index: {
      enabled: true,
      limit: 20,
      previewChars: 60,
      maxTokens: 300,
    },
    dedup: {
      enabled: true,
      fts5Threshold: 0.85,
    },
    eviction: {
      utilityWeighted: true,
      // 30 days. Declared here for v2 phase 5 (ConsolidatorJob sweep);
      // phase 1A's overflow eviction does not consult `maxAgeMs`.
      maxAgeMs: 2_592_000_000,
    },
    embeddings: {
      enabled: false,
      // Even split between BM25 and cosine — picked as the safe
      // starting point; once we have telemetry from real corpora a
      // follow-up will tune the ratio. The two MUST sum to ~1.0; the
      // bootstrap pins this invariant in phase 1B onwards.
      fts5Weight: 0.5,
      vectorWeight: 0.5,
      bruteForceCeiling: 200,
    },
    links: {
      // Phase 2 — reactive link graph + recall BFS expansion.
      enabled: true,
      autoGenerate: true,
      expansionDepth: 1,
      maxExpanded: 12,
      maxLinksPerCall: 4,
      minCandidates: 2,
      generatorTimeoutMs: 8_000,
    },
    evolution: {
      // Phase 3 — reflection refines tags on existing memories.
      // `content` remains append-only regardless.
      enabled: true,
      maxPerWrite: 2,
      leaseMs: 60_000,
    },
    lessons: {
      // Phase 5 — adds `### lessons` to the prompt tail (stable-prefix
      // change #1) and registers the consolidator timer when
      // `memory.consolidation.enabled` is also true.
      enabled: true,
      recallK: 2,
      maxTokens: 300,
      indexLimit: 20,
      maxEntries: 500,
      deprecationAgeMs: 2_592_000_000,
    },
    procedures: {
      // Phase 7b — adds `### procedures` to the prompt tail (stable-prefix
      // change #2) and switches the consolidator distill grammar
      // to the combined lesson+procedure shape.
      enabled: true,
      recallK: 2,
      maxTokens: 400,
      indexLimit: 20,
      maxEntries: 500,
      deprecationAgeMs: 2_592_000_000,
    },
    consolidation: {
      // Phase 5 — scoped periodic timer carve-out (like Telegram polling).
      enabled: true,
      intervalMs: 21_600_000,
      cooldownMs: 86_400_000,
      minClusterSize: 3,
      maxClustersPerTick: 5,
      requireSharedTag: true,
      distillTimeoutMs: 45_000,
    },
    voting: {
      // Phase 7a — extra LLM sub-call on the reflection slot + cold-path
      // decay on consolidator ticks.
      enabled: true,
      maxVotePerItem: 50,
      signalDecay: 0.95,
      scoreBlend: 0.6,
      eventLogMaxRows: 50_000,
      profileFilterThreshold: 3,
    },
    retrieve: {
      rewriter: {
        // v2.5 (v18) — heuristic-gated query rewriter before recall.
        // Uses `slotId=-1` so the main agent and reflection slots stay
        // untouched.
        enabled: true,
        timeoutMs: 3_000,
        historyTurns: 3,
        gateMode: "heuristic",
        embeddingGate: {
          threshold: 0.65,
          exemplars: null,
        },
      },
    },
  },
  webhooks: {},
  vision: {
    enabled: true,
    autoDetect: true,
    maxImageBytes: 8 * 1024 * 1024,
    maxImagesPerCall: 4,
  },
  skills: {
    disabled: [],
    taps: ["anthropics/skills", "openai/skills", "vercel-labs/agent-skills"],
    clawhub: {
      enabled: true,
      apiBase: "https://clawhub.ai",
      browseLimit: 100,
      nonSuspiciousOnly: true,
    },
  },
  tui: {
    theme: "auto",
    whileBusySubmit: "steer",
    mouse: true,
    onboarding: {
      completedAt: null,
      introSeenAt: null,
      localSetupSeenAt: null,
      proposedSecondBackendAt: null,
      skippedAt: null,
    },
  },
  analytics: {
    enabled: true,
  },
  telegram: {
    enabled: false,
    ownerUserId: null,
    parseMode: "html",
    progressIndicator: true,
  },
  mcp: {
    // Added in v23. Empty by default — the operator declares MCP
    // servers explicitly. The runtime opens no connections when the
    // list is empty.
    servers: [],
  },
};

/** Non-user env-based defaults (not part of the user config file). */
export const ENV_DEFAULTS = {
  STATE_DIR: "~/.atomic-agent",
  HEALTH_TIMEOUT_MS: 3000,
  REQUEST_TIMEOUT_MS: 300_000,
  HEALTH_RETRIES: 5,
  HEALTH_BACKOFF_MS: 500,
  COMPLETION_RETRIES: 3,
  COMPLETION_RETRY_BACKOFF_MS: 150,
  DEFAULT_SLOT_ID: 0,
  STABLE_PREFIX_SALT: "atomic-agent-v1",
  BROWSER_ENABLED: true,
  BROWSER_CHANNEL: "chrome" as BrowserChannel,
  BROWSER_HEADLESS: false,
  BROWSER_NO_SANDBOX: false,
  BROWSER_LAUNCH_TIMEOUT_MS: 30_000,
  SKILLS_CATALOG_BUDGET: 512,
  PROJECT_SKILLS_DIR: ".atomic-agent/skills",
  USER_CONFIG_FILE_NAME: "config.json",
  TASKS_ENABLED: true,
  TASKS_MAX_ATTEMPTS: 3,
  TASKS_BACKOFF_INITIAL_MS: 1_000,
  TASKS_BACKOFF_MAX_MS: 60_000,
  TASKS_RUN_ON_CREATE: true,
  TASKS_STALE_AFTER_MS: 5 * 60 * 1_000,
  TASKS_SCHEDULER_ENABLED: true,
  TASKS_SCHEDULER_TICK_MS: 5_000,
  TASKS_SCHEDULER_BATCH: 10,
  TASKS_AGENT_TOOLS_ENABLED: true,
  TASKS_MIN_INTERVAL_MS: 1_000,
  /** Fire the TUI startup version check against GitHub Releases. */
  UPDATE_CHECK_ON_STARTUP: true,
  /** GitHub `owner/repo` for self-update release lookups + install.sh. */
  UPDATE_REPO: "AtomicBot-ai/atomic-agent",
  /** Max rare-tool schema entries kept in `session.loadedTools` (LRU). */
  LOADED_TOOLS_CAP: 8,
  /** Safety cap (estimated tokens) for the `### loaded-tools` section. */
  LOADED_TOOLS_MAX_TOKENS: 600,
  /** Auto-attach full rare-tool schema after a tool execution error. */
  AUTO_EXPAND_RARE_ON_ERROR: true,
  /** Soft cap on tool calls per inference step. Hard upper bound is 16 (grammar). */
  MAX_PARALLEL_TOOL_CALLS: 8,
  /** Soft cap on combined chars across all tool_result summaries in one batched step. */
  BATCH_TOOL_RESULT_CHAR_CAP: 16_000,
  /** Args-only repeat count that injects a no-progress `### notice`. */
  LOOP_WARNING_THRESHOLD: 3,
  /** Identical args+result streak that vetoes a call before dispatch. */
  LOOP_CRITICAL_THRESHOLD: 5,
  /** Consecutive vetoes of one signature that force a graceful reply. */
  LOOP_BREAKER_VETO_STREAK: 3,
  /** Sliding window size for the loop tracker's history ring. */
  LOOP_HISTORY_SIZE: 30,
  /** Distinct-args spread on a wandering-prone tool that redirects. */
  LOOP_WANDERING_THRESHOLD: 6,
  /** Distinct-args spread that escalates a wandering loop to graceful reply. */
  LOOP_WANDERING_ESCALATION: 12,
};

export { ConfigValidationError } from "./config-validation-error.js";
import { ConfigValidationError } from "./config-validation-error.js";

export function parseLogLevel(raw: unknown, field: string): LogLevel {
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  throw new ConfigValidationError(
    field,
    `expected one of debug|info|warn|error, got ${JSON.stringify(raw)}`,
  );
}

export function parseLocalLlmMode(raw: unknown, field: string): LocalLlmMode {
  if (raw === "external" || raw === "managed") return raw;
  throw new ConfigValidationError(
    field,
    `expected external|managed, got ${JSON.stringify(raw)}`,
  );
}

function parseOptionalManagedModelId(
  raw: unknown,
  field: string,
  customModels: readonly LocalModelDef[],
): string | null {
  if (raw === null || raw === undefined) return null;
  const s = parseNonEmptyString(raw, field);
  // The added models come out of the same file, so they are checked
  // against that array rather than the module registry: a config that
  // adds a model and selects it in one write has to validate before
  // anything has had the chance to publish it.
  if (!isKnownLocalModelId(s) && !customModels.some((m) => m.id === s)) {
    throw new ConfigValidationError(
      field,
      `unknown managed local model id: ${JSON.stringify(s)}`,
    );
  }
  return s;
}

export function parseBrowserChannel(raw: unknown, field: string): BrowserChannel {
  if (raw === "chrome" || raw === "msedge" || raw === "chromium") return raw;
  throw new ConfigValidationError(
    field,
    `expected one of chrome|msedge|chromium, got ${JSON.stringify(raw)}`,
  );
}

export function parseWebSearchProviderName(
  raw: unknown,
  field: string,
): WebSearchProviderName {
  if (raw === "duckduckgo" || raw === "searxng" || raw === "exa" || raw === "brave") {
    return raw;
  }
  throw new ConfigValidationError(
    field,
    `expected one of duckduckgo|searxng|exa|brave, got ${JSON.stringify(raw)}`,
  );
}

/**
 * Parse the opt-in fallback chain: each entry must be a valid provider name,
 * the list is deduped, and the primary provider is dropped (it always runs
 * first). A non-array value is rejected.
 */
export function parseWebSearchFallback(
  raw: unknown,
  primary: WebSearchProviderName,
  field: string,
): WebSearchProviderName[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigValidationError(
      field,
      `expected an array of provider names, got ${JSON.stringify(raw)}`,
    );
  }
  const seen = new Set<WebSearchProviderName>([primary]);
  const out: WebSearchProviderName[] = [];
  for (let i = 0; i < raw.length; i++) {
    const name = parseWebSearchProviderName(raw[i], `${field}[${i}]`);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export function parsePositiveInt(raw: unknown, field: string): number {
  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number.parseInt(raw, 10)
        : NaN;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new ConfigValidationError(
      field,
      `expected positive integer, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

/**
 * Parse a positive integer that must lie inside a closed `[min, max]`
 * range. Used by user-config knobs that have hard physical bounds
 * (e.g. `completionMaxTokens`). Out-of-range values throw — the env
 * counterpart silently clamps because operator-supplied env vars are
 * less strict than file-supplied user config.
 */
export function parseBoundedPositiveInt(
  raw: unknown,
  field: string,
  min: number,
  max: number,
): number {
  const value = parsePositiveInt(raw, field);
  if (value < min || value > max) {
    throw new ConfigValidationError(
      field,
      `expected integer in [${min}, ${max}], got ${value}`,
    );
  }
  return value;
}

/**
 * Parse a non-negative integer (includes `0`). Used for caps that
 * accept `0` as "feature disabled", e.g. `memory.reflection.maxNotesPerCall`.
 */
export function parseNonNegativeInt(raw: unknown, field: string): number {
  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number.parseInt(raw, 10)
        : NaN;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new ConfigValidationError(
      field,
      `expected non-negative integer, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

/**
 * Parse a non-negative integer constrained to `[min, max]`. Unlike
 * {@link parseBoundedPositiveInt}, `min` may be `0` (e.g. a TTL where `0`
 * disables caching).
 */
export function parseNonNegativeBoundedInt(
  raw: unknown,
  field: string,
  min: number,
  max: number,
): number {
  const value = parseNonNegativeInt(raw, field);
  if (value < min || value > max) {
    throw new ConfigValidationError(
      field,
      `expected integer in [${min}, ${max}], got ${value}`,
    );
  }
  return value;
}

/**
 * Parse a number in the unit interval `[0, 1]`. Accepts JSON numbers
 * (canonical) or stringified numbers (env / form-encoded). Used by
 * memory-v2 thresholds (`memory.dedup.fts5Threshold`, future
 * `memory.consolidation.similarityThreshold`, etc.) so similarity
 * configs are bounded by the storage layer rather than each caller
 * re-deriving the clamp.
 */
export function parseUnitInterval(raw: unknown, field: string): number {
  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number.parseFloat(raw)
        : NaN;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new ConfigValidationError(
      field,
      `expected number in [0, 1], got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

/**
 * Parse a number in `(0, 1]` — strict positive lower bound,
 * inclusive at `1`. Used by `memory.voting.signalDecay` where `0`
 * is forbidden (a zero decay zeroes every score on the next tick,
 * which trivially destroys all signal) but `1` is allowed (no
 * decay at all, mostly useful for tests and offline replay).
 */
export function parseHalfOpenUnitInterval(
  raw: unknown,
  field: string,
): number {
  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number.parseFloat(raw)
        : NaN;
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new ConfigValidationError(
      field,
      `expected number in (0, 1], got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}


export function parseBool(raw: unknown, field: string): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const lc = raw.toLowerCase();
    if (["1", "true", "yes", "on"].includes(lc)) return true;
    if (["0", "false", "no", "off"].includes(lc)) return false;
  }
  throw new ConfigValidationError(
    field,
    `expected boolean, got ${JSON.stringify(raw)}`,
  );
}

function parseMemoryV2FeatureEnabled(
  inputVersion: number,
  raw: unknown,
  defaultEnabled: boolean,
  field: string,
): boolean {
  if (inputVersion < MEMORY_V2_OPT_IN_DEFAULTS_VERSION) {
    return true;
  }
  return parseBool(raw ?? defaultEnabled, field);
}

function resolveManagedAutoUpdate(inputVersion: number, raw: unknown): boolean {
  if (inputVersion < MANAGED_AUTO_UPDATE_DEFAULTS_VERSION) {
    return true;
  }
  return parseBool(
    raw ?? USER_CONFIG_DEFAULTS.localModels.managed.autoUpdate,
    "localModels.managed.autoUpdate",
  );
}

function resolveEmbeddingModelId(
  _inputVersion: number,
  raw: unknown,
): string | null {
  if (raw !== null && raw !== undefined) {
    return parseNonEmptyString(raw, "localModels.embeddings.modelId");
  }
  return USER_CONFIG_DEFAULTS.localModels.embeddings.modelId;
}

/**
 * Parse a tri-state toggle: `null` means "defer to the caller". Used by
 * `tracing.trace.enabled` so users can leave the decision to the
 * entry-point default (CLI on, sidecar off) or pin it explicitly.
 */
export function parseBoolOrNull(raw: unknown, field: string): boolean | null {
  if (raw === null || raw === undefined) return null;
  return parseBool(raw, field);
}

export function parseNonEmptyString(raw: unknown, field: string): string {
  if (typeof raw === "string" && raw.length > 0) return raw;
  throw new ConfigValidationError(
    field,
    `expected non-empty string, got ${JSON.stringify(raw)}`,
  );
}

export function parseHttpApprovalMode(
  raw: unknown,
  field: string,
): HttpApprovalMode {
  if (raw === "never" || raw === "writes" || raw === "always") return raw;
  throw new ConfigValidationError(
    field,
    `expected one of never|writes|always, got ${JSON.stringify(raw)}`,
  );
}

/**
 * v25 migration: outbound HTTP POST no longer requires approval by default.
 * The old default `"writes"` (POST asks) is rewritten to `"never"` on any
 * config older than v25, and a missing value adopts the new `"never"` default.
 * Users who explicitly tightened to `"always"` — or already chose `"never"` —
 * are preserved. From v25 onward the on-disk value is respected verbatim.
 */
function resolveHttpApprovalMode(
  inputVersion: number,
  raw: unknown,
  field: string,
): HttpApprovalMode {
  if (inputVersion < 25 && (raw === undefined || raw === null || raw === "writes")) {
    return "never";
  }
  return parseHttpApprovalMode(raw ?? USER_CONFIG_DEFAULTS.http.approvalMode, field);
}

export function parseApprovalLevel(raw: unknown, field: string): ApprovalLevel {
  if (
    typeof raw === "number" &&
    Number.isInteger(raw) &&
    raw >= 1 &&
    raw <= 5
  ) {
    return raw as ApprovalLevel;
  }
  throw new ConfigValidationError(
    field,
    `expected an integer between 1 and 5, got ${JSON.stringify(raw)}`,
  );
}

/**
 * v37 migration: the binary `agent.approvalRequired` became the
 * five-step `agent.approvalLevel`. The new key wins whenever present;
 * otherwise the legacy boolean maps onto the levels that reproduce its
 * behaviour exactly — `false` ("approve everything") becomes level 5,
 * `true` becomes level 1 — and an absent pair falls back to the level-1
 * default. Presence-driven rather than version-gated so hand-written
 * harness configs that still carry only the boolean keep working. The
 * legacy key is validated when present (garbage still fails loudly) and
 * is never written back: `UserConfigFile` no longer has the field.
 */
function resolveApprovalLevel(
  rawLevel: unknown,
  rawLegacyRequired: unknown,
): ApprovalLevel {
  if (rawLevel !== undefined && rawLevel !== null) {
    return parseApprovalLevel(rawLevel, "agent.approvalLevel");
  }
  if (rawLegacyRequired !== undefined && rawLegacyRequired !== null) {
    return parseBool(rawLegacyRequired, "agent.approvalRequired") ? 1 : 5;
  }
  return USER_CONFIG_DEFAULTS.agent.approvalLevel;
}

export function parseRewriterGateMode(
  raw: unknown,
  field: string,
): RewriterGateMode {
  if (raw === "heuristic" || raw === "embedding" || raw === "always") {
    return raw;
  }
  throw new ConfigValidationError(
    field,
    `expected one of heuristic|embedding|always, got ${JSON.stringify(raw)}`,
  );
}

export function parseStringArrayOrNull(
  raw: unknown,
  field: string,
): string[] | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) {
    throw new ConfigValidationError(
      field,
      `expected string[] or null, got ${JSON.stringify(raw)}`,
    );
  }
  const result: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== "string" || entry.length === 0) {
      throw new ConfigValidationError(
        `${field}[${i}]`,
        `expected non-empty string, got ${JSON.stringify(entry)}`,
      );
    }
    result.push(entry);
  }
  return result;
}

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

/**
 * Parse a list of skill names (kebab-case, matches the `name` regex
 * enforced by `skill-manifest.ts`). Empty input is accepted and
 * returned as an empty array. Duplicates are silently deduped to
 * keep the on-disk representation canonical.
 */
export function parseSkillNameArray(raw: unknown, field: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigValidationError(
      field,
      `expected string[], got ${JSON.stringify(raw)}`,
    );
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== "string" || entry.length === 0) {
      throw new ConfigValidationError(
        `${field}[${i}]`,
        `expected non-empty string, got ${JSON.stringify(entry)}`,
      );
    }
    if (!SKILL_NAME_RE.test(entry)) {
      throw new ConfigValidationError(
        `${field}[${i}]`,
        `expected kebab-case skill name, got ${JSON.stringify(entry)}`,
      );
    }
    if (seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

const TAP_REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/**
 * Parse the skill hub `taps` list — GitHub `owner/repo` repository
 * strings. Empty input is accepted. Duplicates are deduped so the
 * on-disk representation stays canonical.
 */
export function parseSkillTapArray(raw: unknown, field: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigValidationError(
      field,
      `expected string[], got ${JSON.stringify(raw)}`,
    );
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== "string" || entry.length === 0) {
      throw new ConfigValidationError(
        `${field}[${i}]`,
        `expected non-empty string, got ${JSON.stringify(entry)}`,
      );
    }
    if (!TAP_REPO_RE.test(entry)) {
      throw new ConfigValidationError(
        `${field}[${i}]`,
        `expected GitHub owner/repo, got ${JSON.stringify(entry)}`,
      );
    }
    if (seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

/**
 * Parse the `skills.clawhub` block (config v31). Missing / partial input
 * is filled from {@link USER_CONFIG_DEFAULTS} so older config files
 * transparently inherit the public-registry defaults.
 */
export function parseClawHubConfig(
  raw: unknown,
): AtomicAgentConfig["skills"]["clawhub"] {
  const defaults = USER_CONFIG_DEFAULTS.skills.clawhub;
  if (raw === undefined || raw === null) return { ...defaults };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(
      "skills.clawhub",
      `expected object, got ${JSON.stringify(raw)}`,
    );
  }
  const obj = raw as Record<string, unknown>;
  return {
    enabled: parseBool(
      obj.enabled ?? defaults.enabled,
      "skills.clawhub.enabled",
    ),
    apiBase: parseUrl(
      obj.apiBase ?? defaults.apiBase,
      "skills.clawhub.apiBase",
    ),
    browseLimit: parsePositiveInt(
      obj.browseLimit ?? defaults.browseLimit,
      "skills.clawhub.browseLimit",
    ),
    nonSuspiciousOnly: parseBool(
      obj.nonSuspiciousOnly ?? defaults.nonSuspiciousOnly,
      "skills.clawhub.nonSuspiciousOnly",
    ),
  };
}

/**
 * Validate and normalise the keyed `webhooks` block. The schedule,
 * when supplied, is left as raw JSON here (cron/interval/at) — it's
 * passed to `TaskRunner.create` at dispatch time where
 * `validateSchedule` runs canonically. This keeps config parsing
 * decoupled from cron-parser, which lives behind `task-schedule.ts`.
 */
export function parseWebhookMap(
  raw: unknown,
  field: string,
): Record<string, WebhookConfig> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(
      field,
      `expected object, got ${JSON.stringify(raw)}`,
    );
  }
  const out: Record<string, WebhookConfig> = {};
  for (const [name, rawCfg] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new ConfigValidationError(
        `${field}.${name}`,
        "webhook name must match [a-zA-Z0-9_-]+",
      );
    }
    if (rawCfg === null || typeof rawCfg !== "object" || Array.isArray(rawCfg)) {
      throw new ConfigValidationError(
        `${field}.${name}`,
        `expected object, got ${JSON.stringify(rawCfg)}`,
      );
    }
    const cfg = rawCfg as Record<string, unknown>;
    const userMessageTemplate = parseNonEmptyString(
      cfg.userMessageTemplate,
      `${field}.${name}.userMessageTemplate`,
    );
    const sessionMode = cfg.sessionMode ?? "ephemeral";
    if (
      sessionMode !== "ephemeral" &&
      sessionMode !== "persistent" &&
      sessionMode !== "named"
    ) {
      throw new ConfigValidationError(
        `${field}.${name}.sessionMode`,
        `expected ephemeral|persistent|named, got ${JSON.stringify(sessionMode)}`,
      );
    }
    let sessionId: string | undefined;
    if (cfg.sessionId !== undefined && cfg.sessionId !== null) {
      sessionId = parseNonEmptyString(cfg.sessionId, `${field}.${name}.sessionId`);
    }
    if (sessionMode === "named" && !sessionId) {
      throw new ConfigValidationError(
        `${field}.${name}.sessionId`,
        "sessionMode=named requires a non-empty sessionId",
      );
    }
    let secret: string | undefined;
    if (cfg.secret !== undefined && cfg.secret !== null) {
      secret = parseNonEmptyString(cfg.secret, `${field}.${name}.secret`);
    }
    let schedule: TaskSchedule | undefined;
    if (cfg.schedule !== undefined && cfg.schedule !== null) {
      schedule = parseWebhookSchedule(cfg.schedule, `${field}.${name}.schedule`);
    }
    out[name] = {
      userMessageTemplate,
      sessionMode,
      ...(sessionId ? { sessionId } : {}),
      ...(secret ? { secret } : {}),
      ...(schedule ? { schedule } : {}),
    };
  }
  return out;
}

function parseWebhookSchedule(raw: unknown, field: string): TaskSchedule {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(field, "expected schedule object");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.kind === "at") {
    const at = obj.at;
    if (typeof at !== "number" || !Number.isFinite(at)) {
      throw new ConfigValidationError(`${field}.at`, "expected finite number (Unix ms)");
    }
    return { kind: "at", at };
  }
  if (obj.kind === "interval") {
    const everyMs = obj.everyMs;
    if (typeof everyMs !== "number" || !Number.isInteger(everyMs) || everyMs <= 0) {
      throw new ConfigValidationError(
        `${field}.everyMs`,
        "expected positive integer",
      );
    }
    return { kind: "interval", everyMs };
  }
  if (obj.kind === "cron") {
    const expression = parseNonEmptyString(obj.expression, `${field}.expression`);
    const tz = typeof obj.tz === "string" ? obj.tz : undefined;
    return { kind: "cron", expression, ...(tz ? { tz } : {}) };
  }
  throw new ConfigValidationError(
    `${field}.kind`,
    `expected at|cron|interval, got ${JSON.stringify(obj.kind)}`,
  );
}

export function parseUrl(raw: unknown, field: string): string {
  const str = parseNonEmptyString(raw, field);
  try {
    new URL(str);
    return str;
  } catch {
    throw new ConfigValidationError(field, `expected valid URL, got ${JSON.stringify(raw)}`);
  }
}

function parseMcpTrustLevel(raw: unknown, field: string): McpTrustLevel {
  if (raw === "approval_gated" || raw === "pure_read") return raw;
  throw new ConfigValidationError(
    field,
    `expected one of approval_gated|pure_read, got ${JSON.stringify(raw)}`,
  );
}

function parseMcpEnv(
  raw: unknown,
  field: string,
): Record<string, string> | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(field, `expected object, got ${JSON.stringify(raw)}`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      throw new ConfigValidationError(
        `${field}.${k}`,
        "env var name must match [A-Za-z_][A-Za-z0-9_]*",
      );
    }
    if (typeof v !== "string") {
      throw new ConfigValidationError(`${field}.${k}`, "env value must be a string");
    }
    out[k] = v;
  }
  return out;
}

// HTTP header field names are RFC 7230 tokens, not env-var names — they
// routinely contain hyphens (`X-CMC-MCP-API-KEY`). Validate against the token
// grammar instead of the `[A-Za-z_][A-Za-z0-9_]*` pattern used for stdio `env`.
const HTTP_HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

function parseMcpHeaders(
  raw: unknown,
  field: string,
): Record<string, string> | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(field, `expected object, got ${JSON.stringify(raw)}`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!HTTP_HEADER_NAME_RE.test(k)) {
      throw new ConfigValidationError(
        `${field}.${k}`,
        "http header name must be a valid RFC 7230 token",
      );
    }
    if (typeof v !== "string") {
      throw new ConfigValidationError(`${field}.${k}`, "http header value must be a string");
    }
    out[k] = v;
  }
  return out;
}

function parseMcpTransport(raw: unknown, field: string): McpTransport {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(field, "expected transport object");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.kind === "stdio") {
    const command = parseNonEmptyString(obj.command, `${field}.command`);
    const args = obj.args === undefined ? undefined : parseStringArrayOrNull(obj.args, `${field}.args`);
    const cwd =
      obj.cwd === undefined || obj.cwd === null
        ? undefined
        : parseNonEmptyString(obj.cwd, `${field}.cwd`);
    return {
      kind: "stdio",
      command,
      ...(args ? { args } : {}),
      ...(cwd ? { cwd } : {}),
    };
  }
  if (obj.kind === "streamable_http") {
    const url = parseUrl(obj.url, `${field}.url`);
    const headers =
      obj.headers === undefined || obj.headers === null
        ? undefined
        : parseMcpHeaders(obj.headers, `${field}.headers`);
    return {
      kind: "streamable_http",
      url,
      ...(headers ? { headers } : {}),
    };
  }
  if (obj.kind === "sse") {
    const url = parseUrl(obj.url, `${field}.url`);
    const headers =
      obj.headers === undefined || obj.headers === null
        ? undefined
        : parseMcpHeaders(obj.headers, `${field}.headers`);
    return {
      kind: "sse",
      url,
      ...(headers ? { headers } : {}),
    };
  }
  throw new ConfigValidationError(
    `${field}.kind`,
    `expected stdio|streamable_http|sse, got ${JSON.stringify(obj.kind)}`,
  );
}

/**
 * Validate and normalise the `mcp.servers[]` list. Each entry is
 * checked for a valid namespace name, an enabled flag, and a
 * well-formed transport. Duplicate names are rejected — the
 * namespace becomes the `mcp.<name>.<tool>` prefix and must be
 * unique. Empty input is accepted.
 */
export function parseMcpServers(
  raw: unknown,
  field: string,
): McpServerConfig[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigValidationError(field, `expected array, got ${JSON.stringify(raw)}`);
  }
  const out: McpServerConfig[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ConfigValidationError(
        `${field}[${i}]`,
        `expected object, got ${JSON.stringify(entry)}`,
      );
    }
    const cfg = entry as Record<string, unknown>;
    const name = parseNonEmptyString(cfg.name, `${field}[${i}].name`);
    if (name.length > MCP_SERVER_NAME_MAX_LENGTH) {
      throw new ConfigValidationError(
        `${field}[${i}].name`,
        `name exceeds ${MCP_SERVER_NAME_MAX_LENGTH} chars`,
      );
    }
    if (!MCP_SERVER_NAME_RE.test(name)) {
      throw new ConfigValidationError(
        `${field}[${i}].name`,
        `name must match ${MCP_SERVER_NAME_RE.source}`,
      );
    }
    if (seen.has(name)) {
      throw new ConfigValidationError(
        `${field}[${i}].name`,
        `duplicate server name ${JSON.stringify(name)}`,
      );
    }
    seen.add(name);
    const enabled = parseBool(
      cfg.enabled === undefined ? true : cfg.enabled,
      `${field}[${i}].enabled`,
    );
    const description =
      cfg.description === undefined || cfg.description === null
        ? undefined
        : parseNonEmptyString(cfg.description, `${field}[${i}].description`);
    const transport = parseMcpTransport(cfg.transport, `${field}[${i}].transport`);
    const trust =
      cfg.trust === undefined || cfg.trust === null
        ? undefined
        : parseMcpTrustLevel(cfg.trust, `${field}[${i}].trust`);
    const env =
      cfg.env === undefined || cfg.env === null
        ? undefined
        : parseMcpEnv(cfg.env, `${field}[${i}].env`);
    out.push({
      name,
      enabled,
      transport,
      ...(description ? { description } : {}),
      ...(trust ? { trust } : {}),
      ...(env ? { env } : {}),
    });
  }
  return out;
}

/**
 * Every top-level key this build knows about. Derived from the defaults
 * so it cannot drift when a block is added, plus `llm`, which the parse
 * emits conditionally rather than defaulting.
 */
const KNOWN_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(USER_CONFIG_DEFAULTS),
  // Emitted conditionally rather than defaulted.
  "llm",
  // Read as the legacy alias of `tracing` and intentionally not emitted;
  // treating it as unknown would carry a retired block forward for ever.
  "telemetry",
]);

/**
 * The keys of `obj` this build does not recognise — in practice, a block
 * written by a newer schema. `parseUserConfigFile` rebuilds its result as
 * a fixed literal, so without carrying these through explicitly the first
 * write from an older build would delete them. `__proto__` is dropped
 * rather than carried: `JSON.parse` can produce it as an own key and it
 * has no business in a config file.
 */
function unknownTopLevelKeys(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  // Null prototype so `extras[key] = value` is always a plain data write.
  // On a normal object, `extras["__proto__"] = …` hits the inherited setter
  // and silently reparents `extras` instead of storing anything.
  const extras = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    // With the null prototype above this would otherwise become a real own
    // key, get spread into the result, and be written back out to disk.
    if (key === "__proto__") continue;
    if (KNOWN_TOP_LEVEL_KEYS.has(key)) continue;
    extras[key] = value;
  }
  return extras;
}

/**
 * Validate and normalise a raw JSON payload into a `UserConfigFile`.
 * Missing sub-keys are filled with defaults — this lets us add new
 * fields without breaking existing installations. Unknown top-level
 * keys are carried through verbatim (forward compat); unknown keys
 * *inside* a known block are still dropped.
 */
export function parseUserConfigFile(raw: unknown): UserConfigFile {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError("<root>", "expected JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const version = obj.version ?? USER_CONFIG_VERSION;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
    throw new ConfigValidationError(
      "version",
      `unsupported config version ${JSON.stringify(version)}; expected a positive whole number`,
    );
  }
  // A version we have never heard of is only fatal when it is OLDER than
  // the oldest we can migrate. A NEWER one is read with this build's
  // schema instead of throwing: every version-gated rule below is a `<`
  // comparison, so a higher number makes all of them fall through to
  // "take the file at its word", which is the correct reading of a file
  // written by a build that knew more than we do. Rejecting it instead
  // bricks every command in the CLI — `getConfig()` runs before all of
  // them — and turns any rollback to an older build into a dead install.
  // The newer number is preserved in the result (and unknown top-level
  // keys with it) so writing the file back cannot downgrade it.
  if (!SUPPORTED_INPUT_VERSIONS.includes(version) && version < USER_CONFIG_VERSION) {
    throw new ConfigValidationError(
      "version",
      `unsupported config version ${JSON.stringify(version)}; expected one of ${SUPPORTED_INPUT_VERSIONS.join(", ")}`,
    );
  }

  const localModels =
    (obj.localModels as Record<string, unknown> | undefined) ?? {};
  const log = (obj.log as Record<string, unknown> | undefined) ?? {};
  const agent = (obj.agent as Record<string, unknown> | undefined) ?? {};
  const http = (obj.http as Record<string, unknown> | undefined) ?? {};
  const web = (obj.web as Record<string, unknown> | undefined) ?? {};
  const projects = (obj.projects as Record<string, unknown> | undefined) ?? {};
  const webSearch = (web.search as Record<string, unknown> | undefined) ?? {};
  const webFetch = (web.fetch as Record<string, unknown> | undefined) ?? {};
  const webSearchProvider = parseWebSearchProviderName(
    webSearch.provider ?? USER_CONFIG_DEFAULTS.web.search.provider,
    "web.search.provider",
  );
  const webSearchSearxng =
    (webSearch.searxng as Record<string, unknown> | undefined) ?? {};
  const webSearchExa =
    (webSearch.exa as Record<string, unknown> | undefined) ?? {};
  const webSearchBrave =
    (webSearch.brave as Record<string, unknown> | undefined) ?? {};
  const legacyTelemetry =
    (obj.telemetry as Record<string, unknown> | undefined) ?? {};
  const tracing = (obj.tracing as Record<string, unknown> | undefined) ?? {};
  const traceFromLegacy =
    (legacyTelemetry.trace as Record<string, unknown> | undefined) ?? {};
  const traceFromTracing =
    (tracing.trace as Record<string, unknown> | undefined) ?? {};
  const mergedTrace: Record<string, unknown> = {
    ...traceFromLegacy,
    ...traceFromTracing,
  };
  const memory = (obj.memory as Record<string, unknown> | undefined) ?? {};
  const memoryProfile =
    (memory.profile as Record<string, unknown> | undefined) ?? {};
  const memoryReflection =
    (memory.reflection as Record<string, unknown> | undefined) ?? {};
  const memoryNotes =
    (memory.notes as Record<string, unknown> | undefined) ?? {};
  const memoryRecallInjection =
    (memory.recallInjection as Record<string, unknown> | undefined) ?? {};
  const memoryIndex =
    (memory.index as Record<string, unknown> | undefined) ?? {};
  const memoryDedup =
    (memory.dedup as Record<string, unknown> | undefined) ?? {};
  const memoryEviction =
    (memory.eviction as Record<string, unknown> | undefined) ?? {};
  const memoryEmbeddings =
    (memory.embeddings as Record<string, unknown> | undefined) ?? {};
  const memoryLinks =
    (memory.links as Record<string, unknown> | undefined) ?? {};
  const memoryEvolution =
    (memory.evolution as Record<string, unknown> | undefined) ?? {};
  const memoryLessons =
    (memory.lessons as Record<string, unknown> | undefined) ?? {};
  const memoryProcedures =
    (memory.procedures as Record<string, unknown> | undefined) ?? {};
  const memoryConsolidation =
    (memory.consolidation as Record<string, unknown> | undefined) ?? {};
  const memoryVoting =
    (memory.voting as Record<string, unknown> | undefined) ?? {};
  const memoryReflectionTypedNotes =
    (memoryReflection.typedNotes as Record<string, unknown> | undefined) ?? {};
  const memoryReflectionSegmentation =
    (memoryReflection.segmentation as Record<string, unknown> | undefined) ?? {};
  const memoryRetrieve =
    (memory.retrieve as Record<string, unknown> | undefined) ?? {};
  const memoryRetrieveRewriter =
    (memoryRetrieve.rewriter as Record<string, unknown> | undefined) ?? {};
  const memoryRetrieveRewriterEmbeddingGate =
    (memoryRetrieveRewriter.embeddingGate as
      | Record<string, unknown>
      | undefined) ?? {};
  const webhooks = parseWebhookMap(obj.webhooks ?? {}, "webhooks");
  const vision = (obj.vision as Record<string, unknown> | undefined) ?? {};
  const skills = (obj.skills as Record<string, unknown> | undefined) ?? {};
  const telegram = (obj.telegram as Record<string, unknown> | undefined) ?? {};
  const tui = (obj.tui as Record<string, unknown> | undefined) ?? {};
  const analytics =
    (obj.analytics as Record<string, unknown> | undefined) ?? {};
  const mcp = (obj.mcp as Record<string, unknown> | undefined) ?? {};

  // Parsed before `managed.modelId` so a file that adds a model and
  // activates it in one write validates.
  const customModels = parseCustomLocalModels(
    localModels.customModels,
    "localModels.customModels",
  );

  const rawManaged =
    (localModels.managed as Record<string, unknown> | undefined) ?? {};
  const managed: UserManagedLocalLlmConfig = {
    modelId: parseOptionalManagedModelId(
      rawManaged.modelId,
      "localModels.managed.modelId",
      customModels,
    ),
    port: parsePositiveInt(
      rawManaged.port ?? USER_CONFIG_DEFAULTS.localModels.managed.port,
      "localModels.managed.port",
    ),
    dataDirOverride:
      rawManaged.dataDirOverride === null || rawManaged.dataDirOverride === undefined
        ? null
        : parseNonEmptyString(
            rawManaged.dataDirOverride,
            "localModels.managed.dataDirOverride",
          ),
    autoUpdate: resolveManagedAutoUpdate(version, rawManaged.autoUpdate),
    stopOnExit: parseBool(
      rawManaged.stopOnExit ??
        USER_CONFIG_DEFAULTS.localModels.managed.stopOnExit,
      "localModels.managed.stopOnExit",
    ),
    device: parseNonEmptyString(
      rawManaged.device ?? USER_CONFIG_DEFAULTS.localModels.managed.device,
      "localModels.managed.device",
    ),
    contextSize: parseNonNegativeInt(
      rawManaged.contextSize ??
        USER_CONFIG_DEFAULTS.localModels.managed.contextSize,
      "localModels.managed.contextSize",
    ),
  };

  const rawEmbeddings =
    (localModels.embeddings as Record<string, unknown> | undefined) ?? {};
  const embeddingsPort = parsePositiveInt(
    rawEmbeddings.port ?? USER_CONFIG_DEFAULTS.localModels.embeddings.port,
    "localModels.embeddings.port",
  );
  const embeddingsDaemon: UserManagedEmbeddingLlmConfig = {
    enabled: parseBool(
      rawEmbeddings.enabled ??
        USER_CONFIG_DEFAULTS.localModels.embeddings.enabled,
      "localModels.embeddings.enabled",
    ),
    modelId: resolveEmbeddingModelId(version, rawEmbeddings.modelId),
    port: embeddingsPort,
    url: parseUrl(
      rawEmbeddings.url ?? `http://127.0.0.1:${embeddingsPort}`,
      "localModels.embeddings.url",
    ),
  };

  const localModelsMode = parseLocalLlmMode(
    localModels.mode ?? USER_CONFIG_DEFAULTS.localModels.mode,
    "localModels.mode",
  );
  const localModelsUrl = parseUrl(
    localModels.url ?? USER_CONFIG_DEFAULTS.localModels.url,
    "localModels.url",
  );
  const llmBlock: UserLlmFileConfig | undefined =
    obj.llm === undefined || obj.llm === null
      ? undefined
      : parseUserLlmFileConfig(obj.llm, {
          activeTextProvider: "local-llama",
          activeEmbeddingProvider: "local-llama",
          toolTransport: "auto",
          providers: [
            {
              id: "local-llama",
              kind: "llama-server",
              url:
                localModelsMode === "managed"
                  ? `http://127.0.0.1:${managed.port}`
                  : localModelsUrl,
              baseUrl: embeddingsDaemon.url,
            },
          ],
        });

  return {
    // Spread first so a known key can never be shadowed by a stray one.
    ...unknownTopLevelKeys(obj),
    // A file from a newer build keeps its own version. Stamping ours here
    // is what turns "read a newer file" into "silently downgrade it".
    version: Math.max(version, USER_CONFIG_VERSION),
    localModels: {
      url: localModelsUrl,
      mode: localModelsMode,
      completionMaxTokens: parseBoundedPositiveInt(
        localModels.completionMaxTokens ??
          USER_CONFIG_DEFAULTS.localModels.completionMaxTokens,
        "localModels.completionMaxTokens",
        64,
        131_072,
      ),
      managed,
      embeddings: embeddingsDaemon,
      customModels,
    },
    log: {
      level: parseLogLevel(log.level ?? USER_CONFIG_DEFAULTS.log.level, "log.level"),
    },
    agent: {
      tokenBudget: parsePositiveInt(
        agent.tokenBudget ?? USER_CONFIG_DEFAULTS.agent.tokenBudget,
        "agent.tokenBudget",
      ),
      maxSteps: parsePositiveInt(
        agent.maxSteps ?? USER_CONFIG_DEFAULTS.agent.maxSteps,
        "agent.maxSteps",
      ),
      toolTimeoutMs: parsePositiveInt(
        agent.toolTimeoutMs ?? USER_CONFIG_DEFAULTS.agent.toolTimeoutMs,
        "agent.toolTimeoutMs",
      ),
      approvalLevel: resolveApprovalLevel(
        agent.approvalLevel,
        agent.approvalRequired,
      ),
      conversationMaxTokens: parsePositiveInt(
        agent.conversationMaxTokens ??
          USER_CONFIG_DEFAULTS.agent.conversationMaxTokens,
        "agent.conversationMaxTokens",
      ),
      worldSnapshotMaxTokens: parsePositiveInt(
        agent.worldSnapshotMaxTokens ??
          USER_CONFIG_DEFAULTS.agent.worldSnapshotMaxTokens,
        "agent.worldSnapshotMaxTokens",
      ),
    },
    http: {
      enabled: parseBool(
        http.enabled ?? USER_CONFIG_DEFAULTS.http.enabled,
        "http.enabled",
      ),
      approvalMode: resolveHttpApprovalMode(
        version,
        http.approvalMode,
        "http.approvalMode",
      ),
      hostAllowlist: parseStringArrayOrNull(
        http.hostAllowlist ?? USER_CONFIG_DEFAULTS.http.hostAllowlist,
        "http.hostAllowlist",
      ),
      maxResponseBytes: parsePositiveInt(
        http.maxResponseBytes ?? USER_CONFIG_DEFAULTS.http.maxResponseBytes,
        "http.maxResponseBytes",
      ),
      defaultTimeoutMs: parsePositiveInt(
        http.defaultTimeoutMs ?? USER_CONFIG_DEFAULTS.http.defaultTimeoutMs,
        "http.defaultTimeoutMs",
      ),
    },
    web: {
      search: {
        enabled: parseBool(
          webSearch.enabled ?? USER_CONFIG_DEFAULTS.web.search.enabled,
          "web.search.enabled",
        ),
        provider: webSearchProvider,
        maxResults: parseBoundedPositiveInt(
          webSearch.maxResults ?? USER_CONFIG_DEFAULTS.web.search.maxResults,
          "web.search.maxResults",
          1,
          20,
        ),
        timeoutMs: parsePositiveInt(
          webSearch.timeoutMs ?? USER_CONFIG_DEFAULTS.web.search.timeoutMs,
          "web.search.timeoutMs",
        ),
        cacheTtlMinutes: parseNonNegativeBoundedInt(
          webSearch.cacheTtlMinutes ??
            USER_CONFIG_DEFAULTS.web.search.cacheTtlMinutes,
          "web.search.cacheTtlMinutes",
          0,
          1440,
        ),
        fallback: parseWebSearchFallback(
          webSearch.fallback ?? USER_CONFIG_DEFAULTS.web.search.fallback,
          webSearchProvider,
          "web.search.fallback",
        ),
        searxng: {
          instanceUrl:
            webSearchSearxng.instanceUrl === null ||
            webSearchSearxng.instanceUrl === undefined
              ? null
              : parseNonEmptyString(
                  webSearchSearxng.instanceUrl,
                  "web.search.searxng.instanceUrl",
                ),
        },
        exa: {
          endpoint: parseNonEmptyString(
            webSearchExa.endpoint ?? USER_CONFIG_DEFAULTS.web.search.exa.endpoint,
            "web.search.exa.endpoint",
          ),
          apiEndpoint: parseNonEmptyString(
            webSearchExa.apiEndpoint ??
              USER_CONFIG_DEFAULTS.web.search.exa.apiEndpoint,
            "web.search.exa.apiEndpoint",
          ),
          apiKeyEnv: parseNonEmptyString(
            webSearchExa.apiKeyEnv ?? USER_CONFIG_DEFAULTS.web.search.exa.apiKeyEnv,
            "web.search.exa.apiKeyEnv",
          ),
        },
        brave: {
          apiKeyEnv: parseNonEmptyString(
            webSearchBrave.apiKeyEnv ??
              USER_CONFIG_DEFAULTS.web.search.brave.apiKeyEnv,
            "web.search.brave.apiKeyEnv",
          ),
        },
      },
      fetch: {
        timeoutMs: parsePositiveInt(
          webFetch.timeoutMs ?? USER_CONFIG_DEFAULTS.web.fetch.timeoutMs,
          "web.fetch.timeoutMs",
        ),
        connectTimeoutMs: parsePositiveInt(
          webFetch.connectTimeoutMs ??
            USER_CONFIG_DEFAULTS.web.fetch.connectTimeoutMs,
          "web.fetch.connectTimeoutMs",
        ),
        maxRetries: parseNonNegativeBoundedInt(
          webFetch.maxRetries ?? USER_CONFIG_DEFAULTS.web.fetch.maxRetries,
          "web.fetch.maxRetries",
          0,
          5,
        ),
        retryBaseDelayMs: parsePositiveInt(
          webFetch.retryBaseDelayMs ??
            USER_CONFIG_DEFAULTS.web.fetch.retryBaseDelayMs,
          "web.fetch.retryBaseDelayMs",
        ),
        retryMaxDelayMs: parsePositiveInt(
          webFetch.retryMaxDelayMs ??
            USER_CONFIG_DEFAULTS.web.fetch.retryMaxDelayMs,
          "web.fetch.retryMaxDelayMs",
        ),
      },
    },
    projects: {
      roots:
        parseStringArrayOrNull(
          projects.roots ?? USER_CONFIG_DEFAULTS.projects.roots,
          "projects.roots",
        ) ?? [],
    },
    tracing: {
      trace: {
        enabled: parseBoolOrNull(
          mergedTrace.enabled ?? USER_CONFIG_DEFAULTS.tracing.trace.enabled,
          "tracing.trace.enabled",
        ),
        maxBytesPerSession: parsePositiveInt(
          mergedTrace.maxBytesPerSession ??
            USER_CONFIG_DEFAULTS.tracing.trace.maxBytesPerSession,
          "tracing.trace.maxBytesPerSession",
        ),
      },
    },
    memory: {
      profile: {
        enabled: parseBool(
          memoryProfile.enabled ?? USER_CONFIG_DEFAULTS.memory.profile.enabled,
          "memory.profile.enabled",
        ),
        maxTokens: parsePositiveInt(
          memoryProfile.maxTokens ??
            USER_CONFIG_DEFAULTS.memory.profile.maxTokens,
          "memory.profile.maxTokens",
        ),
        contextualKeywordGate: parseBool(
          memoryProfile.contextualKeywordGate ??
            USER_CONFIG_DEFAULTS.memory.profile.contextualKeywordGate,
          "memory.profile.contextualKeywordGate",
        ),
      },
      reflection: {
        enabled: parseBool(
          memoryReflection.enabled ??
            USER_CONFIG_DEFAULTS.memory.reflection.enabled,
          "memory.reflection.enabled",
        ),
        timeoutMs: parsePositiveInt(
          memoryReflection.timeoutMs ??
            USER_CONFIG_DEFAULTS.memory.reflection.timeoutMs,
          "memory.reflection.timeoutMs",
        ),
        maxFactsPerCall: parsePositiveInt(
          memoryReflection.maxFactsPerCall ??
            USER_CONFIG_DEFAULTS.memory.reflection.maxFactsPerCall,
          "memory.reflection.maxFactsPerCall",
        ),
        autoStoreNotes: parseBool(
          memoryReflection.autoStoreNotes ??
            USER_CONFIG_DEFAULTS.memory.reflection.autoStoreNotes,
          "memory.reflection.autoStoreNotes",
        ),
        maxNotesPerCall: parseNonNegativeInt(
          memoryReflection.maxNotesPerCall ??
            USER_CONFIG_DEFAULTS.memory.reflection.maxNotesPerCall,
          "memory.reflection.maxNotesPerCall",
        ),
        typedNotes: {
          enabled: parseBool(
            memoryReflectionTypedNotes.enabled ??
              USER_CONFIG_DEFAULTS.memory.reflection.typedNotes.enabled,
            "memory.reflection.typedNotes.enabled",
          ),
        },
        anySpeaker: parseBool(
          memoryReflection.anySpeaker ??
            USER_CONFIG_DEFAULTS.memory.reflection.anySpeaker,
          "memory.reflection.anySpeaker",
        ),
        segmentation: {
          enabled: parseBool(
            memoryReflectionSegmentation.enabled ??
              USER_CONFIG_DEFAULTS.memory.reflection.segmentation.enabled,
            "memory.reflection.segmentation.enabled",
          ),
          triggerEveryTurns: parsePositiveInt(
            memoryReflectionSegmentation.triggerEveryTurns ??
              USER_CONFIG_DEFAULTS.memory.reflection.segmentation
                .triggerEveryTurns,
            "memory.reflection.segmentation.triggerEveryTurns",
          ),
          windowTurns: parsePositiveInt(
            memoryReflectionSegmentation.windowTurns ??
              USER_CONFIG_DEFAULTS.memory.reflection.segmentation.windowTurns,
            "memory.reflection.segmentation.windowTurns",
          ),
        },
      },
      notes: {
        enabled: parseBool(
          memoryNotes.enabled ?? USER_CONFIG_DEFAULTS.memory.notes.enabled,
          "memory.notes.enabled",
        ),
        maxEntries: parsePositiveInt(
          memoryNotes.maxEntries ??
            USER_CONFIG_DEFAULTS.memory.notes.maxEntries,
          "memory.notes.maxEntries",
        ),
        maxContentChars: parsePositiveInt(
          memoryNotes.maxContentChars ??
            USER_CONFIG_DEFAULTS.memory.notes.maxContentChars,
          "memory.notes.maxContentChars",
        ),
        recallDefaultK: parsePositiveInt(
          memoryNotes.recallDefaultK ??
            USER_CONFIG_DEFAULTS.memory.notes.recallDefaultK,
          "memory.notes.recallDefaultK",
        ),
      },
      recallInjection: {
        enabled: parseBool(
          memoryRecallInjection.enabled ??
            USER_CONFIG_DEFAULTS.memory.recallInjection.enabled,
          "memory.recallInjection.enabled",
        ),
        k: parseNonNegativeInt(
          memoryRecallInjection.k ??
            USER_CONFIG_DEFAULTS.memory.recallInjection.k,
          "memory.recallInjection.k",
        ),
        previewChars: parsePositiveInt(
          memoryRecallInjection.previewChars ??
            USER_CONFIG_DEFAULTS.memory.recallInjection.previewChars,
          "memory.recallInjection.previewChars",
        ),
        maxTokens: parsePositiveInt(
          memoryRecallInjection.maxTokens ??
            USER_CONFIG_DEFAULTS.memory.recallInjection.maxTokens,
          "memory.recallInjection.maxTokens",
        ),
      },
      index: {
        enabled: parseBool(
          memoryIndex.enabled ?? USER_CONFIG_DEFAULTS.memory.index.enabled,
          "memory.index.enabled",
        ),
        limit: parseNonNegativeInt(
          memoryIndex.limit ?? USER_CONFIG_DEFAULTS.memory.index.limit,
          "memory.index.limit",
        ),
        previewChars: parsePositiveInt(
          memoryIndex.previewChars ??
            USER_CONFIG_DEFAULTS.memory.index.previewChars,
          "memory.index.previewChars",
        ),
        maxTokens: parsePositiveInt(
          memoryIndex.maxTokens ?? USER_CONFIG_DEFAULTS.memory.index.maxTokens,
          "memory.index.maxTokens",
        ),
      },
      dedup: {
        enabled: parseBool(
          memoryDedup.enabled ?? USER_CONFIG_DEFAULTS.memory.dedup.enabled,
          "memory.dedup.enabled",
        ),
        fts5Threshold: parseUnitInterval(
          memoryDedup.fts5Threshold ??
            USER_CONFIG_DEFAULTS.memory.dedup.fts5Threshold,
          "memory.dedup.fts5Threshold",
        ),
      },
      eviction: {
        utilityWeighted: parseBool(
          memoryEviction.utilityWeighted ??
            USER_CONFIG_DEFAULTS.memory.eviction.utilityWeighted,
          "memory.eviction.utilityWeighted",
        ),
        maxAgeMs: parsePositiveInt(
          memoryEviction.maxAgeMs ??
            USER_CONFIG_DEFAULTS.memory.eviction.maxAgeMs,
          "memory.eviction.maxAgeMs",
        ),
      },
      embeddings: {
        enabled: parseBool(
          memoryEmbeddings.enabled ??
            USER_CONFIG_DEFAULTS.memory.embeddings.enabled,
          "memory.embeddings.enabled",
        ),
        fts5Weight: parseUnitInterval(
          memoryEmbeddings.fts5Weight ??
            USER_CONFIG_DEFAULTS.memory.embeddings.fts5Weight,
          "memory.embeddings.fts5Weight",
        ),
        vectorWeight: parseUnitInterval(
          memoryEmbeddings.vectorWeight ??
            USER_CONFIG_DEFAULTS.memory.embeddings.vectorWeight,
          "memory.embeddings.vectorWeight",
        ),
        bruteForceCeiling: parsePositiveInt(
          memoryEmbeddings.bruteForceCeiling ??
            USER_CONFIG_DEFAULTS.memory.embeddings.bruteForceCeiling,
          "memory.embeddings.bruteForceCeiling",
        ),
      },
      links: {
        enabled: parseMemoryV2FeatureEnabled(
          version,
          memoryLinks.enabled,
          USER_CONFIG_DEFAULTS.memory.links.enabled,
          "memory.links.enabled",
        ),
        autoGenerate: parseBool(
          memoryLinks.autoGenerate ??
            USER_CONFIG_DEFAULTS.memory.links.autoGenerate,
          "memory.links.autoGenerate",
        ),
        expansionDepth: parsePositiveInt(
          memoryLinks.expansionDepth ??
            USER_CONFIG_DEFAULTS.memory.links.expansionDepth,
          "memory.links.expansionDepth",
        ),
        maxExpanded: parsePositiveInt(
          memoryLinks.maxExpanded ??
            USER_CONFIG_DEFAULTS.memory.links.maxExpanded,
          "memory.links.maxExpanded",
        ),
        maxLinksPerCall: parsePositiveInt(
          memoryLinks.maxLinksPerCall ??
            USER_CONFIG_DEFAULTS.memory.links.maxLinksPerCall,
          "memory.links.maxLinksPerCall",
        ),
        minCandidates: parsePositiveInt(
          memoryLinks.minCandidates ??
            USER_CONFIG_DEFAULTS.memory.links.minCandidates,
          "memory.links.minCandidates",
        ),
        generatorTimeoutMs: parsePositiveInt(
          memoryLinks.generatorTimeoutMs ??
            USER_CONFIG_DEFAULTS.memory.links.generatorTimeoutMs,
          "memory.links.generatorTimeoutMs",
        ),
      },
      evolution: {
        enabled: parseMemoryV2FeatureEnabled(
          version,
          memoryEvolution.enabled,
          USER_CONFIG_DEFAULTS.memory.evolution.enabled,
          "memory.evolution.enabled",
        ),
        maxPerWrite: parsePositiveInt(
          memoryEvolution.maxPerWrite ??
            USER_CONFIG_DEFAULTS.memory.evolution.maxPerWrite,
          "memory.evolution.maxPerWrite",
        ),
        leaseMs: parsePositiveInt(
          memoryEvolution.leaseMs ??
            USER_CONFIG_DEFAULTS.memory.evolution.leaseMs,
          "memory.evolution.leaseMs",
        ),
      },
      lessons: {
        enabled: parseMemoryV2FeatureEnabled(
          version,
          memoryLessons.enabled,
          USER_CONFIG_DEFAULTS.memory.lessons.enabled,
          "memory.lessons.enabled",
        ),
        recallK: parsePositiveInt(
          memoryLessons.recallK ?? USER_CONFIG_DEFAULTS.memory.lessons.recallK,
          "memory.lessons.recallK",
        ),
        maxTokens: parsePositiveInt(
          memoryLessons.maxTokens ??
            USER_CONFIG_DEFAULTS.memory.lessons.maxTokens,
          "memory.lessons.maxTokens",
        ),
        indexLimit: parsePositiveInt(
          memoryLessons.indexLimit ??
            USER_CONFIG_DEFAULTS.memory.lessons.indexLimit,
          "memory.lessons.indexLimit",
        ),
        maxEntries: parsePositiveInt(
          memoryLessons.maxEntries ??
            USER_CONFIG_DEFAULTS.memory.lessons.maxEntries,
          "memory.lessons.maxEntries",
        ),
        deprecationAgeMs: parsePositiveInt(
          memoryLessons.deprecationAgeMs ??
            USER_CONFIG_DEFAULTS.memory.lessons.deprecationAgeMs,
          "memory.lessons.deprecationAgeMs",
        ),
      },
      procedures: {
        enabled: parseMemoryV2FeatureEnabled(
          version,
          memoryProcedures.enabled,
          USER_CONFIG_DEFAULTS.memory.procedures.enabled,
          "memory.procedures.enabled",
        ),
        recallK: parsePositiveInt(
          memoryProcedures.recallK ??
            USER_CONFIG_DEFAULTS.memory.procedures.recallK,
          "memory.procedures.recallK",
        ),
        maxTokens: parsePositiveInt(
          memoryProcedures.maxTokens ??
            USER_CONFIG_DEFAULTS.memory.procedures.maxTokens,
          "memory.procedures.maxTokens",
        ),
        indexLimit: parsePositiveInt(
          memoryProcedures.indexLimit ??
            USER_CONFIG_DEFAULTS.memory.procedures.indexLimit,
          "memory.procedures.indexLimit",
        ),
        maxEntries: parsePositiveInt(
          memoryProcedures.maxEntries ??
            USER_CONFIG_DEFAULTS.memory.procedures.maxEntries,
          "memory.procedures.maxEntries",
        ),
        deprecationAgeMs: parsePositiveInt(
          memoryProcedures.deprecationAgeMs ??
            USER_CONFIG_DEFAULTS.memory.procedures.deprecationAgeMs,
          "memory.procedures.deprecationAgeMs",
        ),
      },
      consolidation: {
        enabled: parseMemoryV2FeatureEnabled(
          version,
          memoryConsolidation.enabled,
          USER_CONFIG_DEFAULTS.memory.consolidation.enabled,
          "memory.consolidation.enabled",
        ),
        intervalMs: parsePositiveInt(
          memoryConsolidation.intervalMs ??
            USER_CONFIG_DEFAULTS.memory.consolidation.intervalMs,
          "memory.consolidation.intervalMs",
        ),
        cooldownMs: parsePositiveInt(
          memoryConsolidation.cooldownMs ??
            USER_CONFIG_DEFAULTS.memory.consolidation.cooldownMs,
          "memory.consolidation.cooldownMs",
        ),
        minClusterSize: parsePositiveInt(
          memoryConsolidation.minClusterSize ??
            USER_CONFIG_DEFAULTS.memory.consolidation.minClusterSize,
          "memory.consolidation.minClusterSize",
        ),
        maxClustersPerTick: parsePositiveInt(
          memoryConsolidation.maxClustersPerTick ??
            USER_CONFIG_DEFAULTS.memory.consolidation.maxClustersPerTick,
          "memory.consolidation.maxClustersPerTick",
        ),
        requireSharedTag: parseBool(
          memoryConsolidation.requireSharedTag ??
            USER_CONFIG_DEFAULTS.memory.consolidation.requireSharedTag,
          "memory.consolidation.requireSharedTag",
        ),
        distillTimeoutMs: parsePositiveInt(
          memoryConsolidation.distillTimeoutMs ??
            USER_CONFIG_DEFAULTS.memory.consolidation.distillTimeoutMs,
          "memory.consolidation.distillTimeoutMs",
        ),
      },
      voting: {
        enabled: parseMemoryV2FeatureEnabled(
          version,
          memoryVoting.enabled,
          USER_CONFIG_DEFAULTS.memory.voting.enabled,
          "memory.voting.enabled",
        ),
        maxVotePerItem: parsePositiveInt(
          memoryVoting.maxVotePerItem ??
            USER_CONFIG_DEFAULTS.memory.voting.maxVotePerItem,
          "memory.voting.maxVotePerItem",
        ),
        signalDecay: parseHalfOpenUnitInterval(
          memoryVoting.signalDecay ??
            USER_CONFIG_DEFAULTS.memory.voting.signalDecay,
          "memory.voting.signalDecay",
        ),
        scoreBlend: parseUnitInterval(
          memoryVoting.scoreBlend ??
            USER_CONFIG_DEFAULTS.memory.voting.scoreBlend,
          "memory.voting.scoreBlend",
        ),
        eventLogMaxRows: parseNonNegativeInt(
          memoryVoting.eventLogMaxRows ??
            USER_CONFIG_DEFAULTS.memory.voting.eventLogMaxRows,
          "memory.voting.eventLogMaxRows",
        ),
        profileFilterThreshold: parsePositiveInt(
          memoryVoting.profileFilterThreshold ??
            USER_CONFIG_DEFAULTS.memory.voting.profileFilterThreshold,
          "memory.voting.profileFilterThreshold",
        ),
      },
      retrieve: {
        rewriter: {
          enabled: parseMemoryV2FeatureEnabled(
            version,
            memoryRetrieveRewriter.enabled,
            USER_CONFIG_DEFAULTS.memory.retrieve.rewriter.enabled,
            "memory.retrieve.rewriter.enabled",
          ),
          timeoutMs: parsePositiveInt(
            memoryRetrieveRewriter.timeoutMs ??
              USER_CONFIG_DEFAULTS.memory.retrieve.rewriter.timeoutMs,
            "memory.retrieve.rewriter.timeoutMs",
          ),
          historyTurns: parsePositiveInt(
            memoryRetrieveRewriter.historyTurns ??
              USER_CONFIG_DEFAULTS.memory.retrieve.rewriter.historyTurns,
            "memory.retrieve.rewriter.historyTurns",
          ),
          gateMode: parseRewriterGateMode(
            memoryRetrieveRewriter.gateMode ??
              USER_CONFIG_DEFAULTS.memory.retrieve.rewriter.gateMode,
            "memory.retrieve.rewriter.gateMode",
          ),
          embeddingGate: {
            threshold: parseUnitInterval(
              memoryRetrieveRewriterEmbeddingGate.threshold ??
                USER_CONFIG_DEFAULTS.memory.retrieve.rewriter.embeddingGate
                  .threshold,
              "memory.retrieve.rewriter.embeddingGate.threshold",
            ),
            exemplars: parseStringArrayOrNull(
              memoryRetrieveRewriterEmbeddingGate.exemplars ??
                USER_CONFIG_DEFAULTS.memory.retrieve.rewriter.embeddingGate
                  .exemplars,
              "memory.retrieve.rewriter.embeddingGate.exemplars",
            ),
          },
        },
      },
    },
    webhooks,
    vision: {
      enabled: parseBool(
        vision.enabled ?? USER_CONFIG_DEFAULTS.vision.enabled,
        "vision.enabled",
      ),
      autoDetect: parseBool(
        vision.autoDetect ?? USER_CONFIG_DEFAULTS.vision.autoDetect,
        "vision.autoDetect",
      ),
      maxImageBytes: parsePositiveInt(
        vision.maxImageBytes ?? USER_CONFIG_DEFAULTS.vision.maxImageBytes,
        "vision.maxImageBytes",
      ),
      maxImagesPerCall: parsePositiveInt(
        vision.maxImagesPerCall ?? USER_CONFIG_DEFAULTS.vision.maxImagesPerCall,
        "vision.maxImagesPerCall",
      ),
    },
    skills: {
      disabled: parseSkillNameArray(
        skills.disabled ?? USER_CONFIG_DEFAULTS.skills.disabled,
        "skills.disabled",
      ),
      taps: parseSkillTapArray(
        skills.taps ?? USER_CONFIG_DEFAULTS.skills.taps,
        "skills.taps",
      ),
      clawhub: parseClawHubConfig(skills.clawhub),
    },
    tui: {
      theme: parseThemeName(
        tui.theme ?? USER_CONFIG_DEFAULTS.tui.theme,
        "tui.theme",
      ),
      whileBusySubmit: parseWhileBusySubmit(
        tui.whileBusySubmit ?? USER_CONFIG_DEFAULTS.tui.whileBusySubmit,
        "tui.whileBusySubmit",
      ),
      mouse: parseBool(tui.mouse ?? USER_CONFIG_DEFAULTS.tui.mouse, "tui.mouse"),
      onboarding: parseOnboardingState(tui.onboarding),
    },
    analytics: {
      enabled: parseBool(
        analytics.enabled ?? USER_CONFIG_DEFAULTS.analytics.enabled,
        "analytics.enabled",
      ),
    },
    telegram: {
      enabled: parseBool(
        telegram.enabled ?? USER_CONFIG_DEFAULTS.telegram.enabled,
        "telegram.enabled",
      ),
      ownerUserId: parseTelegramOwnerId(
        telegram.ownerUserId ?? USER_CONFIG_DEFAULTS.telegram.ownerUserId,
        "telegram.ownerUserId",
      ),
      parseMode: parseTelegramParseMode(
        telegram.parseMode ?? USER_CONFIG_DEFAULTS.telegram.parseMode,
        "telegram.parseMode",
      ),
      progressIndicator: parseBool(
        telegram.progressIndicator ??
          USER_CONFIG_DEFAULTS.telegram.progressIndicator,
        "telegram.progressIndicator",
      ),
    },
    mcp: {
      servers: parseMcpServers(mcp.servers, "mcp.servers"),
    },
    ...(llmBlock !== undefined ? { llm: llmBlock } : {}),
  };
}

/**
 * Parse `tui.theme`. Accepts the literal `"auto"` or any non-empty,
 * trimmed string (a theme name). The set of valid theme names lives in
 * the TUI layer (`isThemeName`); the config layer stays decoupled and
 * only enforces the string shape — an unknown name falls back to the
 * autodetect path at startup, never crashes. Anything non-string throws.
 */
/**
 * What Enter does in the TUI while a turn is already running.
 *
 * `steer` folds the message into the turn in flight (it reaches the
 * model at the next step boundary); `queue` parks it and runs it as its
 * own turn once the current one closes. Default is `steer` — an
 * operator who types *while* the agent is working is usually reacting
 * to what they see it doing.
 */
export type WhileBusySubmitMode = "steer" | "queue";

/**
 * Parse `tui.whileBusySubmit` (added in config v38). Older config files predate the key and
 * are transparently upgraded to the `steer` default by the `??` at the
 * call site, so there is no migration step.
 */
export function parseWhileBusySubmit(
  raw: unknown,
  field: string,
): WhileBusySubmitMode {
  if (raw === "steer" || raw === "queue") return raw;
  throw new ConfigValidationError(
    field,
    `expected "steer" or "queue", got ${JSON.stringify(raw)}`,
  );
}

/**
 * First-run flow state (config v43, extended in v44). Five nullable
 * ISO-8601 timestamps, not booleans: knowing *when* a run was completed
 * or skipped is what lets a later release decide whether an install
 * predates a flow it would like to show again, and it costs the same
 * byte budget.
 *
 * - `introSeenAt` — the splash was dismissed at least once.
 * - `completedAt` — a backend was configured and the flow handed over to
 *   the agent. Set for the "custom endpoint" branch too.
 * - `skippedAt` — the operator escaped out. The flow does not reopen by
 *   itself afterwards; before v43 nothing was written here, which is why
 *   an escaped setup used to reappear on every single launch.
 * - `proposedSecondBackendAt` — the "you have one, want the other too?"
 *   screen was already offered, so it is never offered twice.
 * - `localSetupSeenAt` — the local model list was reached, whether or
 *   not a model came out of it. Recorded rather than derived because
 *   backing out of that list leaves no trace anywhere else, and it
 *   survives a launch: an interrupted first run is exactly the case
 *   where an operator would otherwise be shown it twice.
 */
export interface OnboardingState {
  completedAt: string | null;
  introSeenAt: string | null;
  skippedAt: string | null;
  proposedSecondBackendAt: string | null;
  localSetupSeenAt: string | null;
}

/**
 * Parse `tui.onboarding`. Absent, `null`, or an empty object all mean a
 * fresh install, so every field falls back to `null` rather than
 * throwing — an older config file must never fail to load because it
 * predates the block.
 */
export function parseOnboardingState(raw: unknown): OnboardingState {
  const defaults = USER_CONFIG_DEFAULTS.tui.onboarding;
  if (raw === undefined || raw === null) return { ...defaults };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(
      "tui.onboarding",
      `expected object, got ${JSON.stringify(raw)}`,
    );
  }
  const obj = raw as Record<string, unknown>;
  return {
    completedAt: parseTimestampOrNull(obj.completedAt, "tui.onboarding.completedAt"),
    introSeenAt: parseTimestampOrNull(obj.introSeenAt, "tui.onboarding.introSeenAt"),
    skippedAt: parseTimestampOrNull(obj.skippedAt, "tui.onboarding.skippedAt"),
    proposedSecondBackendAt: parseTimestampOrNull(
      obj.proposedSecondBackendAt,
      "tui.onboarding.proposedSecondBackendAt",
    ),
    localSetupSeenAt: parseTimestampOrNull(
      obj.localSetupSeenAt,
      "tui.onboarding.localSetupSeenAt",
    ),
  };
}

/**
 * An ISO-8601 instant or `null`. Validated through `Date.parse` rather
 * than a regex so a hand-edited file with a plausible-but-unparseable
 * stamp is rejected at load instead of producing an `Invalid Date`
 * somewhere far away.
 */
export function parseTimestampOrNull(raw: unknown, field: string): string | null {
  if (raw === undefined || raw === null) return null;
  const s = parseNonEmptyString(raw, field);
  if (Number.isNaN(Date.parse(s))) {
    throw new ConfigValidationError(
      field,
      `expected an ISO-8601 timestamp, got ${JSON.stringify(s)}`,
    );
  }
  return s;
}

export function parseThemeName(raw: unknown, field: string): string {
  if (typeof raw !== "string") {
    throw new ConfigValidationError(
      field,
      `expected a string, got ${JSON.stringify(raw)}`,
    );
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? "auto" : trimmed;
}

/**
 * Parse the agent-reply parse mode for outbound Telegram messages.
 * Accepts `"plain"` and `"html"` only — `markdownV2` is intentionally
 * excluded (see `TelegramParseMode` doc-comment for rationale).
 */
export function parseTelegramParseMode(
  raw: unknown,
  field: string,
): TelegramParseMode {
  if (raw === "plain" || raw === "html") return raw;
  throw new ConfigValidationError(
    field,
    `expected one of plain|html, got ${JSON.stringify(raw)}`,
  );
}

/**
 * Parse a Telegram numeric user id. Accepts `null` (not configured),
 * a positive integer, or a numeric string (so hand-edited config
 * files written by humans still validate). Anything else throws.
 * Telegram user ids fit comfortably inside `Number.MAX_SAFE_INTEGER`
 * for the foreseeable future, so we keep the simpler `number` shape
 * instead of `bigint`.
 */
export function parseTelegramOwnerId(
  raw: unknown,
  field: string,
): number | null {
  if (raw === null || raw === undefined) return null;
  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number(raw)
        : NaN;
  if (
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new ConfigValidationError(
      field,
      `expected positive integer or null, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}
