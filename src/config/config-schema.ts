import type { RuntimeAgentConfig, UserAgentConfig } from "./agent/agent-types.js";
import { createAgentDefaults } from "./agent/agent-defaults.js";
import { parseAgentConfig } from "./agent/agent-parser.js";
export type { ReadScope } from "./agent/agent-types.js";
export { READ_SCOPES, parseReadScope, parseApprovalLevel, CONVERSATION_MAX_PAIRS_MIN, CONVERSATION_MAX_PAIRS_MAX } from "./agent/agent-parser.js";

import { createHttpDefaults, parseHttpConfig, type RuntimeHttpConfig, type UserHttpConfig } from "./http-config.js";
export { parseHttpApprovalMode, type HttpApprovalMode } from "./http-config.js";

import {
  createProjectsDefaults, createToolsDefaults, createVisionDefaults,
  parseProjectsConfig, parseToolsConfig, parseVisionConfig,
  type RuntimeProjectsConfig, type UserProjectsConfig,
  type RuntimeToolsConfig, type UserToolsConfig,
  type RuntimeVisionConfig, type UserVisionConfig,
} from "./tool-config.js";

import { createSkillsDefaults, parseSkillsConfig, parseClawHubConfigWithDefaults, DEFAULT_SKILLS_CATALOG_BUDGET, type RuntimeSkillsConfig, type UserSkillsConfig } from "./skills-config.js";
export { DEFAULT_SKILLS_CATALOG_BUDGET, parseSkillNameArray, parseSkillTapArray } from "./skills-config.js";
import { createSessionDefaults, parseSessionConfig, type RuntimeSessionsConfig, type UserSessionsConfig } from "./session-retention-config.js";
import { createTracingDefaults, parseTracingConfig, type RuntimeTracingConfig, type UserTracingConfig } from "./tracing-config.js";

import {
  createTuiDefaults, parseTuiConfig,
  parseOnboardingStateWithDefaults, parseTuiNotifyWithDefaults,
  type TuiConfig, type OnboardingState, type TuiNotifyConfig,
} from "./tui-config.js";
export {
  parseWhileBusySubmit, parseTimestampOrNull, parseThemeName,
  type TuiNotifyConfig, type WhileBusySubmitMode, type OnboardingState,
} from "./tui-config.js";

import {
  createTelegramDefaults, createDiscordDefaults, createSwarmDefaults,
  parseTelegramConfig, parseDiscordConfig, parseSwarmConfig,
  type TelegramConfig, type DiscordConfig, type SwarmConfig,
} from "./channel-config.js";
export {
  SWARM_UNIT_ID, parseTelegramOwnerId, parseDiscordOwnerUserIds,
  type TelegramParseMode, type TelegramConfig, type DiscordConfig,
  type SwarmUnitConfig, type SwarmConfig,
} from "./channel-config.js";

import {
  createNotificationsDefaults, createAtomicMailDefaults,
  createGitDefaults, createComposioDefaults,
  parseNotificationsConfig, parseAtomicMailConfig, parseGitConfig, parseComposioConfig,
  type NotificationsConfig, type AtomicMailConfig, type GitConfig, type ComposioConfig,
} from "./integration-config.js";
export {
  parseDownloadNotifyChannel, type DownloadNotifyChannelSetting,
  type NotificationsConfig, type AtomicMailConfig, type GitConfig, type ComposioConfig,
} from "./integration-config.js";

import type {
  RuntimeLocalModelsConfig,
  UserLocalModelsConfig,
} from "./local-models/local-models-types.js";
import { createLocalModelsDefaults } from "./local-models/local-models-defaults.js";
import {
  prepareLocalModelsInputs,
  parseUserLocalModelsConfig,
} from "./local-models/local-models-parser.js";

export type {
  LocalLlmMode,
  LocalTemplateSetting,
  UserManagedLocalLlmConfig,
  LocalModelDownloadConfig,
  UserManagedEmbeddingLlmConfig,
} from "./local-models/local-models-types.js";
export {
  parseLocalTemplateSetting,
  parseLocalLlmMode,
  parseBackendVariant,
  parseSwaFullPreference,
  parseLocalCompletionCap,
  parseReasoningBudgetTokens,
  parseTensorSplit,
} from "./local-models/local-models-parser.js";

import type {
  RuntimeMemoryConfig,
  UserMemoryConfig,
} from "./memory/memory-types.js";
import { createMemoryDefaults } from "./memory/memory-defaults.js";
import {
  prepareMemoryInputs,
  parseMemoryConfig,
} from "./memory/memory-parser.js";

export type { RewriterGateMode } from "./memory/memory-types.js";
export { parseRewriterGateMode } from "./memory/memory-parser.js";

import {
  createWebSearchDefaults,
  createWebFetchDefaults,
  prepareWebSearchInputs,
  parseWebSearchConfig,
  parseWebFetchConfig,
  type WebSearchConfig,
  type WebFetchConfig,
} from "./web-config.js";

export {
  parseWebSearchProviderName,
  parseWebSearchFallback,
  type WebSearchProviderName,
  type WebSearchConfig,
  type WebFetchConfig,
} from "./web-config.js";
export { parseStringArrayOrNull, parseUrl } from "./config-values.js";

import { parseMcpServers } from "./mcp-server-config.js";
export { parseMcpServers } from "./mcp-server-config.js";

import {
  parseWebhookMap,
  type WebhookConfig,
} from "./webhook-config.js";

export {
  parseWebhookMap,
  type WebhookConfig,
} from "./webhook-config.js";

export {
  parseSessionRailConfig,
  type SessionRailConfig,
} from "./session-rail-config.js";

import { parseBool } from "./config-primitives.js";

export {
  parsePositiveInt,
  parseBoundedPositiveInt,
  parseNonNegativeInt,
  parseNonNegativeBoundedInt,
  parseUnitInterval,
  parseHalfOpenUnitInterval,
  parseBool,
  parseBoolOrNull,
  parseNonEmptyString,
} from "./config-primitives.js";
import {
  parseUserLlmFileConfig,
  type UserLlmFileConfig,
} from "./llm-config.js";
import type { UserLlmRunModeConfig } from "./llm-run-mode-config.js";
import { defaultProviderModelMode } from "./model-mode.js";

export type { ApprovalLevel } from "../approval/approval-level.js";
import type { DotenvLoadResult } from "./load-dotenv.js";
import type { McpServerConfig } from "../mcp/mcp-types.js";

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

/**
 * Full runtime config assembled from the user config file (6 user-facing
 * keys) plus environment variables (bootstrap paths, browser, local-LLM
 * timeouts, etc.). All consumers outside `src/config/` depend only on
 * this shape.
 */
export interface AtomicAgentConfig {
  localModels: RuntimeLocalModelsConfig;
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
  agent: RuntimeAgentConfig;
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
  skills: RuntimeSkillsConfig;
  http: RuntimeHttpConfig;
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
  projects: RuntimeProjectsConfig;
  /**
   * Per-tool operator settings. Mirrors `UserConfigFile.tools`.
   */
  tools: RuntimeToolsConfig;
  log: {
    level: LogLevel;
  };
  /**
   * Retention for `<stateDir>/sessions.sqlite` and the per-session trace
   * files beside it. Mirrors `UserConfigFile.sessions`. Nothing in the
   * runtime ever shrank either before this block: `delete(id)` is
   * one-at-a-time and operator-driven, and the only bulk wipe is
   * `atag uninstall`. See §"Session retention" in README.md.
   */
  sessions: RuntimeSessionsConfig;
  tracing: RuntimeTracingConfig;
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
  memory: RuntimeMemoryConfig;
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
  vision: RuntimeVisionConfig;
  /**
   * TUI appearance and input. Mirrors `UserConfigFile.tui`. `theme` is
   * `"auto"` (OSC 11 autodetect) or a registered theme name; `mouse`
   * toggles terminal mouse reporting. Consumed by the TUI startup path;
   * the rest of the runtime ignores it.
   */
  tui: TuiConfig;
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
   * Discord remote-control channel. Mirrors `UserConfigFile.discord`.
   * The bot token is not stored here — see `DiscordConfig`.
   */
  discord: DiscordConfig;
  /** Extra Telegram / Discord bots. Mirrors `UserConfigFile.swarm`. */
  swarm: SwarmConfig;
  /** Out-of-band pings. Mirrors `UserConfigFile.notifications`. */
  notifications: NotificationsConfig;
  /** The agent's own inbox. Mirrors `UserConfigFile.atomicMail`. */
  atomicMail: AtomicMailConfig;
  /**
   * Git remote-sync policy. Mirrors `UserConfigFile.git`. The GitHub
   * token is not stored here — see `GitConfig`.
   */
  git: GitConfig;
  /**
   * Composio integration. Mirrors `UserConfigFile.composio`. The API
   * key is not stored here — see `ComposioConfig`.
   */
  composio: ComposioConfig;
  /**
   * MCP (Model Context Protocol) client configuration. Mirrors
   * `UserConfigFile.mcp`. Each entry in `servers[]` becomes a
   * lifecycle-managed connection to an external MCP server. Tools
   * are exposed through the regular `ToolRegistry` as
   * `mcp.<server>.<tool>`. See ../mcp/docs/client.md.
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
      modelMode?: import("./model-mode.js").ModelMode;
      modelModes?: Readonly<Record<string, import("./model-mode.js").ModelMode>>;
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
      /**
       * Env var holding this entry's API key, set by the known-service
       * presets so each service keeps its own (`GROQ_API_KEY`,
       * `NOUS_API_KEY`, ...). Authoritative when present — see
       * `resolveLlmProviderApiKey`. `parseLlmProviders` has always
       * carried it through `UserLlmProviderEntry`; it was simply
       * missing from this mirror of that shape.
       */
      apiKeyEnvVar?: string;
      supportsTools?: boolean;
      supportsVision?: boolean;
      requestTimeoutMs?: number;
      promptCache?: "auto" | "off" | "explicit-markers";
      /**
       * Native-tools request layout: `native` (default) sends a system
       * message plus the history as assistant `tool_calls` / `tool`
       * results; `flat` sends the one user message of transcript text.
       */
      messageShape?: "native" | "flat";
      /**
       * OpenRouter provider routing (`order`, `only`, `ignore`,
       * `allow_fallbacks`, `require_parameters`, `sort`,
       * `data_collection`, …), sent verbatim as the chat body's
       * `provider` object. Read by the `openrouter` kind only; an
       * explicit `extraBody.provider` still wins.
       */
      providerPreferences?: Record<string, unknown>;
      /**
       * Vendor-specific fields merged into the OpenAI-compatible chat
       * body. Reserved keys (`model`, `messages`, `stream`, `tools`)
       * are re-applied after the merge and cannot be overridden.
       */
      extraBody?: Record<string, unknown>;
      /**
       * Emit OpenAI strict function tools (`tools[].function.strict`)
       * for this provider, rewriting each tool schema into the subset
       * strict mode accepts. Off by default: a service that does not
       * implement strict mode rejects the whole request. Not reachable
       * through `extraBody`, because `tools` is a reserved key.
       */
      strictTools?: boolean;
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
          | "auto"
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
        /**
         * Wire parameters for this model, merged into every chat body
         * after the provider's `extraBody`. Reserved keys still win.
         */
        params?: Record<string, unknown>;
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
     * circuit-breaker numbers in ../llm/docs/fallback.md.
     */
    fallback?: {
      chain?: readonly string[];
      appendLocal?: boolean;
      failureThreshold?: number;
      cooldownMs?: readonly number[];
      probeThrottleMs?: number;
      failureWindowMs?: number;
    };
    /**
     * Run mode: `local` | `cloud` | `fusion`, plus the fusion legs
     * (cloud orchestrator + llama-server workers). Additive —
     * `activeTextProvider` stays authoritative; see
     * `src/llm/run-mode/resolve-run-mode.ts`.
     */
    runMode?: UserLlmRunModeConfig;
    /**
     * Settings for every `openrouter` entry at once.
     * `preferCacheRoutes` (default `true`) pins `google/…` models to the
     * routes that honour prompt caching unless the entry configured
     * `providerPreferences` itself.
     */
    openrouter?: {
      preferCacheRoutes?: boolean;
    };
  };
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
  localModels: UserLocalModelsConfig;
  log: { level: LogLevel };
  agent: UserAgentConfig;
  http: UserHttpConfig;
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
  projects: UserProjectsConfig;
  /**
   * Per-tool operator settings (config v67).
   */
  tools: UserToolsConfig;
  /**
   * Session retention (config v73). One bounded prune of
   * `sessions.sqlite` at startup, plus the trace file of every row it
   * removed. Off by default — see the runtime type above for why — and
   * a no-op end to end while it is off.
   */
  sessions: UserSessionsConfig;
  tracing: UserTracingConfig;
  memory: UserMemoryConfig;
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
  vision: UserVisionConfig;
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
   *
   * `catalogTokenBudget` (added in config v70) is the soft budget for
   * the `### skills` block of the stable prefix, in tokens. It shipped
   * as `ATOMIC_AGENT_SKILLS_CATALOG_BUDGET` only, which made it the one
   * `skills.*` knob a config file could not set — writing it there was
   * parsed away in silence (issue #466). Older files are upgraded with
   * the env default, so the prompt is unchanged. The env var still wins
   * when both are set (operator override), exactly as it does for
   * `localModels.completionMaxTokens`.
   */
  skills: UserSkillsConfig;
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
   *
   * `sessionRail` (config v52) remembers the operator's own ordering of
   * the rail's Sessions list, and (v53) which threads are pinned to its
   * top — see {@link SessionRailConfig}. Older files are upgraded with
   * an empty order, which means "by recency", and nothing pinned.
   */
  tui: TuiConfig;
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
   * Discord remote-control channel. Added in config v51. Older files
   * are transparently upgraded with `{ enabled: false, ownerUserId:
   * null }`, which starts nothing.
   */
  discord: DiscordConfig;
  /**
   * Extra Telegram / Discord bots ("swarm units"). Added in config v52.
   * Older files are transparently upgraded with `{ units: [] }`.
   */
  swarm: SwarmConfig;
  /**
   * Out-of-band pings — today, where a background model download
   * reports when it lands. Added in config v55. Older files are
   * transparently upgraded with `{ downloads: { channel: null } }`,
   * which means "ask on the next pull".
   */
  notifications: NotificationsConfig;
  /**
   * Atomic Mail. Added in config v56. Older files are transparently
   * upgraded with every field `null`: no inbox, no owner, nothing sent.
   */
  atomicMail: AtomicMailConfig;
  /**
   * Git remote-sync policy. Added in config v62. Older files are
   * transparently upgraded with `{ remoteSync: false }`, which keeps
   * every repository on this machine until the operator says otherwise.
   */
  git: GitConfig;
  /**
   * Composio integration. Added in config v50. Older files are
   * transparently upgraded with the defaults below, which leave the
   * integration inert until a key is written to `<stateDir>/.env`.
   */
  composio: ComposioConfig;
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
// v46: web.search gains `persistCache` (#256) — persist the search result
// cache and the provider cooldown under `stateDir` so a per-task process
// starts warm instead of re-spending quota. Additive: an older file parses
// with the default `true`, which is the new product behaviour; `false`
// keeps both structures in-memory (the pre-v46 behaviour) for workloads
// that want a cold cache per run.
// v47: localModels.managed gains `backendVariant` — which llama.cpp
// release zip the managed backend installs on Windows (`auto` | `cpu` |
// `vulkan` | `cuda-12.4` | `cuda-13.3`). Exists for iGPU-only boxes whose
// Vulkan build cannot load a model; the start-failure fallback persists
// `"cpu"` here so auto-update stops reinstalling the broken GPU build.
// Additive: older files transparently inherit `"auto"`, the exact
// detection behaviour they already had. (Drafted as a second v46, but v46
// was already spent on `persistCache` — the additive changes keep distinct
// sequential numbers.)
// v48: localModels.managed gains `tensorSplit` (default `[]` = single-device
// auto-pick, byte-identical launch args). Two or more ratios opt the managed
// chat daemon into multi-GPU layer splitting (`--split-mode layer
// --tensor-split <ratios>`). Older files transparently inherit `[]`.
// v49: a sixth stamp in `tui.onboarding` — `importOfferedAt`, written when
// the first run offers the "bring your data over from another agent" step
// (shown once, on the way out of setup, and only when a known agent's
// state dir actually exists). Recorded when it is offered, not when it is
// taken: a declined offer must not come back on a re-run after a reset.
// Additive: an older file parses with it `null`, which reads as "never
// offered", the same answer that file has always implied.
// v50: new `composio` block wiring the Composio toolkit catalogue in as
// an MCP server. Additive and inert by default — the block carries a
// switch, an env-var *name*, and cached session ids, never the key
// itself, and an older file inherits defaults that mount nothing until
// a key is written to `<stateDir>/.env`.
// v51: new `discord` block for the Discord remote-control channel.
// Additive and inert by default — the channel is off, unpaired, and the
// bot token lives in `<stateDir>/.env`, never here.
// v52: new `swarm` block — extra Telegram / Discord bots on one runtime,
// each with its own token (`.env`), owner and label. Default `{ units: [] }`.
// v53: localModels gains `download.connections` — how many parallel range
// requests one model/backend file is split across (default 16). Older
// files inherit the default; `1` is the previous single-stream behaviour.
// v54: `download.hfEndpoint` — the origin that serves Hugging Face (a
// mirror for regions where huggingface.co is slow or blocked). Default is
// the canonical host; `HF_ENDPOINT` in the environment overrides it.
// v55: new `notifications` block — where a background model download
// reports when it lands. Additive: `channel: null` means "not asked yet",
// which is what every older file has always implied.
// v56: new `atomicMail` block — the agent's own inbox and the owner's
// verified e-mail. Additive and inert: every field starts `null`; the API
// key lives in `<stateDir>/.env`, never here.
// v57: `llm.runMode` (mode local|cloud|fusion + the fusion legs and
// worker count) and `localModels.managed.parallel` (llama-server
// `--parallel`, default 2 = the previously hard-coded value). Additive:
// an older file parses with `runMode` absent and `parallel` 2, which
// launches the daemon with byte-identical args.
// v58: new `tui.sessionRail` block holding the operator's manual order of
// the rail's Sessions list (`order: string[]`, session ids). Additive: an
// older file inherits `[]`, which keeps the list sorted by recency until
// the operator moves a row for the first time.
// v59: `tui.sessionRail.pinned` (`string[]`, session ids) — the threads
// the operator pinned to the top of the rail. Additive: an older file
// inherits `[]`, nothing pinned, and `order` keeps its v58 meaning.
// v60: `localModels.completionMaxTokens` accepts `0` — "no client-side
// cap", generate until a stop token or the context window fills — and
// provider entries accept `maxOutputTokens`, the per-provider cloud
// ceiling that replaces the local knob a cloud request used to borrow.
// Additive: an older file keeps its positive cap and no entry ceiling.
// v61: `discord.ownerUserId` (scalar) becomes `discord.ownerUserIds`
// (list) so a bot can answer to more than one person. A pre-v61 file's
// scalar is folded in as the first entry on read, so nothing an
// operator already configured stops working.
// v62: new `git` block carrying the remote-sync policy. Additive and
// closed by default — `remoteSync: false` refuses every network git verb
// so a repository the agent versions stays on this machine; the GitHub
// token lives in `<stateDir>/.env`, never here.
// v63: `localModels.managed.parallel` accepts `"auto"` and defaults to
// it — the slot count is derived from the context the daemon launches
// with instead of being an operator setting. A pre-v63 file whose value
// is the old default `2` (which nobody chose — it was the schema's)
// becomes `"auto"`; any other number is read as a deliberate pin and
// kept.
// v64: provider entries accept `strictTools` — emit OpenAI strict
// function tools (`tools[].function.strict: true`) for this provider,
// with every tool schema rewritten into the subset strict mode accepts.
// Additive and off by default: an older file has no flag, and without
// the flag the request body is byte-identical to v63's. (Written as v63
// on its own branch; renumbered here because the slot-count change took
// that number first.)
// v65: memory sub-call timeouts are sized for hosted reasoning models —
// `memory.reflection.timeoutMs` (also the vote-runner's budget) goes
// 10 000 → 60 000, `memory.links.generatorTimeoutMs` 8 000 → 60 000 and
// `memory.retrieve.rewriter.timeoutMs` 3 000 → 10 000. The old numbers
// were tuned against a local llama-server; hosted models answer the
// background calls in roughly 15–40 s and the rewriter in 4–24 s, so
// most of them timed out and wrote or rewrote nothing. The rewriter's cap
// stays lower because it blocks the turn (it runs once per turn, so a
// timeout costs one wait, not one per step). A pre-v65 file whose value
// is the old default (which the schema wrote, not the operator) takes
// the new one; any other number is read as a deliberate pin and kept.
// v66: `agent.conversationLowWater` — the share of a limit the prompt's
// transcript keeps after a cut (default 0.65), so the cut holds and the
// prompt only grows at its end between cuts. Additive: an older file has
// no field and takes the default.
// v66: provider entries accept `messageShape` (`native` | `flat`, the
// layout of a native-tools request), `userModels[].params` (per-model
// wire parameters merged over `extraBody`) and `userModels[].reasoningFormat`
// accepts `auto`; a new `llm.openrouter` block carries `preferCacheRoutes`
// (default `true`). All additive: an older file parses with every field
// absent, which is the native layout, no extra parameters, `auto`
// reasoning and the cache-capable routes for Google models.
// v66: three additive `llm.runMode.fusion` fields — `cloudWorkers`
// (1..32, default 4: the fan-out cap when the worker leg has no slot
// pool), `workerReasoning` (low|medium|high, unset by default: the
// reasoning effort sent with every worker completion) and
// `workerMaxOutputTokens` (unset by default: the per-step output cap for
// worker completions). An older file parses with all three absent and
// behaves as before, except that a cloud fan-out is now bounded at 4.
// v66: `localModels.useServerTemplate` and `localModels.thinking`
// (`auto|on|off`, both default `auto`) — render local prompts through
// the model's own chat template (llama-server `/apply-template`) for
// families without a hand-built profile, and set the template's
// thinking switch. Additive: an older file inherits `auto` for both.
// v66: `localModels.managed.swaFull` (`"auto"` | `"on"` | `"off"`, default
// `"auto"`) — whether a sliding-window model (Gemma 4 and kin) is
// launched with `--swa-full` so a partially matching prompt reuses its
// matching prefix (see `swa-full.ts`). Additive: an older file has no
// field and gets `"auto"`, which is off unless the full-SWA KV estimate
// fits the launch's memory budget.
// v67: session-boundary fields.
// `tools.shell.defaultTimeoutMs` (default 600 000) — the wall-clock
// wait for an `os.shell.run` call whose `timeoutMs` the model omitted.
// Before v67 an omitted `timeoutMs` meant no limit at all, and a
// recursive grep over a home directory ran for twenty minutes until a
// person killed it; `agent.toolTimeoutMs` never applied to the shell.
// A command still running when the default elapses is detached as a
// job (`src/tools/os/shell-jobs.ts`) rather than killed; the model
// reaches it through the `wait` / `kill` / `jobs` forms of the tool.
// `0` keeps the old unbounded behaviour; an explicit per-call
// `timeoutMs` (including `0`) always wins and kills at its limit.
// `tools.shell.jobMaxMs` (default 3 600 000) — the absolute ceiling for
// a detached job, from its start. `tools.shell.maxJobs` (default 3) —
// detached jobs running at once per session; the next detach evicts the
// oldest un-kept one. All three additive: an older file has no field
// and takes the default.
// `agent.readScope` (`"working-dir"` | `"unrestricted"`, default
// `"working-dir"`) — a session's filesystem reads and shell path
// arguments are confined to the working directory and the paths the user
// named in the conversation (`src/tools/read-scope/`). A DEFAULT-BEHAVIOUR
// CHANGE: an older file has no field and takes `"working-dir"`; the
// pre-v67 behaviour is one line away (`agent.readScope: "unrestricted"`).
// v68: `localModels.reasoningBudgetTokens` (default 1500, `0` =
// unbounded) — the GBNF prelude of a local reasoning model is bounded at
// `budget × 4` characters, after which only the close sentinel is
// admitted; the forced final step keeps an unbounded prelude. Additive:
// an older file has no field and takes the default. In the same step
// `localModels.thinking: "off"` is honoured on the hand-built prompt of a
// `qwen-think` model (disabled marker at the generation point, plain
// grammar root) — no new field, the existing switch reaches one more path.
// v69: `llm.runMode.fusion.reviewStallSteps` (default 6, `0` = off) — the
// number of consecutive read-only orchestrator steps without a
// `fusion.delegate` after which the planner is told to delegate or reply,
// and at twice which the step admits only `fusion.delegate`, `reply` and
// `finish` (F41, `src/agent/review-stall.ts`). Additive: an older file
// has no field, the fusion block stays as it was, and the default applies
// at read time like the other optional fusion fields.
// v70: `skills.catalogTokenBudget` (default 512) — the `### skills`
// catalog budget, until now settable only through
// `ATOMIC_AGENT_SKILLS_CATALOG_BUDGET`; the key in config.json was
// parsed away without a word (issue #466). Additive: an older file has
// no field, takes the env default, and renders the same prompt. The env
// var still overrides the file value.
// v74: `agent.sessionSectionsMaxTokens` (default 0) — the
// `### session-facts` + `### loaded-skills` cap, until now reachable only
// by scaling all of `agent.tokenBudget`. `0` is the sentinel for "keep
// the `tokenBudget * 0.15` share", so an older file renders a
// byte-identical prompt.
// v73: `sessions.retention` (`enabled` false, `maxAgeDays` 90, `maxRows`
// null) — one bounded prune of `sessions.sqlite` and the matching trace
// files at startup. Additive: an older file has no block and takes the
// defaults, which prune nothing until the operator sets `enabled`.
// v72: `agent.nameSessions` (default true) — one short completion per
// session names it from its first prompt, so the rail and the header
// show what the thread is about instead of the raw prompt. Additive: an
// older file inherits `true`, and turning it off restores the prompt.
// v71: `tui.notify` (`enabled` true, `minDurationMs` 30_000) — the TUI
// writes an OSC 9 notification plus a BEL to its own terminal when a
// turn ends, so an operator who walked away finds out. Additive: an
// older file has no block and takes the defaults.
// v75: known cloud providers without a saved modelMode adopt cloud context.
// Explicit provider/model policies and local/unknown endpoints stay unchanged.
// This one-time migration shares the classification used for new connections.
export const USER_CONFIG_VERSION = 75;

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
  45,
  46,
  47,
  48,
  49,
  50,
  51,
  52,
  53,
  54,
  55,
  56,
  57,
  58,
  59,
  60,
  61,
  62,
  63,
  64,
  65,
  66,
  67,
  68,
  69,
  70,
  71,
  72,
  73,
  74,
  USER_CONFIG_VERSION,
];

export const USER_CONFIG_DEFAULTS: UserConfigFile = {
  version: USER_CONFIG_VERSION,
  localModels: createLocalModelsDefaults(),
  log: { level: "info" },
  agent: createAgentDefaults(),
  http: createHttpDefaults(),
  web: {
    search: createWebSearchDefaults(),
    fetch: createWebFetchDefaults(),
  },
  projects: createProjectsDefaults(),
  tools: createToolsDefaults(),
  sessions: createSessionDefaults(),
  tracing: createTracingDefaults(),
  memory: createMemoryDefaults(),
  webhooks: {},
  vision: createVisionDefaults(),
  skills: createSkillsDefaults(),
  tui: createTuiDefaults(),
  analytics: {
    enabled: true,
  },
  telegram: createTelegramDefaults(),
  discord: createDiscordDefaults(),
  swarm: createSwarmDefaults(),
  notifications: createNotificationsDefaults(),
  atomicMail: createAtomicMailDefaults(),
  git: createGitDefaults(),
  composio: createComposioDefaults(),
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
  /**
   * 30 minutes. How long a local stream may wait for its first byte — see
   * `AtomicAgentConfig.localModels.firstTokenTimeoutMs`.
   *
   * Sized for the slowest honest wait fusion produces, not for one
   * request on an idle server: several workers on one GPU queue behind
   * each other's prompt evals, and a queued worker whose slot had not
   * yet evaluated a token was cancelled at the 300 s idle budget. A wait
   * that is really stuck still ends on the caller's own bounds (the
   * worker's turn timeout, Esc). Raise it with
   * `ATOMIC_AGENT_LLAMA_FIRST_TOKEN_TIMEOUT_MS`.
   */
  FIRST_TOKEN_TIMEOUT_MS: 30 * 60 * 1_000,
  /**
   * 6 hours. The backstop on a single streaming response — see
   * `AtomicAgentConfig.localModels.streamTotalTimeoutMs`.
   *
   * Chosen to clear the worst *honest* local generation by a wide
   * margin: the default `completionMaxTokens` of 8 192 tokens decoded at
   * 0.4 tok/s — slower than any CPU setup people actually sit through —
   * is about 5.7 h. It is also 72x `REQUEST_TIMEOUT_MS`, so the idle
   * deadline gets dozens of chances to fire first; if this one fires,
   * the server was streaming continuously for six hours without
   * finishing, which no local model this project targets does by
   * accident. Raise it with `ATOMIC_AGENT_LLAMA_STREAM_TOTAL_TIMEOUT_MS`
   * if you really do run a 131 072-token completion on a slow box.
   */
  STREAM_TOTAL_TIMEOUT_MS: 6 * 60 * 60 * 1_000,
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
  SKILLS_CATALOG_BUDGET: DEFAULT_SKILLS_CATALOG_BUDGET,
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
  BATCH_TOOL_RESULT_CHAR_CAP: 32_000,
  /**
   * Ingestion cap (chars) on a non-`gog` `os.shell.run` result summary.
   * This is the one line to change to pick a different default.
   */
  SHELL_TOOL_RESULT_CHAR_CAP: 16_000,
  /** Ingestion cap (tail lines) on a non-`gog` `os.shell.run` result summary. */
  SHELL_TOOL_RESULT_TAIL_LINES: 500,
  /** Args-only repeat count that injects a no-progress `### notice`. */
  LOOP_WARNING_THRESHOLD: 3,
  /** Identical args+result streak that vetoes a call before dispatch. */
  LOOP_CRITICAL_THRESHOLD: 5,
  /** Consecutive vetoes of one signature that force a graceful reply. */
  LOOP_BREAKER_VETO_STREAK: 3,
  /** Sliding window size for the loop tracker's history ring. */
  LOOP_HISTORY_SIZE: 30,
  /** Distinct-args run spread on a wandering-prone tool that redirects. */
  LOOP_WANDERING_THRESHOLD: 6,
  /** Run spread that escalates a wandering loop to a graceful reply. */
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

export function parseBrowserChannel(
  raw: unknown,
  field: string,
): BrowserChannel {
  if (raw === "chrome" || raw === "msedge" || raw === "chromium") return raw;
  throw new ConfigValidationError(
    field,
    `expected one of chrome|msedge|chromium, got ${JSON.stringify(raw)}`,
  );
}

export function parseClawHubConfig(
  raw: unknown,
): AtomicAgentConfig["skills"]["clawhub"] {
  return parseClawHubConfigWithDefaults(raw, () => USER_CONFIG_DEFAULTS.skills.clawhub);
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
  if (
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < 1
  ) {
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
  if (
    !SUPPORTED_INPUT_VERSIONS.includes(version) &&
    version < USER_CONFIG_VERSION
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
  const web = (obj.web as Record<string, unknown> | undefined) ?? {};
  const projects = (obj.projects as Record<string, unknown> | undefined) ?? {};
  const tools = (obj.tools as Record<string, unknown> | undefined) ?? {};
  const toolsShell = (tools.shell as Record<string, unknown> | undefined) ?? {};
  const webSearch = (web.search as Record<string, unknown> | undefined) ?? {};
  const webFetch = (web.fetch as Record<string, unknown> | undefined) ?? {};
  const webSearchInputs = prepareWebSearchInputs(
    webSearch,
    () => USER_CONFIG_DEFAULTS.web.search,
  );
  const sessions = (obj.sessions as Record<string, unknown> | undefined) ?? {};
  const sessionsRetention =
    (sessions.retention as Record<string, unknown> | undefined) ?? {};
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
  const preparedMemory = prepareMemoryInputs(memory);
  const webhooks = parseWebhookMap(obj.webhooks ?? {}, "webhooks");
  const vision = (obj.vision as Record<string, unknown> | undefined) ?? {};
  const skills = (obj.skills as Record<string, unknown> | undefined) ?? {};
  const telegram = (obj.telegram as Record<string, unknown> | undefined) ?? {};
  const composio = (obj.composio as Record<string, unknown> | undefined) ?? {};
  const discord = (obj.discord as Record<string, unknown> | undefined) ?? {};
  const swarm = (obj.swarm as Record<string, unknown> | undefined) ?? {};
  const notifications =
    (obj.notifications as Record<string, unknown> | undefined) ?? {};
  const notificationsDownloads =
    (notifications.downloads as Record<string, unknown> | undefined) ?? {};
  const atomicMail =
    (obj.atomicMail as Record<string, unknown> | undefined) ?? {};
  const git = (obj.git as Record<string, unknown> | undefined) ?? {};
  const tui = (obj.tui as Record<string, unknown> | undefined) ?? {};
  const analytics =
    (obj.analytics as Record<string, unknown> | undefined) ?? {};
  const mcp = (obj.mcp as Record<string, unknown> | undefined) ?? {};

  const preparedLocalModels = prepareLocalModelsInputs(
    localModels,
    version,
    () => USER_CONFIG_DEFAULTS.localModels,
  );
  const {
    managed,
    embeddings: embeddingsDaemon,
    mode: localModelsMode,
    url: localModelsUrl,
  } = preparedLocalModels;
  let llmBlock: UserLlmFileConfig | undefined =
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

  if (version < 75 && llmBlock) {
    llmBlock = {
      ...llmBlock,
      providers: llmBlock.providers.map((provider) =>
        provider.modelMode === undefined && defaultProviderModelMode(provider) === "cloud"
          ? { ...provider, modelMode: "cloud" }
          : provider),
    };
  }

  return {
    // Spread first so a known key can never be shadowed by a stray one.
    ...unknownTopLevelKeys(obj),
    // A file from a newer build keeps its own version. Stamping ours here
    // is what turns "read a newer file" into "silently downgrade it".
    version: Math.max(version, USER_CONFIG_VERSION),
    localModels: parseUserLocalModelsConfig(
      preparedLocalModels,
      () => USER_CONFIG_DEFAULTS.localModels,
    ),
    log: {
      level: parseLogLevel(
        log.level ?? USER_CONFIG_DEFAULTS.log.level,
        "log.level",
      ),
    },
    agent: parseAgentConfig(agent, () => USER_CONFIG_DEFAULTS.agent),
    http: parseHttpConfig(http, version, () => USER_CONFIG_DEFAULTS.http),
    web: {
      search: parseWebSearchConfig(
        webSearchInputs,
        () => USER_CONFIG_DEFAULTS.web.search,
      ),
      fetch: parseWebFetchConfig(
        webFetch,
        () => USER_CONFIG_DEFAULTS.web.fetch,
      ),
    },
    projects: parseProjectsConfig(projects, () => USER_CONFIG_DEFAULTS.projects),
    tools: parseToolsConfig(toolsShell, () => USER_CONFIG_DEFAULTS.tools),
    sessions: parseSessionConfig(sessionsRetention, () => USER_CONFIG_DEFAULTS.sessions),
    tracing: parseTracingConfig(mergedTrace, () => USER_CONFIG_DEFAULTS.tracing),
    memory: parseMemoryConfig(
      preparedMemory,
      version,
      () => USER_CONFIG_DEFAULTS.memory,
    ),
    webhooks,
    vision: parseVisionConfig(vision, () => USER_CONFIG_DEFAULTS.vision),
    skills: parseSkillsConfig(skills, () => USER_CONFIG_DEFAULTS.skills),
    tui: parseTuiConfig(tui, () => USER_CONFIG_DEFAULTS.tui),
    analytics: {
      enabled: parseBool(
        analytics.enabled ?? USER_CONFIG_DEFAULTS.analytics.enabled,
        "analytics.enabled",
      ),
    },
    telegram: parseTelegramConfig(telegram, () => USER_CONFIG_DEFAULTS.telegram),
    discord: parseDiscordConfig(discord, () => USER_CONFIG_DEFAULTS.discord),
    swarm: parseSwarmConfig(swarm),
    notifications: parseNotificationsConfig(
      notificationsDownloads,
      () => USER_CONFIG_DEFAULTS.notifications,
    ),
    atomicMail: parseAtomicMailConfig(atomicMail),
    git: parseGitConfig(git, () => USER_CONFIG_DEFAULTS.git),
    composio: parseComposioConfig(composio, () => USER_CONFIG_DEFAULTS.composio),
    mcp: {
      servers: parseMcpServers(mcp.servers, "mcp.servers"),
    },
    ...(llmBlock !== undefined ? { llm: llmBlock } : {}),
  };
}

export function parseTuiNotify(raw: unknown): TuiNotifyConfig {
  return parseTuiNotifyWithDefaults(raw, () => USER_CONFIG_DEFAULTS.tui.notify);
}

export function parseOnboardingState(raw: unknown): OnboardingState {
  return parseOnboardingStateWithDefaults(raw, () => USER_CONFIG_DEFAULTS.tui.onboarding);
}
