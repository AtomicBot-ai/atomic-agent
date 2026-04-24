import type { TaskSchedule } from "../tasks/task-types.js";

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
 * keys) plus environment variables (bootstrap paths, browser, llama
 * timeouts, etc.). All consumers outside `src/config/` depend only on
 * this shape.
 */
export interface AtomicAgentConfig {
  llama: {
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
}

/**
 * When to require approval for outbound HTTP calls via `os.http.request`.
 *  - `never`:   trust the LLM blindly (not recommended outside sandboxes).
 *  - `writes`:  GET + HEAD bypass approval; anything with a body (POST…) needs it.
 *  - `always`:  every call goes through the approval gate.
 */
export type HttpApprovalMode = "never" | "writes" | "always";

/**
 * The 6 user-facing keys that live in `<stateDir>/config.json`. The file
 * format is versioned; bump `USER_CONFIG_VERSION` on breaking schema
 * changes and add a migration step in `parseUserConfigFile`.
 */
export interface UserConfigFile {
  version: typeof USER_CONFIG_VERSION;
  llama: { url: string };
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
}

export const USER_CONFIG_VERSION = 3 as const;

/**
 * Config versions that `parseUserConfigFile` still accepts on input.
 * v1 and v2 files are silently upgraded to `USER_CONFIG_VERSION`
 * in-memory; missing sub-keys fall back to `USER_CONFIG_DEFAULTS`.
 * The upgraded shape is written back to disk on the next
 * `config set` / `ensure`.
 */
const SUPPORTED_INPUT_VERSIONS: readonly number[] = [1, 2, USER_CONFIG_VERSION];

export const USER_CONFIG_DEFAULTS: UserConfigFile = {
  version: USER_CONFIG_VERSION,
  llama: { url: "http://127.0.0.1:8080" },
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
};

/** Non-user env-based defaults (not part of the user config file). */
export const ENV_DEFAULTS = {
  STATE_DIR: "~/.atomic-agent",
  HEALTH_TIMEOUT_MS: 3000,
  REQUEST_TIMEOUT_MS: 120_000,
  HEALTH_RETRIES: 5,
  HEALTH_BACKOFF_MS: 500,
  COMPLETION_RETRIES: 3,
  COMPLETION_RETRY_BACKOFF_MS: 150,
  DEFAULT_SLOT_ID: 0,
  /** Default `n_predict` for grammar-constrained tool JSON (512 truncates long `reply.text`). */
  LLAMA_COMPLETION_MAX_TOKENS: 4096,
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

  const llama = (obj.llama as Record<string, unknown> | undefined) ?? {};
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

  return {
    version: USER_CONFIG_VERSION,
    llama: {
      url: parseUrl(llama.url ?? USER_CONFIG_DEFAULTS.llama.url, "llama.url"),
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
  };
}
