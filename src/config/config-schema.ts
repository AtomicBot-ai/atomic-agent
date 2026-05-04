import type { TaskSchedule } from "../tasks/task-types.js";
import { isKnownLocalModelId } from "../local-llm/models-catalog.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type BrowserChannel = "chrome" | "msedge" | "chromium";

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
  };
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
    approvalRequired: boolean;
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
  };
  browser: {
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
  };
  http: {
    enabled: boolean;
    approvalMode: HttpApprovalMode;
    hostAllowlist: string[] | null;
    maxResponseBytes: number;
    defaultTimeoutMs: number;
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
  autoUpdate: boolean;
}

/**
 * User-facing keys that live in `<stateDir>/config.json`. The file
 * format is versioned; bump `USER_CONFIG_VERSION` on breaking schema
 * changes and add a migration step in `parseUserConfigFile`.
 */
export interface UserConfigFile {
  version: typeof USER_CONFIG_VERSION;
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
  };
  log: { level: LogLevel };
  agent: {
    tokenBudget: number;
    maxSteps: number;
    toolTimeoutMs: number;
    approvalRequired: boolean;
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
   */
  skills: {
    disabled: string[];
  };
}

export const USER_CONFIG_VERSION = 8 as const;

/**
 * Config versions that `parseUserConfigFile` still accepts on input.
 * v5 renamed the `llama` block to `localModels` to remove the Meta
 * "Llama" conflation — the runtime never ran Llama family models
 * specifically. v6 added the optional `vision.*` block; v7 added
 * `localModels.completionMaxTokens` so users can raise the
 * tool-call `n_predict` cap from the file. v8 added the optional
 * `skills.*` block so installed skills can be turned off without
 * removing files from disk. Older files are transparently upgraded
 * by filling missing blocks/fields from `USER_CONFIG_DEFAULTS`.
 * Anything older than v5 is not migrated: this is active
 * development, callers delete their `config.json` and start over.
 */
const SUPPORTED_INPUT_VERSIONS: readonly number[] = [
  5,
  6,
  7,
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
      autoUpdate: false,
    },
  },
  log: { level: "info" },
  agent: {
    tokenBudget: 3000,
    maxSteps: 25,
    toolTimeoutMs: 60_000,
    approvalRequired: true,
    conversationMaxTokens: 32_000,
    worldSnapshotMaxTokens: 8_000,
  },
  http: {
    enabled: true,
    approvalMode: "writes",
    hostAllowlist: null,
    maxResponseBytes: 1_048_576,
    defaultTimeoutMs: 30_000,
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
};

export class ConfigValidationError extends Error {
  constructor(
    public readonly field: string,
    public readonly reason: string,
  ) {
    super(`invalid config: ${field}: ${reason}`);
    this.name = "ConfigValidationError";
  }
}

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

function parseOptionalManagedModelId(raw: unknown, field: string): string | null {
  if (raw === null || raw === undefined) return null;
  const s = parseNonEmptyString(raw, field);
  if (!isKnownLocalModelId(s)) {
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

/**
 * Validate and normalise a raw JSON payload into a `UserConfigFile`.
 * Missing sub-keys are filled with defaults — this lets us add new
 * fields without breaking existing installations. Unknown top-level
 * keys are preserved silently (forward compat).
 */
export function parseUserConfigFile(raw: unknown): UserConfigFile {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError("<root>", "expected JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const version = obj.version ?? USER_CONFIG_VERSION;
  if (
    typeof version !== "number" ||
    !SUPPORTED_INPUT_VERSIONS.includes(version)
  ) {
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
  const webhooks = parseWebhookMap(obj.webhooks ?? {}, "webhooks");
  const vision = (obj.vision as Record<string, unknown> | undefined) ?? {};
  const skills = (obj.skills as Record<string, unknown> | undefined) ?? {};

  const rawManaged =
    (localModels.managed as Record<string, unknown> | undefined) ?? {};
  const managed: UserManagedLocalLlmConfig = {
    modelId: parseOptionalManagedModelId(
      rawManaged.modelId,
      "localModels.managed.modelId",
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
    autoUpdate: parseBool(
      rawManaged.autoUpdate ?? USER_CONFIG_DEFAULTS.localModels.managed.autoUpdate,
      "localModels.managed.autoUpdate",
    ),
  };

  return {
    version: USER_CONFIG_VERSION,
    localModels: {
      url: parseUrl(
        localModels.url ?? USER_CONFIG_DEFAULTS.localModels.url,
        "localModels.url",
      ),
      mode: parseLocalLlmMode(
        localModels.mode ?? USER_CONFIG_DEFAULTS.localModels.mode,
        "localModels.mode",
      ),
      completionMaxTokens: parseBoundedPositiveInt(
        localModels.completionMaxTokens ??
          USER_CONFIG_DEFAULTS.localModels.completionMaxTokens,
        "localModels.completionMaxTokens",
        64,
        131_072,
      ),
      managed,
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
      approvalRequired: parseBool(
        agent.approvalRequired ?? USER_CONFIG_DEFAULTS.agent.approvalRequired,
        "agent.approvalRequired",
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
      approvalMode: parseHttpApprovalMode(
        http.approvalMode ?? USER_CONFIG_DEFAULTS.http.approvalMode,
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
    },
  };
}
