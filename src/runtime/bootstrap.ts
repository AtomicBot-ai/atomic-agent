import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

import type { AtomicAgentConfig } from "../config/index.js";
import {
  getConfig,
  getTrustConfigPaths,
  resetConfigCache,
} from "../config/index.js";

import type { LlmStreamParams } from "../agent/step-executor.js";
import { TurnController } from "./turn-controller.js";
import { SteeringInbox } from "./steering-inbox.js";
import type { TurnEventHook, TurnOrigin } from "./turn-controller.js";
import type { ChannelStatus } from "./channel-status.js";

import { TelegramChannel } from "../channels/telegram/index.js";
import type { BotFactory } from "../channels/telegram/index.js";

import {
  McpManager,
  buildMcpPromptGetTool,
  buildMcpPromptListTool,
  buildMcpResourceListTool,
  buildMcpResourceReadTool,
  buildMcpToolDescriptors,
  createMcpSamplingHandler,
  mergeMcpDescriptors,
  applyMcpToolNameRule,
  buildMcpToolNameRule,
} from "../mcp/index.js";

import { LlamaServerClient } from "../llm/llama-server-client.js";
import type {
  CompletionResult,
  StreamChunk,
} from "../llm/llama-server-client.js";
import {
  buildGrammar,
  detectModelProfile,
  extractTotalSlots,
  ModelProfileManager,
  PLAIN_INSTRUCT_PROFILE,
} from "../llm/index.js";
import { checkProfileGrammarAligned } from "../llm/profile-invariants.js";
import { DEFAULT_SLOT_COUNT, SlotManager } from "../llm/slot-manager.js";
import { checkLlamaServer } from "../llm/llama-server-health.js";

import { ApprovalGate } from "../approval/approval-gate.js";
import type { ApprovalLevel } from "../approval/approval-level.js";
import { ApprovalRouter } from "../approval/approval-router.js";
import type { ApprovalHandler } from "../approval/approval-router.js";
import type { DangerousToolOptions } from "../approval/dangerous-tool.js";

import { ToolRegistry } from "../tools/tool-registry.js";
import { finishTool } from "../tools/finish.js";
import { replyTool } from "../tools/conversation/index.js";
import { buildBrowserTools } from "../tools/browser/index.js";
import { PlaywrightBackend } from "../tools/browser/playwright-backend.js";
import type { BrowserBackend } from "../tools/browser/browser-backend.js";
import { registerOsTools } from "../tools/os/index.js";
import { registerSkillTools } from "../tools/skill/index.js";
import { buildToolViewTool } from "../tools/tool-view/index.js";
import { registerMemoryTools } from "../tools/memory/index.js";
import { registerTaskTools } from "../tools/tasks/index.js";
import { registerVisionTools } from "../tools/vision/index.js";
import {
  type LlmProvider,
  ProviderRegistry,
  resolveLlmConfig,
} from "../llm/provider/index.js";
import { resolveActiveToolTransport } from "../llm/provider/registry/resolve-tool-transport.js";
import { catalogForProvider } from "../llm/provider/catalog-for-provider.js";
import { CostAccumulator } from "../llm/provider/cost-accumulator.js";
import {
  resolveModel,
  type ResolvedModel,
} from "../llm/provider/model-resolver.js";
import {
  ProviderFallbackChain,
  resolveFallbackChain,
} from "../llm/fallback/index.js";
import {
  createFallbackCompleter,
  createFallbackStreamer,
  type FallbackSeamDeps,
} from "./llm-fallback-seam.js";

import { MemoryStore } from "../memory/memory-store.js";
import { ProfileStore } from "../memory/profile-store.js";
import { LessonStore } from "../memory/lessons/lesson-store.js";
import { ProcedureStore } from "../memory/procedures/procedure-store.js";
import { createLessonLifecycleHook } from "../memory/lessons/lesson-lifecycle-hook.js";
import { createDefaultMemoryContextProvider } from "../memory/memory-context-provider.js";
import {
  type RewriterLlmComplete,
  createQueryRewriterRunner,
  createRewriterAwareMemoryContextProvider,
  createAlwaysGate,
  createEmbeddingGate,
  createHeuristicGate,
  DEFAULT_REWRITER_EXEMPLARS,
  type RewriterGate,
} from "../memory/retrieve/index.js";
import type { EmbeddingClient } from "../memory/embeddings/embedding-client.js";
import {
  EmbeddingStore,
  EmbeddingWriter,
  LlamaEmbeddingClient,
} from "../memory/embeddings/index.js";
import {
  getEmbeddingModelDef,
  isKnownEmbeddingModelId,
} from "../local-llm/index.js";
import {
  createReflectionRunner,
  type ReflectionLlmComplete,
  type ReflectionRunner,
  type ReflectionTraceEvent,
} from "../memory/reflection/index.js";
import {
  LinkStore,
  createLinkGeneratorRunner,
  createLinkAwareReflectionRunner,
} from "../memory/links/index.js";
import type { LinkGeneratorLlmComplete } from "../memory/links/index.js";
import { NeighborEvolver } from "../memory/evolution/index.js";
import {
  ConsolidatorJob,
  DistillRunner,
} from "../memory/consolidator/index.js";
import {
  VoteStore,
  createVoteRunner,
  createVoteAwareReflectionRunner,
} from "../memory/voting/index.js";
import type { VoteRunnerLlmComplete } from "../memory/voting/index.js";

import { SkillRegistry } from "../skills/skill-registry.js";
import { buildSkillCatalog } from "../skills/skill-catalog.js";
import { seedStarterSkillsIfMissing } from "../skills/seed-starter-skills.js";

import { DEFAULT_TOOL_DESCRIPTORS } from "../prompt/tool-descriptors.js";
import { filterToolDescriptorsByConfig } from "./filter-disabled-tools.js";
import { buildCapabilities } from "../prompt/capabilities.js";
import { minUsableContextWindow } from "../prompt/token-budget.js";
import type {
  CapabilitiesSummary,
  SkillCatalogEntry,
  ToolDescriptor,
} from "../prompt/stable-prefix.js";

import { AgentLoop } from "../agent/agent-loop.js";
import type { AgentLoopEvent, RunTurnResult } from "../agent/agent-loop.js";

import {
  SessionStore,
  createEmptySessionState,
  type SessionState,
} from "../session/index.js";

import { TaskRunner, TaskStore } from "../tasks/index.js";
import { Scheduler } from "../scheduler/index.js";
import { WebhookSessionStore } from "../http/webhook-session-store.js";

import { StructuredLogger } from "../tracing/structured-logger.js";
import type { LogSink } from "../tracing/structured-logger.js";
import { MetricsCollector } from "../tracing/metrics-collector.js";
import type { MetricSink } from "../tracing/metrics-collector.js";
import { AgentMetrics } from "../tracing/agent-metrics.js";
import {
  createNdjsonTraceSink,
  createTraceBus,
  createTraceRecorder,
  type TraceBus,
  type TraceRecorder,
  type TraceSink,
} from "../tracing/trace/index.js";

import type { ApprovalRequest } from "../approval/approval-gate.js";

import {
  AnalyticsStateStore,
  createAnalyticsClient,
  captureAppInstalled,
  captureAppOpened,
  captureMessageSent,
  captureModelConfigured,
  captureOnboardingStep,
  sanitizeModelAlias,
  TurnUsageMeter,
} from "../analytics/index.js";
import {
  createSentryClient,
  installGlobalErrorHandlers,
  captureError,
} from "../error-reporting/index.js";
import { getAppVersion } from "../version.js";

export interface RuntimeEventHandlers {
  /**
   * Global event sink, fired for every turn on every session. The
   * second argument names the session the event belongs to (from the
   * per-turn `AsyncLocalStorage` frame) so a host rendering a single
   * session — the TUI — can drop events from turns running in the
   * background instead of painting them into the wrong transcript. It
   * is absent for events emitted outside a turn frame.
   */
  onAgentEvent?: (event: AgentLoopEvent, sessionId?: string) => void;
  onApprovalRequest?: (request: ApprovalRequest) => void;
  onSkillRegistryChange?: (entries: SkillCatalogEntry[]) => void;
  /**
   * Optional sink for remote-control channel lifecycle changes (e.g.
   * Telegram). Fires on every observable transition (`starting →
   * up`, `up → down`, `disabled → starting`, …). Hosts that ignore
   * this handler keep working — the runtime never blocks on it.
   */
  onChannelStatus?: (status: ChannelStatus) => void;
  logSinks?: LogSink[];
  metricSinks?: MetricSink[];
  /**
   * Extra destinations for `TraceEvent`s produced by the recorder. Always
   * combined with the default NDJSON sink (when tracing is active) — set
   * to an empty array to keep only the on-disk sink, or pass custom sinks
   * (e.g. `createTraceNdjsonSidecarSink`) to relay traces to embedding
   * hosts.
   */
  traceSinks?: TraceSink[];
}

export interface CreateAgentRuntimeOptions {
  workingDir: string;
  /**
   * Boot value for the approval ladder (1 = ask for everything … 5 =
   * approve everything). Entry points resolve it from the persisted
   * `agent.approvalLevel` plus `--no-approval` (which forces 5); the
   * live value afterwards is owned by the ApprovalGate.
   */
  approvalLevel: ApprovalLevel;
  handlers?: RuntimeEventHandlers;
  /**
   * Default activation state for tracing when
   * `config.tracing.trace.enabled` is `null` (the default). CLI / TUI /
   * serve entry points pass `true` so local debugging is observable by
   * default; the sidecar passes `false` so embedded hosts opt in via
   * config or by providing their own sinks.
   */
  traceDefault?: boolean;
  /** Optional overrides — used by tests to inject fakes. */
  overrides?: {
    llamaComplete?: (params: LlmStreamParams) => Promise<CompletionResult>;
    /**
     * Streaming counterpart of `llamaComplete`. Tests inject a fake SSE
     * generator here; production wiring always hands a real
     * `LlamaServerClient.completeStream` through.
     */
    llamaCompleteStream?: (
      params: LlmStreamParams,
    ) => AsyncGenerator<StreamChunk, CompletionResult, void>;
    /**
     * When true, skip wiring the streaming client at all. Useful for the
     * HTTP/sidecar tests that still exercise the unary path.
     */
    disableStreaming?: boolean;
    browserBackend?: BrowserBackend;
    skipLlamaHealthCheck?: boolean;
    /**
     * Skip the blocking startup health probe and `/props` fetch but keep
     * the real `LlamaServerClient` + `ModelProfileManager` wired. The TUI
     * uses this so the chat UI renders instantly even when the managed
     * daemon has not finished starting yet; the profile manager will
     * hot-swap to the real profile on the first turn refresh once
     * `/props` starts answering.
     *
     * Mutually exclusive with `skipLlamaHealthCheck` (which also stubs
     * out the HTTP path for tests).
     */
    deferLlamaHealthCheck?: boolean;
    llamaProps?: Record<string, unknown>;
    llamaPropsError?: Error;
    /**
     * Test seam — replace the default grammy adapter used by the
     * Telegram channel. Production wiring leaves this undefined and
     * `TelegramChannel` falls back to `defaultGrammyBotFactory`.
     */
    telegramBotFactory?: BotFactory;
  };
}

export interface AgentRuntime {
  readonly config: AtomicAgentConfig;
  readonly loop: AgentLoop;
  readonly toolRegistry: ToolRegistry;
  readonly skillRegistry: SkillRegistry;
  readonly approvals: ApprovalGate;
  readonly slotManager: SlotManager;
  readonly sessionStore: SessionStore;
  /**
   * Single per-session turn-ownership primitive shared by every
   * caller of `runTurn` — CLI, TUI, HTTP, sidecar, and the future
   * scheduler. Exposed for introspection (`isBusy`,
   * `busySessionIds`) and direct enqueueing from out-of-band entry
   * points; the canonical user-facing path is `runTurn`, which
   * funnels through this controller internally.
   */
  readonly turnController: TurnController;
  /**
   * Out-of-band channel for messages sent to a session whose turn is
   * already running. `TurnController` is strictly FIFO by design, so a
   * mid-turn message would otherwise have to wait for the turn to
   * close; the inbox lets it reach the model at the next step boundary
   * instead. Prefer {@link AgentRuntime.steer} over touching this
   * directly — it is the same call with the intent documented.
   */
  readonly steeringInbox: SteeringInbox;
  /**
   * Fold `text` into the turn currently running on `sessionId`.
   *
   * Returns `false` — and queues nothing — when no running turn is
   * still able to pick the message up (no turn in flight, or the turn
   * has already done its final drain), when the text is blank, or when
   * the inbox for that session is full. A `false` return means "not
   * steered": the caller is expected to fall back to a normal
   * `runTurn`, or to its own message queue. `true` means the message is
   * either delivered at a step boundary or returned on
   * `RunTurnResult.undelivered` — never stranded. Never starts a turn
   * on its own.
   */
  steer(sessionId: string, text: string): boolean;
  /**
   * Durable user-profile store. Present even when
   * `memory.profile.enabled` is `false`, because the store owns the
   * SQLite connection used by any future feature that reuses the same
   * file. Callers should respect the config flag before writing.
   */
  readonly profileStore: ProfileStore;
  /**
   * FTS5-backed freeform notes store. Present even when
   * `memory.notes.enabled` is `false`, for the same reason as
   * `profileStore`: the class owns a SQLite connection that shares a
   * file with other memory layers and must be disposed through
   * `shutdown()`.
   */
  readonly notesStore: MemoryStore;
  /**
   * Memory-v2 phase 5. Distilled lesson store. Always present (lives
   * alongside `notesStore` in `memory.sqlite`), regardless of
   * `memory.lessons.enabled` — the agent-facing tool registration is
   * gated, but the store itself is always open so `shutdown` can
   * close it cleanly.
   */
  readonly lessonStore: LessonStore;
  /**
   * Memory-v2 phase 7b. Procedure templates store. Always
   * constructed (handle ownership) — the agent-facing tool is
   * gated on `memory.procedures.enabled` and the consolidator
   * persists procedures only when the runner is configured with
   * `withProcedure=true`.
   */
  readonly procedureStore: ProcedureStore;
  /**
   * Memory-v2 phase 2. Typed link graph store. Always present (same
   * SQLite file as `notesStore`); recall expansion and link-generator
   * are gated on `memory.links.enabled`.
   */
  readonly linkStore: LinkStore;
  /**
   * Memory-v2 phase 7a. Curation vote store. `null` when
   * `memory.voting.enabled` is `false`. Shares its SQLite handle
   * with `notesStore`, so no separate dispose is required.
   */
  readonly voteStore: VoteStore | null;
  /**
   * Durable task queue. Always present, even when `tasks.enabled` is
   * false, because the store owns its SQLite connection and must be
   * disposed through `shutdown()`. Callers should respect the config
   * flag (or the runner — `TaskRunner.drainPending` is a no-op when
   * disabled) before submitting work.
   */
  readonly taskStore: TaskStore;
  readonly taskRunner: TaskRunner;
  /**
   * Periodic scheduler that drains due tasks off the `scheduled_for`
   * index. `null` when `tasks.enabled` or `tasks.schedulerEnabled` is
   * false — tests and ops tooling can still call `taskRunner.runDue`
   * directly for a one-shot tick.
   */
  readonly scheduler: Scheduler | null;
  /**
   * Persistent mapping of webhook name -> session id, used by the
   * `POST /api/webhooks/:name` route when `sessionMode=persistent`.
   * Always present — the store is a tiny on-disk JSON file whose
   * cost is negligible even when no webhooks are configured.
   */
  readonly webhookSessionStore: WebhookSessionStore;
  /**
   * Telegram remote-control channel. **Always non-null** post slice 3B
   * — the channel is constructed unconditionally so the live-control
   * TUI panel can flip `enabled=true` (or update token / owner) without
   * restarting the host. When `config.telegram.enabled === false` at
   * boot, `start()` is *not* invoked and the channel stays in
   * `disabled` state, idle and emitting no lifecycle events. When
   * enabled, the channel owns token resolution and transitions itself
   * through `starting → up | down` on `start()`; a missing
   * `TELEGRAM_BOT_TOKEN` lands as `state: "down"`. Status is
   * propagated to hosts via `RuntimeEventHandlers.onChannelStatus`.
   * The type stays `TelegramChannel | null` for forward compatibility
   * with potential subsystem-disable flags; callers should still
   * defensively check before calling.
   */
  readonly telegramChannel: TelegramChannel | null;
  /**
   * MCP client manager. **Always non-null** — constructed even when
   * `config.mcp.servers[]` is empty so the live-control surface stays
   * uniform with the Telegram channel pattern. When no servers are
   * configured, this is a zero-cost no-op manager: `start()` returns
   * immediately, `listStatuses()` is empty, no resolver is installed.
   * Owns one `McpClient` per configured server and exposes the
   * aggregated tool / resource / prompt catalogs through
   * `runtime.mcpManager.listCatalogs()`. Shutdown is wired into the
   * runtime `shutdown()` so closing the runtime tears every client
   * down.
   */
  readonly mcpManager: McpManager;
  /**
   * Text LLM provider registry (local llama-server and cloud backends).
   * `activeText` is the provider wired into `llmComplete` / sub-calls.
   */
  readonly providerRegistry: ProviderRegistry;
  readonly capabilities: CapabilitiesSummary;
  readonly skillCatalog: readonly SkillCatalogEntry[];
  readonly toolDescriptors: readonly ToolDescriptor[];
  readonly grammar: string;
  readonly logger: StructuredLogger;
  readonly metrics: AgentMetrics;
  /**
   * Create a fresh session state (id, workingDir, optional metadata),
   * persist it, and return it. User messages are fed through `runTurn`.
   */
  createSession(input?: {
    metadata?: Record<string, unknown>;
  }): SessionState;
  /**
   * Drive one chat turn: append the user message, run the agent loop
   * until the model emits `reply` (or `finish`), persist the resulting
   * state, and return the new session + reason.
   *
   * Always funnels through `turnController.enqueue`, so concurrent
   * invocations on the same `session.id` serialise FIFO while
   * different sessions run in parallel. Callers that need to observe
   * intermediate `AgentLoopEvent`s for their turn (HTTP SSE, sidecar
   * NDJSON, future scheduler) pass an `eventHook` — events are routed
   * to the hook of the currently-running submission for that session
   * only. `origin` is informational; defaults to `"cli"`.
   */
  runTurn(
    session: SessionState,
    userMessage: string,
    options?: {
      maxSteps?: number;
      signal?: AbortSignal;
      eventHook?: TurnEventHook;
      origin?: TurnOrigin;
    },
  ): Promise<RunTurnResult>;
  /**
   * Inline counterpart to `runTurn` — runs the agent loop and
   * persists the result without acquiring the per-session lock. Use
   * this only from a `run` callback already passed to
   * `turnController.enqueue` for the same `session.id`; calling it
   * outside a controller-managed frame defeats the concurrency
   * contract and may race other turns on the session.
   *
   * The intended use case is a frontend (sidecar, HTTP) that needs
   * to perform extra work *under* the per-session lock — re-reading
   * a session mirror, updating local state — without re-entering
   * the controller and deadlocking.
   */
  executeTurn(
    session: SessionState,
    userMessage: string,
    options?: { maxSteps?: number; signal?: AbortSignal },
  ): Promise<RunTurnResult>;
  /** Refresh the skill registry after install/uninstall and rebuild the catalog. */
  refreshSkills(): Promise<void>;
  /**
   * Rebuild the GBNF grammar and the `### tools` prompt catalog from
   * the current `McpManager` state. Called by the TUI MCP panel after
   * `mcpManager.addServerLive(...)` / `removeServerLive(...)` so the
   * model can see (or stops seeing) the qualified MCP tool names on
   * the next inference without a runtime restart. Mutates the
   * `grammar` / `toolDescriptors` fields visible through the live
   * AgentLoop closure; safe to call from any thread of control —
   * `AgentLoop` reads both via late-binding getters set by bootstrap.
   *
   * KV-cache invalidation is intentional: the stable prefix changes
   * the moment the tool catalog does. This is semantically equivalent
   * to a runtime restart, just without the process churn.
   */
  refreshMcp(): Promise<void>;
  /** Merge newly-added `config.llm.providers` entries into the registry. */
  reloadLlmProviders(): Promise<void>;
  /** Rebuild one provider from the current config (TUI configure flow). */
  reloadLlmProvider(id: string): Promise<void>;
  /**
   * Register `handler` as the approval sink for `sessionId`. Every
   * `ApprovalRequest` whose `sessionId` matches will be routed to
   * `handler` instead of the host's `onApprovalRequest` fallback.
   * Returns an `unsubscribe` callback that removes the registration —
   * the unsubscribe is a no-op if a later registration has already
   * replaced this one (see `ApprovalRouter` for the locked
   * invariants). Channels that own a session (Telegram today) call
   * this so an approval prompt lands on the surface that originated
   * the turn.
   */
  setApprovalHandlerForSession(
    sessionId: string,
    handler: ApprovalHandler,
  ): () => void;
  /**
   * Hot-toggle anonymous analytics + error reporting (they share the
   * single `config.analytics.enabled` opt-out). Rebuilds the in-memory
   * PostHog / Sentry clients so the change applies without a restart.
   * Persisting the flag to `config.json` is the caller's responsibility
   * (the TUI settings tab). Idempotent.
   */
  setAnalyticsEnabled(enabled: boolean): Promise<void>;
  /**
   * Report that the first-run flow reached `step` (a closed
   * `OnboardingStep` name, never free text). `outcome` is passed only on
   * the terminal step. A no-op while analytics is off. The TUI owns the
   * flow, so it is the caller; the runtime owns the client.
   */
  reportOnboardingStep(step: string, outcome?: string): void;
  /**
   * Report that a provider was verified and saved — the install has a
   * working backend. Fires at most once per install (state-store
   * guarded); a no-op while analytics is off.
   */
  reportModelConfigured(provider: string, kind: "local" | "cloud"): void;
  /**
   * Live approval level (1 = every gated action asks … 5 = approve
   * everything). Reads the gate, not the boot-time config snapshot, so
   * it reflects `--no-approval` boots and later `setApprovalLevel`
   * calls.
   */
  getApprovalLevel(): ApprovalLevel;
  /**
   * Move the approval ladder without a restart, in either direction.
   * Out-of-range input is clamped to [1, 5]. Level 2 stops asking for
   * file writes inside the session working directory; level 3 adds
   * home-directory file operations (Trash, archive extraction) and
   * HTTP; level 4 adds guarded shell commands, skill scripts, and
   * process kills; level 5 approves everything, including browser
   * navigation to non-web URLs. Hardline shell-guard rules still block
   * outright at every level (they fire before the gate). Persisting
   * `agent.approvalLevel` to `config.json` is the caller's
   * responsibility (the TUI Privacy tab). Idempotent; pending prompts
   * are not resolved retroactively.
   */
  setApprovalLevel(level: number): void;
  /**
   * Plan mode: read-only until further notice.
   *
   * Orthogonal to the approval ladder, and deliberately so — the ladder
   * answers "does this need to ask first", plan mode answers "is this
   * the kind of thing we are doing right now". Every mutating tool is
   * refused with a message telling the model to present a plan instead;
   * every read-only tool still runs. See `agent/plan-mode.ts`.
   *
   * Session state rather than config: a "look but do not touch" that
   * survived a restart would be a mystery rather than a memory.
   */
  getPlanMode(): boolean;
  setPlanMode(on: boolean): void;
  /** Close all resources (browser, sqlite, llama client). Safe to call twice. */
  shutdown(): Promise<void>;
}

/**
 * Log hint when managed mode llama-server is down.
 * Invariant: the agent runtime never spawns llama-server — use
 * `atomic-agent models start`. Exported for unit tests.
 */
export function managedLocalLlmHealthFailureHint(port: number): string {
  const url = `http://127.0.0.1:${port}`;
  return (
    `managed llama-server not reachable at ${url} → run \`atomic-agent models start\` or, if backend/model missing, ` +
    `\`atomic-agent models update\` + \`atomic-agent models pull <id>\``
  );
}

/**
 * One-stop factory that wires the whole agent runtime. Both the CLI
 * (`atomic-agent run`) and the sidecar (`atomic-agent-sidecar`) go
 * through this function — there is no other way to construct a live
 * AgentLoop. Keeping the wiring in a single file means the two entry
 * points cannot drift in subtle ways.
 */
export async function createAgentRuntime(
  options: CreateAgentRuntimeOptions,
): Promise<AgentRuntime> {
  const config = getConfig();
  const workingDir = resolve(options.workingDir);

  const logSinks: LogSink[] = options.handlers?.logSinks ?? [];
  const metricSinks: MetricSink[] = options.handlers?.metricSinks ?? [];
  const logger = new StructuredLogger({
    level: config.log.level,
    sinks: logSinks,
  });
  const metrics = new AgentMetrics(new MetricsCollector({ sinks: metricSinks }));

  // Anonymous product analytics (PostHog). Opt-out via
  // `config.analytics.enabled = false`. The client is `null` when
  // disabled; every event carries only an anonymous install id plus
  // `{ provider, model }` — never message content, paths, args, or IP
  // (see `src/analytics/`). Fire the one-time `app_installed` event on
  // the first boot of a fresh install.
  const analyticsStateStore = new AnalyticsStateStore(
    resolve(config.paths.stateDir, "analytics.json"),
  );
  // Both clients are `let` (not `const`) so `setAnalyticsEnabled` can
  // hot-swap them without a process restart. The `runTurn` / `onEvent` /
  // `shutdown` closures read these variables at call time, so a reassign
  // is picked up on the next event.
  let analytics = createAnalyticsClient({
    enabled: config.analytics.enabled,
    installId: analyticsStateStore.getInstallId(),
    platform: process.platform,
    version: getAppVersion(),
    logger,
  });
  captureAppInstalled(analytics, analyticsStateStore);
  // Every launch, not just the first: `app_installed` alone cannot tell
  // a download that never ran from one that ran and stalled.
  captureAppOpened(analytics);

  // Anonymous error reporting (Sentry). Shares the opt-out flag
  // (`config.analytics.enabled`) and the anonymous install id with
  // product analytics. Strict allowlist: only error type / category /
  // safe scalar codes / path-stripped stack frames ever leave the
  // machine — never message content, paths, tool args, or IP (see
  // `src/error-reporting/`). `null` when disabled or the DSN is still
  // the placeholder sentinel.
  let errorReporter = createSentryClient({
    enabled: config.analytics.enabled,
    installId: analyticsStateStore.getInstallId(),
    release: getAppVersion(),
    platform: process.platform,
    logger,
  });
  // Read the current reporter lazily so a hot-toggle is reflected without
  // re-installing the process-global handlers.
  installGlobalErrorHandlers(() => errorReporter);
  // Live intent mirror for `setAnalyticsEnabled`. Tracks the operator's
  // choice, which is distinct from "is a client non-null" — the factories
  // still return `null` in test env / on a placeholder key/DSN even when
  // enabled.
  let analyticsEnabled = config.analytics.enabled;

  /**
   * Hot-toggle anonymous analytics (PostHog) and error reporting
   * (Sentry) — they share the single `config.analytics.enabled` opt-out.
   * Persisting the flag to `config.json` is the caller's job (the TUI
   * settings tab); this method only rebuilds the in-memory clients so the
   * change takes effect without a restart. Idempotent: a no-op when the
   * requested value already matches the live intent.
   */
  const setAnalyticsEnabled = async (enabled: boolean): Promise<void> => {
    if (enabled === analyticsEnabled) return;
    analyticsEnabled = enabled;
    // Tear down the previous clients (fire-safe: `shutdown` swallows its
    // own errors) before rebuilding so queued events are flushed.
    if (analytics) {
      await analytics.shutdown();
      analytics = null;
    }
    if (errorReporter) {
      await errorReporter.shutdown();
      errorReporter = null;
    }
    if (enabled) {
      analytics = createAnalyticsClient({
        enabled: true,
        installId: analyticsStateStore.getInstallId(),
        platform: process.platform,
        version: getAppVersion(),
        logger,
      });
      // Fire the one-time `app_installed` event if it never went out
      // while analytics was disabled (guarded by the state store).
      captureAppInstalled(analytics, analyticsStateStore);
      errorReporter = createSentryClient({
        enabled: true,
        installId: analyticsStateStore.getInstallId(),
        release: getAppVersion(),
        platform: process.platform,
        logger,
      });
    }
    logger.info("analytics toggled", { enabled });
  };

  // Both read `analytics` at call time, so a hot-toggle is picked up
  // without re-registering anything.
  const reportOnboardingStep = (step: string, outcome?: string): void => {
    captureOnboardingStep(analytics, step, outcome);
  };
  const reportModelConfigured = (
    provider: string,
    kind: "local" | "cloud",
  ): void => {
    captureModelConfigured(analytics, analyticsStateStore, { provider, kind });
  };

  const traceEnabled = resolveTraceEnabled(
    config.tracing.trace.enabled,
    options.traceDefault,
  );
  const traceBus = traceEnabled
    ? buildTraceBus({
        extraSinks: options.handlers?.traceSinks ?? [],
        dir: config.tracing.trace.dir,
        maxBytesPerSession: config.tracing.trace.maxBytesPerSession,
        logger,
      })
    : null;
  const recorders = new Map<string, TraceRecorder>();
  /**
   * Per-turn context used to route `loopDeps.onEvent` calls back to
   * the correct session. Two sessions running concurrently each have
   * their own `AsyncLocalStorage` frame, so the `loopDeps.onEvent`
   * closure can look up the right recorder without a process-global
   * pointer.
   */
  const turnContext = new AsyncLocalStorage<{ sessionId: string }>();
  const steeringInbox = new SteeringInbox();
  const turnController = new TurnController({
    onHookError: (err, ctxInfo) => {
      logger.warn("turn event hook threw", {
        sessionId: ctxInfo.sessionId,
        origin: ctxInfo.origin,
        error: err instanceof Error ? err.message : String(err),
      });
    },
  });

  /**
   * Single fan-out for `AgentLoopEvent`s. The loop's own `onEvent`
   * closure (built later) routes through here, and so does the provider
   * fallback chain's notice sink — a `provider_switched` event surfaces
   * exactly like any other loop event (trace recorder, TUI/HTTP/sidecar
   * event streams, host handler). Resolving the session from the per-turn
   * ALS frame keeps two concurrent sessions from cross-contaminating.
   */
  const emitAgentLoopEvent = (event: AgentLoopEvent): void => {
    const ctx = turnContext.getStore();
    if (ctx) {
      const recorder = recorders.get(ctx.sessionId);
      recorder?.onAgentEvent(event);
      turnController.emit(ctx.sessionId, event);
    }
    if (event.type === "loop_failed") {
      captureError(errorReporter, event.error, {
        source: "llm_failure",
        category: event.category,
      });
    }
    options.handlers?.onAgentEvent?.(event, ctx?.sessionId);
  };

  // Cross-provider fallover breaker. Owns no timer — every decision is
  // computed lazily from the wall clock when a turn asks for a provider
  // (AGENTS.md §"Provider fallback chain"). The notice sink lifts each
  // one-shot switch into a `provider_switched` AgentLoopEvent.
  const fallbackChain = new ProviderFallbackChain({
    resolve: () => resolveFallbackChain(resolveLlmConfig(getConfig())),
    noticeSink: (notice) =>
      emitAgentLoopEvent({ type: "provider_switched", ...notice }),
  });

  // Approval requests flow through `ApprovalRouter`: per-session
  // handlers (Telegram channel, future Slack/etc.) win, otherwise the
  // host's `onApprovalRequest` callback fires. The fallback closure
  // captures `options.handlers` once so handler-rebinding via a
  // future API would not be observed here — sessions that need a
  // different fallback should register a per-session handler instead.
  const approvalRouter = new ApprovalRouter((request) => {
    options.handlers?.onApprovalRequest?.(request);
  });
  const approvals = new ApprovalGate({
    emit: (request) => approvalRouter.emit(request),
    level: options.approvalLevel,
  });
  // Tools are registered with `approvalRequired: true` unconditionally;
  // the gate's approval level carries the boot-time value instead. Every
  // request reaches the gate with its category and the gate decides
  // (auto-approve resolves instantly without emitting a prompt), so the
  // gate stays the single live switch and `runtime.setApprovalLevel` can
  // move the ladder at runtime in both directions — tool registrations
  // copy the boolean and would otherwise freeze a boot-time value
  // forever.
  const dangerous: DangerousToolOptions = {
    approvals,
    approvalRequired: true,
  };

  if (
    !options.overrides?.skipLlamaHealthCheck &&
    !options.overrides?.deferLlamaHealthCheck &&
    !options.overrides?.llamaComplete
  ) {
    // One attempt, not the retry ladder: this probe exists to log a line,
    // and with llama down the default ladder (5 attempts, exponential
    // backoff) stalled every boot for 15.5 s before the loop then failed
    // fast anyway. The first real completion is the retry.
    const health = await checkLlamaServer({ retries: 0 });
    if (!health.reachable) {
      logger.warn("llama-server health check failed", {
        error: health.error,
        url: config.localModels.url,
      });
      if (config.localModels.mode === "managed") {
        logger.warn(managedLocalLlmHealthFailureHint(config.localModels.managed.port), {
          mode: "managed",
        });
      }
    } else {
      logger.info("llama-server reachable", {
        url: config.localModels.url,
        latencyMs: health.latencyMs,
      });
    }
  } else if (options.overrides?.deferLlamaHealthCheck) {
    logger.info("llama-server health check deferred; runtime will refresh on first turn", {
      url: config.localModels.url,
    });
  }

  const llama = new LlamaServerClient();
  const { profile, modelAlias, totalSlots } = await resolveModelProfile(
    options.overrides,
    llama,
    logger,
    config.localModels.url,
  );
  const slotManager = new SlotManager(totalSlots ?? undefined);
  if (totalSlots !== null) {
    logger.info("slot manager configured from /props", {
      totalSlots,
      url: config.localModels.url,
    });
  } else {
    // Managed mode always defers the boot probe (the daemon may not be up
    // yet), so this is the normal path there. `ModelProfileManager` calls
    // `slotManager.resize()` on its first successful `/props` refresh at
    // turn start; until then the pool is the single slot every
    // llama-server is guaranteed to have.
    logger.info("slot manager using conservative default (probe deferred)", {
      slotCount: DEFAULT_SLOT_COUNT,
    });
  }

  // A context window that cannot hold the fixed prompt plus a full
  // generation budget makes every step come back `truncated` — the model
  // burns its remaining tokens and never closes a tool-call array. Loud
  // at startup because the failure mode downstream is silent.
  const minUsableCtx = minUsableContextWindow(
    config.localModels.completionMaxTokens,
  );
  if (profile.contextWindow && profile.contextWindow < minUsableCtx) {
    logger.warn("context window too small for the agent prompt", {
      contextWindow: profile.contextWindow,
      required: minUsableCtx,
      completionMaxTokens: config.localModels.completionMaxTokens,
      hint:
        config.localModels.mode === "managed"
          ? "raise localModels.managed.contextSize, lower localModels.completionMaxTokens, or pick a model that fits VRAM"
          : "start llama-server with a larger --ctx-size, or lower localModels.completionMaxTokens",
    });
  }

  const browserBackend: BrowserBackend =
    options.overrides?.browserBackend ??
    new PlaywrightBackend({
      userDataDir: config.paths.browserProfileDir,
      channel: config.browser.channel,
      executablePath: config.browser.executablePath,
      headless: config.browser.headless,
      noSandbox: config.browser.noSandbox,
      launchTimeoutMs: config.browser.launchTimeoutMs,
      cdpUrl: config.browser.cdpUrl,
    });

  await seedStarterSkillsIfMissing({
    globalSkillsDir: config.paths.globalSkillsDir,
    logger,
  });

  const skillRegistry = new SkillRegistry(
    {
      globalDir: config.paths.globalSkillsDir,
      projectDir: join(workingDir, config.paths.projectSkillsDirName),
    },
    config.skills.disabled,
  );
  await skillRegistry.refresh();
  for (const e of skillRegistry.errors()) {
    logger.warn("skill registry: skipped skill directory", {
      path: e.path,
      error: e.error,
    });
  }

  const capabilities = await buildCapabilities({
    workingDir,
    browserChannel: config.browser.channel,
  });

  // Memory-v2 phase 7a — fail-fast clamp/decay validation. The
  // config schema already enforces these ranges, but bootstrap
  // re-asserts so a hand-edited `config.json` with a v16 marker but
  // garbage values cannot smuggle invalid voting params past the
  // runtime. Scenario 7a.C.3 ("bootstrap fails fast on invalid
  // clamp") is pinned by `consolidator-vote.test.ts` indirectly via
  // the schema test, but the explicit guard here covers the
  // post-load codepath where `validateConfigFile` is bypassed.
  if (config.memory.voting.enabled) {
    if (
      !Number.isInteger(config.memory.voting.maxVotePerItem) ||
      config.memory.voting.maxVotePerItem <= 0
    ) {
      throw new Error(
        `bootstrap: memory.voting.maxVotePerItem must be a positive integer (got ${config.memory.voting.maxVotePerItem})`,
      );
    }
    const sd = config.memory.voting.signalDecay;
    if (!(sd > 0 && sd <= 1)) {
      throw new Error(
        `bootstrap: memory.voting.signalDecay must be in (0, 1] (got ${sd})`,
      );
    }
    const sb = config.memory.voting.scoreBlend;
    if (!(sb >= 0 && sb <= 1)) {
      throw new Error(
        `bootstrap: memory.voting.scoreBlend must be in [0, 1] (got ${sb})`,
      );
    }
  }
  // TODO(memory-v2): cross-phase invariant 4 — the consolidator
  // (phase 5) registers with the existing `Scheduler` here, not via a
  // new `setInterval`. Bootstrap also gains a check from phase 5
  // onwards: assert `memory.dedup.fts5Threshold ≤
  // memory.consolidation.similarityThreshold` (§13.7.3 / invariant 14),
  // fail-fast on violation.
  const profileStore = new ProfileStore({
    dbFile: config.paths.memoryDbFile,
    metrics,
  });
  const notesStore = new MemoryStore({
    dbFile: config.paths.memoryDbFile,
    maxEntries: config.memory.notes.maxEntries,
    dedup: {
      enabled: config.memory.dedup.enabled,
      fts5Threshold: config.memory.dedup.fts5Threshold,
    },
    eviction: {
      utilityWeighted: config.memory.eviction.utilityWeighted,
      maxAgeMs: config.memory.eviction.maxAgeMs,
    },
    metrics,
  });

  // Memory-v2 phase 1B. Embedding plumbing — opt-in, graceful
  // degradation. Conditions to wire it up (in order):
  //
  //   1. Both feature flags on: `memory.embeddings.enabled` AND
  //      `localModels.embeddings.enabled`. Either off ⇒ FTS5-only.
  //   2. A valid embedding model id is configured.
  //   3. Probe `localModels.embeddings.url` for `/health`. Daemon
  //      down ⇒ FTS5-only (logged + counted as `disabled`, not as a
  //      failure — runtime keeps booting).
  //
  // The probe runs in the bootstrap critical path with a short
  // timeout so a stale lockfile / stuck daemon cannot wedge the
  // entire startup. Failure is observability-only: we never throw.
  let embeddingHealth: "ok" | "unreachable" | "disabled" = "disabled";
  let embeddingClient: EmbeddingClient | null = null;
  if (
    config.memory.embeddings.enabled &&
    config.localModels.embeddings.enabled &&
    config.localModels.embeddings.modelId !== null &&
    isKnownEmbeddingModelId(config.localModels.embeddings.modelId)
  ) {
    const embModelDef = getEmbeddingModelDef(
      config.localModels.embeddings.modelId,
    );
    const embUrl = config.localModels.embeddings.url;
    const probe = await checkLlamaServer({
      url: embUrl,
      retries: 0,
      backoffMs: 0,
      timeoutMs: 2000,
    }).catch(() => ({ reachable: false }));
    if (probe.reachable) {
      try {
        const client = new LlamaEmbeddingClient({
          url: embUrl,
          dim: embModelDef.dim,
          model: embModelDef.id,
        });
        embeddingClient = client;
        const embStore = new EmbeddingStore({
          db: notesStore.getDatabaseHandleForEmbeddings(),
        });
        const writer = new EmbeddingWriter({
          client,
          store: embStore,
          metrics,
        });
        notesStore.attachEmbeddings({ writer, store: embStore });
        embeddingHealth = "ok";
      } catch (e) {
        // Construction errors here are pure programmer error
        // (constructor validation): log + degrade, never throw.
        process.stderr.write(
          `memory-v2 phase 1B: failed to wire embedding client: ${
            e instanceof Error ? e.message : String(e)
          }\n`,
        );
        embeddingHealth = "unreachable";
      }
    } else {
      embeddingHealth = "unreachable";
      process.stderr.write(
        `memory-v2 phase 1B: embedding daemon at ${embUrl} is unreachable; ` +
          `hybrid recall disabled, FTS5-only path active.\n`,
      );
    }
    metrics.recordMemoryEmbeddingsDaemonHealth({
      outcome: embeddingHealth,
      model: embModelDef.id,
    });
  } else {
    metrics.recordMemoryEmbeddingsDaemonHealth({
      outcome: "disabled",
      model: null,
    });
  }

  // Memory-v2 phase 2. The link graph store rides the same memory.sqlite
  // handle as `notesStore` — `MemoryStore` already enabled
  // `foreign_keys = ON` so the cascade fires on `memories.remove(id)`.
  // The store is always constructed (the table exists from schema v6
  // onwards); the agent-facing recall expansion + link-generator
  // sub-call are independently gated on `memory.links.enabled` /
  // `memory.links.autoGenerate`.
  const linkStore = new LinkStore({
    db: notesStore.getDatabaseHandleForEmbeddings(),
  });

  // Memory-v2 phase 5. `LessonStore` is always constructed when the
  // schema is present (v8+) — the agent-facing tool registration is
  // gated on `memory.lessons.enabled`, and the consolidator is
  // additionally gated on `memory.consolidation.enabled`. Keeping the
  // handle open even when both switches are off is intentional: the
  // SQLite connection lives next to `MemoryStore` / `ProfileStore` /
  // `LinkStore` in the same file and must be closed in `shutdown`.
  const lessonStore = new LessonStore({
    dbFile: config.paths.memoryDbFile,
    maxEntries: config.memory.lessons.maxEntries,
    metrics,
  });

  // Memory-v2 phase 7b. `ProcedureStore` shares the same SQLite handle
  // as `MemoryStore`; the `procedures` table sits next to `memories`,
  // `lessons`, and `profile_facts`. Always constructed when the schema
  // (v10+) is present so the handle has one owner — the agent-facing
  // tool registration + consolidator wiring are independently gated
  // on `memory.procedures.enabled`.
  const procedureStore = new ProcedureStore({
    dbFile: config.paths.memoryDbFile,
    maxEntries: config.memory.procedures.maxEntries,
    metrics,
  });

  // Memory-v2 phase 7a. `VoteStore` shares the same SQLite handle as
  // the `MemoryStore` (the `vote_score` columns live on the same
  // tables it owns), so there is no separate file to close in
  // `shutdown`. It is always constructed when `memory.voting.enabled`
  // is on; the rest of the wiring (reflection decorator, consolidator
  // dep) is conditional on the same flag.
  const voteStore: VoteStore | null = config.memory.voting.enabled
    ? new VoteStore({
        db: notesStore.getDatabaseHandleForEmbeddings(),
      })
    : null;

  // Constructed before the tool registry: `os.fs.locate_project`
  // (issue #77) reads recent-session working dirs through the
  // column-only `listRecentWorkingDirs` projection, so the store must
  // exist by the time `registerOsTools` wires the closure below.
  const sessionStore = new SessionStore();

  const toolRegistry = new ToolRegistry();
  toolRegistry.register(finishTool);
  toolRegistry.register(replyTool);
  if (config.browser.enabled) {
    for (const tool of buildBrowserTools(browserBackend, dangerous)) {
      toolRegistry.register(tool);
    }
  }
  registerOsTools(toolRegistry, {
    ...dangerous,
    config: { http: config.http, web: config.web, projects: config.projects },
    listRecentSessionDirs: (limit) => sessionStore.listRecentWorkingDirs(limit),
    // The trust surface (`config.json` + `.env`) is resolved once, here,
    // and injected into the fs tools — the tools layer must not know
    // where it lives. Pinned by the level-4 `trust_config` case in
    // bootstrap.test.ts.
    trustConfigPaths: getTrustConfigPaths(config.paths),
  });
  registerSkillTools(toolRegistry, skillRegistry, dangerous);
  toolRegistry.register(buildToolViewTool());
  registerMemoryTools(toolRegistry, {
    profileStore,
    profileEnabled: config.memory.profile.enabled,
    notesStore,
    notesEnabled: config.memory.notes.enabled,
    notesRecallDefaultK: config.memory.notes.recallDefaultK,
    notesMaxContentChars: config.memory.notes.maxContentChars,
    lessonStore,
    lessonsEnabled: config.memory.lessons.enabled,
    procedureStore,
    proceduresEnabled: config.memory.procedures.enabled,
  });

  // Vision provider wiring is deferred until after `profileManager` is
  // built so the provider can read the **current** model profile
  // through a getter instead of capturing a (potentially stale)
  // `plain-instruct` fallback at construction time. See
  // `LlamaServerProvider.capabilities` for the rationale.

  let skillCatalog: readonly SkillCatalogEntry[] = buildSkillCatalog(
    skillRegistry.list(),
  );

  let grammar = await buildGrammar(profile, config.paths.grammarsDir, {
    browserEnabled: config.browser.enabled,
  });
  const grammarViolations = checkProfileGrammarAligned(profile, grammar);
  if (grammarViolations.length > 0) {
    logger.warn("profile/grammar invariant violated", {
      profile: profile.id,
      violations: grammarViolations,
    });
  }

  // Install a hot-swap manager only when the runtime is bound to a real
  // llama-server. Tests that inject `llamaComplete` or `llamaProps*`
  // stub out the HTTP layer and must keep the static profile/grammar
  // pair they already configured.
  const profileManager = shouldInstallProfileManager(options.overrides)
    ? new ModelProfileManager({
        llama,
        initialProfile: profile,
        initialGrammar: grammar,
        initialModelId: modelAlias,
        grammarsDir: config.paths.grammarsDir,
        browserEnabled: config.browser.enabled,
        onTotalSlots: (discovered) => {
          if (discovered === slotManager.getSlotCount()) return;
          logger.info("slot pool resized from /props", {
            from: slotManager.getSlotCount(),
            to: discovered,
          });
          slotManager.resize(discovered);
        },
        logger,
      })
    : undefined;

  const getLiveProfile = () => profileManager?.getProfile() ?? profile;

  const providerRegistry = await ProviderRegistry.fromConfig(config, {
    config,
    llamaClient: llama,
    getProfile: getLiveProfile,
    logger,
  });

  /**
   * Re-read on every inference so TUI `setActive` hot-swap takes effect.
   * `providerId` overrides which provider is used for this call — the
   * fallback chain passes the chosen link's id; transport/adapter/slot
   * affinity are then resolved for THAT provider, not the active one. An
   * unknown id degrades to the active provider (a raced config edit).
   */
  const resolveActiveLlmSlice = (providerId?: string) => {
    const fresh = getConfig();
    const resolved = resolveLlmConfig(fresh);
    const provider =
      (providerId ? providerRegistry.getProvider(providerId) : undefined) ??
      providerRegistry.activeText;
    return {
      provider,
      transport: resolveActiveToolTransport(resolved, provider),
      adapter: provider.toolCallAdapter ?? null,
      slotAffinity: provider.capabilities.supportsSlotAffinity,
      parallelTools: provider.capabilities.supportsParallelTools,
    };
  };

  /**
   * Real model identifier for analytics. Cloud providers carry the model
   * in their config entry (`defaultChatModel` / `model`). Local llama-server
   * has no model name in its synthesized `local-llama` entry, so we prefer
   * the managed GGUF id (`localModels.managed.modelId`); in external mode
   * (no GGUF id) we fall back to the sanitized operator `--alias`
   * (`/props.model_alias`). The detected profile id (e.g. `plain-instruct`)
   * is only a last-resort fallback — it names the prompt profile, not the
   * model, so it must never be the primary source.
   */
  const resolveActiveModelName = (): string => {
    const liveConfig = getConfig();
    const resolved = resolveLlmConfig(liveConfig);
    const entry = resolved.providers.find(
      (p) => p.id === resolved.activeTextProvider,
    );
    return (
      entry?.defaultChatModel ??
      entry?.model ??
      liveConfig.localModels.managed.modelId ??
      sanitizeModelAlias(modelAlias) ??
      getLiveProfile().id
    );
  };

  const bootstrapLlmSlice = resolveActiveLlmSlice();
  const textProvider = bootstrapLlmSlice.provider;
  const costAccumulator =
    config.llm?.costTracking?.enabled === true
      ? new CostAccumulator(config.llm.costTracking.dailyResetHourUtc ?? 0)
      : undefined;

  // Product analytics: token/spend totals for the turn currently in
  // flight. Unlike `costAccumulator`, which is opt-in behind
  // `costTracking.enabled`, this is always on, because `message_sent`
  // should carry the shape of a turn for every install — and it stays
  // behind the same analytics opt-out, since nothing is emitted unless
  // `captureMessageSent` fires.
  const turnUsageMeter = new TurnUsageMeter();

  /**
   * Pricing for a model id on the active provider, when any is known.
   *
   * Two sources, in `resolveModel`'s own precedence: a hand-configured
   * `userModels[].pricing` first, then the provider's bundled catalog.
   * The catalog is what makes cost work out of the box on OpenRouter and
   * aimlapi, whose published prices ship with the agent; without it only
   * operators who priced their models by hand ever saw a `cost_usd`.
   *
   * Local runners still resolve to no pricing, which is why turn cost is
   * reported as absent rather than zero for them.
   */
  const resolveModelPricing = (
    modelId: string | null,
  ): ResolvedModel | undefined => {
    if (!modelId) return undefined;
    const resolved = resolveLlmConfig(getConfig());
    const entry = resolved.providers.find(
      (p) => p.id === resolved.activeTextProvider,
    );
    if (!entry) return undefined;
    return resolveModel(entry, modelId, catalogForProvider(entry));
  };

  // Vision reuses the active text provider when it exposes describeImage.
  const visionProvider: LlmProvider | undefined = config.vision.enabled
    ? textProvider
    : undefined;
  registerVisionTools(toolRegistry, {
    provider: visionProvider,
    enabled: config.vision.enabled,
    maxImagesPerCall: config.vision.maxImagesPerCall,
    maxImageBytes: config.vision.maxImageBytes,
  });
  // MCP client subsystem. The manager is always constructed so the
  // live-control surface (TUI panel, slash commands — planned) stays
  // uniform with the Telegram channel pattern. An empty
  // `config.mcp.servers[]` produces a zero-cost no-op manager.
  //
  // We start the manager **before** the descriptor filter + grammar
  // rule application so the prompt + GBNF reflect the live catalog
  // exactly. Each `McpClient` is bounded by a 15s connect timeout,
  // and failures are isolated per-server — one broken config never
  // blocks bootstrap. Catalog growth after this point (hot-add
  // server) requires a rebuild of the stable prefix / grammar
  // (currently a runtime restart — see AGENTS.md §"MCP client").
  const mcpServerConfigs = config.mcp?.servers ?? [];
  const mcpEnabled = mcpServerConfigs.length > 0;
  const mcpManager = new McpManager(mcpServerConfigs, {
    toolRegistry,
    logger,
    // Sampling handler is per-client; we install one for every
    // connecting server so the SDK advertises the capability. Routes
    // to LlamaServerClient with `slotId: -1` (invariant 1 in
    // `mcp-sampling-handler.ts`).
    samplingHandler: mcpEnabled
      ? createMcpSamplingHandler({
          llamaServerClient: llama,
          server: "*",
        })
      : undefined,
    ...(options.handlers?.onChannelStatus
      ? {
          onStatus: (status) =>
            options.handlers!.onChannelStatus!({
              channel: `mcp:${status.name}`,
              state: status.state,
              ...(status.lastError ? { lastError: status.lastError } : {}),
            }),
        }
      : {}),
  });
  // The four meta-tools (`mcp.resources.{list,read}` /
  // `mcp.prompts.{list,get}`) read aggregated state from `mcpManager`.
  // They are safe to register even when zero servers are connected
  // — the manager returns empty aggregates and the tools fail with a
  // structured "no server" error if invoked. Registering them
  // unconditionally lets the live-add path (variant γ) skip a
  // first-server-only branch.
  let mcpMetaToolsRegistered = false;
  const registerMcpMetaToolsOnce = (): void => {
    if (mcpMetaToolsRegistered) return;
    toolRegistry.register(buildMcpResourceListTool(mcpManager));
    toolRegistry.register(buildMcpResourceReadTool(mcpManager));
    toolRegistry.register(buildMcpPromptListTool(mcpManager));
    toolRegistry.register(buildMcpPromptGetTool(mcpManager));
    mcpMetaToolsRegistered = true;
  };
  // Baseline grammar without MCP tool names — kept around so
  // `refreshMcp()` can rebuild from the same starting point regardless
  // of what the current MCP catalog looks like. `applyMcpToolNameRule`
  // is purely additive on top of this baseline.
  const baseGrammar = grammar;
  if (mcpEnabled) {
    await mcpManager.start();
    registerMcpMetaToolsOnce();
    const mcpToolMetas = mcpManager.listAllToolMeta();
    const rule = buildMcpToolNameRule(mcpToolMetas);
    grammar = applyMcpToolNameRule(baseGrammar, rule);
    logger.info("mcp: manager started", {
      configured: mcpServerConfigs.length,
      connected: mcpManager.listStatuses().filter((s) => s.state === "up").length,
      tools: mcpToolMetas.length,
    });
  }

  // The descriptor stays in the prompt whenever the operator wired a
  // vision provider — even before the profile probe lands. The
  // descriptor blurb already says "Only available when the active
  // model + provider support multimodal input"; if the user asks for
  // image work before mmproj is loaded, the tool surfaces a clear
  // `VisionUnsupportedError` instead of silently disappearing from
  // the toolset.
  // Drop descriptors whose backing tool will not be registered at
  // runtime under the current config gates. Without this filter the
  // stable prefix advertises tools that the registry rejects on
  // first invocation — see `filter-disabled-tools.ts` for the full
  // mapping. The historical inline `vision.describe` filter is now
  // one entry in that table; behaviour for vision is unchanged.
  // Live-MCP support: every input that varies with the MCP catalog
  // (descriptor list + grammar) is rebuildable via the helper below.
  // The closure captures everything else (vision/memory/tasks gates,
  // baseline grammar, etc.) so `refreshMcp()` can re-run it after a
  // server is added or removed at runtime without touching the rest.
  const rebuildToolDescriptorsFromMcp = (): readonly ToolDescriptor[] => {
    const liveMcpEnabled = mcpManager.listServerNames().length > 0;
    const base = filterToolDescriptorsByConfig(DEFAULT_TOOL_DESCRIPTORS, {
      browser: { enabled: config.browser.enabled },
      web: { search: { enabled: config.web.search.enabled } },
      vision: {
        enabled: config.vision.enabled,
        providerAvailable: visionProvider !== undefined,
      },
      memory: {
        profile: { enabled: config.memory.profile.enabled },
        notes: { enabled: config.memory.notes.enabled },
        lessons: { enabled: config.memory.lessons.enabled },
        procedures: { enabled: config.memory.procedures.enabled },
      },
      tasks: {
        agentToolsEnabled:
          config.tasks.enabled && config.tasks.agentToolsEnabled,
      },
      mcp: { enabled: liveMcpEnabled },
    });
    if (!liveMcpEnabled) return base;
    return mergeMcpDescriptors(
      base,
      buildMcpToolDescriptors(mcpManager.listAllToolMeta()),
    );
  };
  let effectiveToolDescriptors = rebuildToolDescriptorsFromMcp();
  if (config.vision.enabled) {
    logger.info("vision provider configured", {
      provider: visionProvider?.name ?? "(none)",
      autoDetect: config.vision.autoDetect,
      registeredAtBootstrap: visionProvider !== undefined,
    });
  }

  // Fold a unary completion's usage into cost + meter. Lifted out of the
  // seam so the fallback loop + `servedTransport` stamp live in the
  // testable `llm-fallback-seam` module (which knows nothing about cost
  // tracking). The per-provider retry budget (PR #90) still runs one
  // level below, inside `provider.complete`, so the breaker only ever
  // sees an error after those retries are spent.
  const recordUnaryUsage = (
    params: LlmStreamParams,
    result: CompletionResult,
  ): void => {
    if (!result.usage) return;
    const model = resolveModelPricing(result.modelId);
    if (costAccumulator) {
      costAccumulator.recordTurn({
        modelId: result.modelId,
        usage: result.usage,
        ...(model ? { model } : {}),
      });
    }
    if (params.sessionId) {
      turnUsageMeter.record({
        sessionId: params.sessionId,
        usage: result.usage,
        ...(model ? { model } : {}),
      });
    }
  };

  const recordStreamUsage = (
    sessionId: string | undefined,
    result: CompletionResult,
  ): void => {
    if (!result.usage || !sessionId) return;
    const model = resolveModelPricing(result.modelId);
    turnUsageMeter.record({
      sessionId,
      usage: result.usage,
      ...(model ? { model } : {}),
    });
  };

  const fallbackSeamDeps: FallbackSeamDeps = {
    fallbackChain,
    resolveSlice: (providerId) => {
      const { provider, transport } = resolveActiveLlmSlice(providerId);
      return { provider, transport };
    },
    recordUnaryUsage,
    recordStreamUsage,
  };

  const llmComplete =
    options.overrides?.llamaComplete ??
    createFallbackCompleter(fallbackSeamDeps);

  const llmCompleteStream = options.overrides?.disableStreaming
    ? undefined
    : options.overrides?.llamaCompleteStream ??
      (options.overrides?.llamaComplete
        ? undefined
        : createFallbackStreamer(fallbackSeamDeps));

  const taskStore = new TaskStore({ dbFile: config.paths.tasksDbFile });
  const webhookSessionStore = new WebhookSessionStore(
    resolve(config.paths.stateDir, "webhook-sessions.json"),
  );
  const recoveredStale = taskStore.recoverStale(config.tasks.staleAfterMs);
  if (recoveredStale > 0) {
    logger.info("recovered stale running tasks on bootstrap", {
      count: recoveredStale,
      thresholdMs: config.tasks.staleAfterMs,
    });
  }

  // Memory-v2 phase 3. The neighbor-evolver writes parsed EVOLVE
  // directives back into `MemoryStore` after notes are stored.
  // Construction is unconditional but cheap; the runner is only
  // **wired into reflection** when the feature flag is on, so the
  // evolver itself is harmless when present-but-not-used.
  const neighborEvolver = config.memory.evolution.enabled
    ? new NeighborEvolver({
        memoryStore: notesStore,
        maxPerWrite: config.memory.evolution.maxPerWrite,
        leaseMs: config.memory.evolution.leaseMs,
        logger,
        metrics,
      })
    : undefined;

  const baseReflectionRunner = buildReflectionRunner({
    config,
    slotManager,
    llmComplete,
    toolTransport: bootstrapLlmSlice.transport,
    profileStore,
    notesStore,
    logger,
    metrics,
    ...(neighborEvolver ? { neighborEvolver } : {}),
    // Per-session trace emission. The recorder map is keyed by
    // sessionId; reflection fires fire-and-forget after
    // `turn_finished`, so a missing recorder is a normal "tracing
    // disabled for this session" outcome, not an error.
    emitTrace: (event: ReflectionTraceEvent) => {
      const recorder = recorders.get(event.sessionId);
      if (!recorder) return;
      recorder.recordReflection({
        outcome: event.outcome,
        ...(typeof event.factsWritten === "number"
          ? { factsWritten: event.factsWritten }
          : {}),
        ...(typeof event.notesWritten === "number"
          ? { notesWritten: event.notesWritten }
          : {}),
        ...(event.reason ? { reason: event.reason } : {}),
      });
    },
  });

  // Memory-v2 phase 2. Compose the base reflection runner with the
  // link-generator sub-call when the feature flag + auto-generation
  // are both on. The wrapper keeps the agent-loop call site
  // unchanged (it still calls `reflectionRunner.reflect(input)`); the
  // link-generator fires after the base runner returns, using
  // `input.recalledMemoryIds` as the allowlist.
  //
  // The link-generator rides the **same** `reflectionSlotId` as the
  // base reflection (cross-phase invariant 2). When the base runner
  // is absent (memory.reflection disabled), link-generation is also
  // skipped — we never want to spawn an LLM call just for the graph.
  let reflectionRunner: ReflectionRunner | undefined = baseReflectionRunner;
  if (
    baseReflectionRunner &&
    config.memory.links.enabled &&
    config.memory.links.autoGenerate
  ) {
    const reservedSlot = slotManager.reserveReflectionSlot();
    const reflectionSlotId = reservedSlot ?? -1;
    const linkGenLlmComplete: LinkGeneratorLlmComplete = async (params) => {
      if (params.signal.aborted) {
        throw new DOMException("aborted", "AbortError");
      }
      const abortPromise = new Promise<never>((_, reject) => {
        params.signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
      const completionPromise = llmComplete({
        prompt: params.prompt,
        grammar: params.grammar,
        slotId: params.slotId,
        sessionId: params.sessionId,
        ...(params.responseFormat
          ? { responseFormat: params.responseFormat }
          : {}),
      });
      return Promise.race([completionPromise, abortPromise]);
    };
    const linkGenerator = createLinkGeneratorRunner({
      llmComplete: linkGenLlmComplete,
      linkStore,
      reflectionSlotId,
      timeoutMs: config.memory.links.generatorTimeoutMs,
      maxLinksPerCall: config.memory.links.maxLinksPerCall,
      minCandidates: config.memory.links.minCandidates,
      logger,
      metrics,
      // Per-session trace emission — same resolve-by-sessionId
      // pattern as reflection / vote.
      emitTrace: (event) => {
        const recorder = recorders.get(event.sessionId);
        if (!recorder) return;
        recorder.recordLinkGenerator({
          outcome: event.outcome,
          ...(typeof event.linksWritten === "number"
            ? { linksWritten: event.linksWritten }
            : {}),
          ...(event.reason ? { reason: event.reason } : {}),
        });
      },
    });
    reflectionRunner = createLinkAwareReflectionRunner({
      reflection: baseReflectionRunner,
      linkGenerator,
      notesStore,
      minCandidates: config.memory.links.minCandidates,
    });
  }

  // Memory-v2 phase 7a. Decorate the reflection runner with the
  // vote-runner sub-call so curation runs after `SET` / `NOTE` /
  // link-gen / `EVOLVE`. The decorator is fire-safe: a failed
  // vote-runner never breaks the reflection chain. Wiring only
  // proceeds when:
  //   - The base reflection chain is wired.
  //   - `memory.voting.enabled` (carries the VoteStore).
  // The vote-runner rides the **same** reflection slot as the
  // upstream chain (cross-phase invariant 2). Allowlist is
  // sourced from `ReflectionInput.{recalledIds, recalledLessonIds,
  // recalledProfileFactIds}` populated by `agent-loop.runTurn`
  // from `memory-context-provider` and `LessonStore.recall` —
  // anti-feedback-loop guardrail (invariant 18).
  if (reflectionRunner && voteStore) {
    const reservedSlot = slotManager.reserveReflectionSlot();
    const voteSlotId = reservedSlot ?? -1;
    const voteLlmComplete: VoteRunnerLlmComplete = async (params) => {
      if (params.signal.aborted) {
        throw new DOMException("aborted", "AbortError");
      }
      const abortPromise = new Promise<never>((_, reject) => {
        params.signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
      const completionPromise = llmComplete({
        prompt: params.prompt,
        grammar: params.grammar,
        slotId: params.slotId,
        sessionId: params.sessionId,
        ...(params.responseFormat
          ? { responseFormat: params.responseFormat }
          : {}),
      });
      return Promise.race([completionPromise, abortPromise]);
    };
    const voteRunner = createVoteRunner({
      llmComplete: voteLlmComplete,
      voteStore,
      reflectionSlotId: voteSlotId,
      timeoutMs: config.memory.reflection.timeoutMs,
      maxVotePerItem: config.memory.voting.maxVotePerItem,
      eventLogMaxRows: config.memory.voting.eventLogMaxRows,
      logger,
      metrics,
      // Memory-v2 phase 7a — wire trace emission through the
      // per-session recorder owned by the runtime. The recorder
      // map (`recorders`) is keyed by sessionId; we resolve it
      // lazily on every event so a session created after the
      // runtime booted is still observable. Reflection runs
      // fire-and-forget after `turn_finished`, so a missing
      // recorder is a normal "tracing disabled for this session"
      // outcome, not an error.
      emitTrace: (event) => {
        const recorder = recorders.get(event.sessionId);
        if (!recorder) return;
        if (event.type === "applied") {
          recorder.recordVoteApplied({
            kind: event.kind,
            targetId: event.targetId,
            direction: event.direction,
            score: event.score,
            clampHit: event.clampHit,
          });
        } else {
          recorder.recordVoteRejected({
            kind: event.kind,
            targetId: event.targetId,
            direction: event.direction,
            reason: event.reason,
          });
        }
      },
    });
    reflectionRunner = createVoteAwareReflectionRunner({
      reflection: reflectionRunner,
      voteRunner,
      memoryStore: notesStore,
      lessonStore,
      profileStore,
      procedureStore: config.memory.procedures.enabled ? procedureStore : null,
    });
  }

  // Read-side counterpart of reflection: pre-step recall injection and
  // memory-index pointer rendering. Wired only when `memory.notes` is
  // enabled — otherwise the runtime has nothing to read from and the
  // prompt tail skips both sections.
  const baseMemoryContextProvider = config.memory.notes.enabled
    ? createDefaultMemoryContextProvider({
        store: notesStore,
        recall: {
          enabled: config.memory.recallInjection.enabled,
          k: config.memory.recallInjection.k,
        },
        index: {
          enabled: config.memory.index.enabled,
          limit: config.memory.index.limit,
          previewChars: config.memory.index.previewChars,
        },
        // Memory-v2 phase 2: read-side BFS expansion. Falls back to a
        // no-op when the feature flag is off, so phase 1B callers stay
        // byte-identical.
        ...(config.memory.links.enabled
          ? {
              links: {
                enabled: true,
                store: linkStore,
                depth: config.memory.links.expansionDepth,
                maxExpanded: config.memory.links.maxExpanded,
              },
              metrics,
            }
          : {}),
        // Memory-v2 phase 5: surface lesson pointers in `### lessons`.
        // When `memory.lessons.enabled=false`, the provider skips the
        // call entirely and `recalledLessons` stays empty — the prompt
        // renderer then omits the section header.
        ...(config.memory.lessons.enabled
          ? {
              lessons: {
                enabled: true,
                store: lessonStore,
                k: config.memory.lessons.recallK,
              },
            }
          : {}),
        // Memory-v2 phase 7b. Surface advisory procedure pointers
        // in `### procedures`. Same gating story as lessons —
        // when disabled, the renderer omits the header.
        ...(config.memory.procedures.enabled
          ? {
              procedures: {
                enabled: true,
                store: procedureStore,
                k: config.memory.procedures.recallK,
              },
            }
          : {}),
      })
    : undefined;

  // v2.5 heuristic-gated query rewriter (Phase A, config v18).
  // When enabled, wrap the default provider with a decorator that
  // rewrites referential follow-ups via an LLM call on `slotId=-1`
  // before delegating recall. Disabled-by-default contract: when the
  // flag is off, `memoryContextProvider` is byte-identical to the
  // pre-v18 chain.
  let memoryContextProvider = baseMemoryContextProvider;
  if (baseMemoryContextProvider && config.memory.retrieve.rewriter.enabled) {
    const rewriterLlmComplete: RewriterLlmComplete = async (params) => {
      if (params.signal.aborted) {
        throw new DOMException("aborted", "AbortError");
      }
      const abortPromise = new Promise<never>((_, reject) => {
        params.signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
      const completionPromise = llmComplete({
        prompt: params.prompt,
        grammar: params.grammar,
        slotId: params.slotId,
        sessionId: params.sessionId,
        ...(params.responseFormat
          ? { responseFormat: params.responseFormat }
          : {}),
      });
      return Promise.race([completionPromise, abortPromise]);
    };
    const rewriterCfg = config.memory.retrieve.rewriter;
    let gate: RewriterGate;
    if (rewriterCfg.gateMode === "embedding") {
      if (embeddingClient) {
        gate = createEmbeddingGate({
          embedder: embeddingClient,
          exemplars:
            rewriterCfg.embeddingGate.exemplars ?? DEFAULT_REWRITER_EXEMPLARS,
          threshold: rewriterCfg.embeddingGate.threshold,
          logger,
          metrics,
        });
      } else {
        logger.warn?.(
          "rewriter.gateMode=embedding but no embeddingClient — falling back to heuristic",
        );
        gate = createHeuristicGate();
      }
    } else if (rewriterCfg.gateMode === "always") {
      gate = createAlwaysGate();
    } else {
      gate = createHeuristicGate();
    }
    const rewriterRunner = createQueryRewriterRunner({
      llmComplete: rewriterLlmComplete,
      timeoutMs: rewriterCfg.timeoutMs,
      gate,
      logger,
      metrics,
      // Per-session trace emission — the rewriter runs during
      // `refreshMemoryContext`, so the recorder for this session may
      // not exist yet on the very first turn; a missing recorder is a
      // normal "tracing disabled" outcome.
      emitTrace: (event) => {
        const recorder = recorders.get(event.sessionId);
        if (!recorder) return;
        recorder.recordQueryRewriter({ outcome: event.outcome });
      },
    });
    memoryContextProvider = createRewriterAwareMemoryContextProvider({
      inner: baseMemoryContextProvider,
      rewriter: rewriterRunner,
      historyTurns: config.memory.retrieve.rewriter.historyTurns,
    });
  }

  // Plan mode. Session state, deliberately not config: it is a stance
  // for the next few turns, not a setting, and a "look but do not touch"
  // that survived a restart would be a mystery rather than a memory.
  let planMode = false;

  // The `skillCatalog` is a getter so that `agent-loop` reads the current
  // value on every step — `refreshSkills()` then does not require tearing
  // down the loop.
  const loopDeps = {
    registry: toolRegistry,
    // A getter, so `runtime.setPlanMode` is observed by the next tool
    // call rather than by the next process. Same reason the approval
    // gate is the single live switch rather than a boolean copied into
    // each tool registration.
    isPlanMode: () => planMode,
    slotManager,
    grammar,
    llmComplete,
    // Mid-turn steering: the loop drains this at every step boundary.
    steeringInbox,
    ...(llmCompleteStream ? { llmCompleteStream } : {}),
    toolDescriptors: effectiveToolDescriptors,
    capabilities,
    profile,
    ...(profileManager ? { profileManager } : {}),
    ...(config.memory.profile.enabled
      ? { profileFactsProvider: () => profileStore.list() }
      : {}),
    ...(reflectionRunner ? { reflectionRunner } : {}),
    // v2.5 (Phase B). Sliding-window reflection
    // segmentation. When `enabled`, the agent loop defers
    // reflection to every Nth turn (with a final-flush on
    // `finish`) and packs the last W user/assistant pairs into the
    // reflection prompt. Disabled by default — legacy per-reply
    // single-pair behaviour is byte-stable when the block is
    // omitted.
    ...(config.memory.reflection.segmentation.enabled &&
    reflectionRunner !== undefined
      ? {
          reflectionSegmentation: {
            enabled: true,
            triggerEveryTurns:
              config.memory.reflection.segmentation.triggerEveryTurns,
            windowTurns:
              config.memory.reflection.segmentation.windowTurns,
          },
        }
      : {}),
    ...(memoryContextProvider ? { memoryContextProvider } : {}),
    // Memory-v2 phase 6 — lesson lifecycle hook. Bumps
    // `success_count` / `failure_count` on every surfaced lesson at
    // the end of each turn (reply/finish → success, failed →
    // failure; cancelled/max_steps → skip). Gated on
    // `memory.lessons.enabled` since a disabled lesson surface
    // means there is nothing to bump.
    ...(config.memory.lessons.enabled
      ? {
          lessonLifecycle: createLessonLifecycleHook({
            lessonStore,
            logger,
          }),
        }
      : {}),
    // The loop has no awareness of which session it is currently driving;
    // `emitAgentLoopEvent` resolves that from the per-turn ALS frame so
    // two concurrent sessions never cross-contaminate trace records or
    // per-submission hooks, and reports terminal LLM failures to Sentry.
    onEvent: emitAgentLoopEvent,
    metrics,
    logger,
  };
  Object.defineProperty(loopDeps, "skillCatalog", {
    enumerable: true,
    get: () => skillCatalog,
  });
  // Late-binding getters for the MCP-driven fields. `grammar` and
  // `toolDescriptors` are recomputed by `runtime.refreshMcp()` after a
  // server is live-added or live-removed via the TUI MCP panel. The
  // AgentLoop reads both on every step so the rebuilt values land on
  // the next inference without restarting the loop.
  Object.defineProperty(loopDeps, "grammar", {
    enumerable: true,
    get: () => grammar,
  });
  Object.defineProperty(loopDeps, "toolDescriptors", {
    enumerable: true,
    get: () => effectiveToolDescriptors,
  });
  Object.defineProperty(loopDeps, "toolTransport", {
    enumerable: true,
    get: () => resolveActiveLlmSlice().transport,
  });
  Object.defineProperty(loopDeps, "toolCallAdapter", {
    enumerable: true,
    get: () => resolveActiveLlmSlice().adapter,
  });
  Object.defineProperty(loopDeps, "supportsSlotAffinity", {
    enumerable: true,
    get: () => resolveActiveLlmSlice().slotAffinity,
  });
  Object.defineProperty(loopDeps, "supportsParallelTools", {
    enumerable: true,
    get: () => resolveActiveLlmSlice().parallelTools,
  });
  const loop = new AgentLoop(
    loopDeps as typeof loopDeps & {
      skillCatalog: readonly SkillCatalogEntry[];
      grammar: string;
      toolDescriptors: readonly ToolDescriptor[];
    },
  );

  // Forward declaration: the Telegram channel is constructed after the
  // runtime body assembles (it needs a stable `runtime` reference) but
  // `shutdown` must be able to stop it before tearing down the session
  // store. The variable is bound in the `let` slot below; the closure
  // resolves it lazily so the order-of-construction concern is local.
  let telegramChannelForShutdown: TelegramChannel | null = null;
  let shutdownCalled = false;
  const shutdown = async (): Promise<void> => {
    if (shutdownCalled) return;
    shutdownCalled = true;
    // Nothing will drain the inbox after this point; drop pending
    // steers so a message cannot resurface in a later process.
    steeringInbox.clearAll();
    // Cancel any in-flight reflection before tearing down the profile
    // store — otherwise a late-arriving completion could try to write
    // into a closed SQLite connection.
    try {
      reflectionRunner?.abortPending();
    } catch {
      // runner already disposed
    }
    if (telegramChannelForShutdown) {
      try {
        await telegramChannelForShutdown.stop();
      } catch (err) {
        logger.warn("telegram: shutdown failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    try {
      // MCP manager closes every connected `McpClient` (transport
      // + sampling handler) and clears the dynamic resource-class
      // resolver. Best-effort: per-server close errors are
      // swallowed inside the manager.
      await mcpManager.shutdown();
    } catch (err) {
      logger.warn("mcp: shutdown failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      await browserBackend.shutdown();
    } catch (err) {
      logger.warn("browser shutdown failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      sessionStore.close();
    } catch {
      // already closed
    }
    try {
      profileStore.close();
    } catch {
      // already closed
    }
    try {
      // Memory-v2 phase 5. LessonStore owns its own SQLite handle on
      // the same `memory.sqlite` file as MemoryStore / ProfileStore /
      // LinkStore — close before letting the process exit so WAL
      // checkpointing finishes cleanly.
      lessonStore.close();
    } catch {
      // already closed
    }
    try {
      // Memory-v2 phase 7b. ProcedureStore owns its own SQLite
      // handle on the same `memory.sqlite` file. Close it before
      // notesStore so all derived stores release their connection
      // pre-WAL checkpoint.
      procedureStore.close();
    } catch {
      // already closed
    }
    try {
      notesStore.close();
    } catch {
      // already closed
    }
    if (scheduler) {
      try {
        await scheduler.stop();
      } catch (err) {
        logger.warn("scheduler stop failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (consolidatorJob) {
      try {
        await consolidatorJob.stop();
      } catch (err) {
        logger.warn("consolidator stop failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    try {
      taskStore.close();
    } catch {
      // already closed
    }
    // Flush any queued analytics events before the process exits.
    // Fire-safe: `shutdown()` swallows its own errors.
    if (analytics) {
      await analytics.shutdown();
    }
    // Flush any queued error reports before the process exits.
    if (errorReporter) {
      await errorReporter.shutdown();
    }
  };

  const refreshSkills = async (): Promise<void> => {
    await skillRegistry.refresh();
    for (const e of skillRegistry.errors()) {
      logger.warn("skill registry: skipped skill directory", {
        path: e.path,
        error: e.error,
      });
    }
    skillCatalog = buildSkillCatalog(skillRegistry.list());
    options.handlers?.onSkillRegistryChange?.([...skillCatalog]);
  };

  /**
   * Rebuild the GBNF grammar and the prompt's `### tools` catalog from
   * the live `mcpManager` state. Called by the TUI MCP orchestrator
   * after `addServerLive` / `removeServerLive`. Idempotent — safe to
   * call when nothing changed (just re-runs the same builders).
   *
   * If MCP has just transitioned from "no servers" to "≥1 server", we
   * register the four MCP meta-tools on demand (they were skipped at
   * bootstrap to keep the descriptor catalog clean).
   */
  const refreshMcp = async (): Promise<void> => {
    const serverCount = mcpManager.listServerNames().length;
    if (serverCount > 0) {
      registerMcpMetaToolsOnce();
    }
    const metas = mcpManager.listAllToolMeta();
    const rule = buildMcpToolNameRule(metas);
    grammar = applyMcpToolNameRule(baseGrammar, rule);
    effectiveToolDescriptors = rebuildToolDescriptorsFromMcp();
    logger.info("mcp: catalog refreshed", {
      servers: serverCount,
      tools: metas.length,
    });
  };

  const llmProviderCtx = {
    config: getConfig(),
    llamaClient: llama,
    getProfile: getLiveProfile,
    logger,
  };

  const reloadLlmProviders = async (): Promise<void> => {
    resetConfigCache();
    const fresh = getConfig();
    llmProviderCtx.config = fresh;
    const added = await providerRegistry.mergeProvidersFromConfig(fresh, {
      config: fresh,
      llamaClient: llama,
      getProfile: getLiveProfile,
      logger,
    });
    if (added.length > 0) {
      logger.info("llm: providers registered", { ids: added.join(",") });
    }
  };

  const reloadLlmProvider = async (id: string): Promise<void> => {
    resetConfigCache();
    const fresh = getConfig();
    llmProviderCtx.config = fresh;
    await providerRegistry.replaceProviderFromConfig(id, fresh, {
      config: fresh,
      llamaClient: llama,
      getProfile: getLiveProfile,
      logger,
    });
    logger.info("llm: provider refreshed", { id });
  };

  const ensureRecorder = (session: SessionState): TraceRecorder | null => {
    if (!traceBus) return null;
    const existing = recorders.get(session.id);
    if (existing) return existing;
    const recorder = createTraceRecorder({
      sessionId: session.id,
      emit: (event) => traceBus.emit(event),
    });
    recorder.beginSession({
      workingDir: session.workingDir,
      ...(session.metadata ? { metadata: session.metadata } : {}),
    });
    recorders.set(session.id, recorder);
    return recorder;
  };

  const createSession = (
    input: { metadata?: Record<string, unknown> } = {},
  ): SessionState => {
    const state = createEmptySessionState({
      id: `s-${randomUUID()}`,
      workingDir,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
    sessionStore.save(state);
    ensureRecorder(state);
    return state;
  };

  const executeTurn = async (
    session: SessionState,
    userMessage: string,
    runOptions: { maxSteps?: number; signal?: AbortSignal } = {},
  ): Promise<RunTurnResult> => {
    ensureRecorder(session);
    return turnContext.run({ sessionId: session.id }, async () => {
      const result = await loop.runTurn(session, {
        userMessage,
        maxSteps: runOptions.maxSteps ?? config.agent.maxSteps,
        signal: runOptions.signal ?? new AbortController().signal,
      });
      sessionStore.save(result.session);
      return result;
    });
  };

  /**
   * Public entry point for mid-turn steering. Deliberately does NOT
   * enqueue: the whole point is to reach the turn that is already
   * running, and going through `turnController` would put the message
   * behind it.
   *
   * One call, one decision. It deliberately does NOT pre-check
   * `turnController.isBusy`: that is a second fact which stops being
   * true at a different moment than "the loop will drain this again"
   * (the loop's final drain happens inside `runTurn`, `busy.delete`
   * later in the controller's `finally`). Guarding on it made this a
   * check-then-act with a real lost-update window — accepted here,
   * never delivered, and resurfacing at step 0 of some later turn under
   * a "while you were working" notice about a turn that had already
   * ended. `push` alone is authoritative: it accepts only while the
   * running turn's window is open, and that window is closed by the
   * same call that performs the final drain.
   */
  const steer = (sessionId: string, text: string): boolean =>
    steeringInbox.push(sessionId, text);

  const runTurn = async (
    session: SessionState,
    userMessage: string,
    runOptions: {
      maxSteps?: number;
      signal?: AbortSignal;
      eventHook?: TurnEventHook;
      origin?: TurnOrigin;
    } = {},
  ): Promise<RunTurnResult> => {
    const origin = runOptions.origin ?? "cli";
    const submission = {
      sessionId: session.id,
      origin,
      // Re-read the freshest stored session when the queue hands over
      // the lock, not when the caller enqueued: between those moments a
      // turn from another origin (scheduler, HTTP, a TUI thread the
      // operator backgrounded) can finish and save, and running on the
      // caller's snapshot would make whichever turn saves last clobber
      // the other's transcript. This is the contract's own rule — never
      // hold a stale `SessionState` between enqueue and run; re-read
      // inside the queued callback (§"Concurrency contract"). A session
      // the store cannot answer for (never persisted, or deleted while
      // parked) falls back to the caller's copy, the pre-existing
      // behaviour.
      run: () =>
        executeTurn(
          sessionStore.load(session.id) ?? session,
          userMessage,
          runOptions,
        ),
      ...(runOptions.eventHook ? { eventHook: runOptions.eventHook } : {}),
      ...(runOptions.signal ? { signal: runOptions.signal } : {}),
    } as const;

    // Product analytics: count only human-originated turns. Scheduler-
    // driven turns (durable tasks, cron, webhook ingress) are excluded
    // — they are not "a person sending a message". We measure the turn's
    // wall-clock duration (`latency_ms`) plus non-content shape metrics
    // (`step_count`, `outcome`), and emit whether the turn resolves or
    // throws — a failed/aborted turn is still a real "message sent"
    // attempt. On throw we have no result, so only `outcome: "failed"`
    // is known. `captureMessageSent` no-ops when analytics is disabled
    // and also fires the one-time `first_message_sent`.
    if (origin === "scheduler") {
      return turnController.enqueue(submission);
    }
    const startedAt = Date.now();
    turnUsageMeter.begin(session.id);
    try {
      const result = await turnController.enqueue(submission);
      captureMessageSent(analytics, analyticsStateStore, {
        provider: providerRegistry.activeText.name,
        model: resolveActiveModelName(),
        latencyMs: Date.now() - startedAt,
        stepCount: result.stepCount,
        outcome: result.reason,
        ...turnUsageMeter.snapshot(session.id),
      });
      return result;
    } catch (error) {
      captureMessageSent(analytics, analyticsStateStore, {
        provider: providerRegistry.activeText.name,
        model: resolveActiveModelName(),
        latencyMs: Date.now() - startedAt,
        outcome: "failed",
        ...turnUsageMeter.snapshot(session.id),
      });
      throw error;
    }
  };

  const taskRunner = new TaskRunner({
    store: taskStore,
    runtime: { runTurn },
    sessionLoader: sessionStore,
    sessionFactory: {
      create: (input) => createSession(input ?? {}),
      save: (state) => sessionStore.save(state),
    },
    defaultMaxSteps: config.agent.maxSteps,
    backoff: {
      initialMs: config.tasks.backoffInitialMs,
      maxMs: config.tasks.backoffMaxMs,
    },
    enabled: config.tasks.enabled,
    runOnCreate: config.tasks.runOnCreate,
    // Telegram is the only `TaskNotifyTarget` today, so the runner's
    // single sink IS the Telegram route (a second target would turn
    // this into a per-target dispatch). The channel is constructed
    // after the runner — it needs the finished runtime object — so the
    // sink resolves the same live reference the shutdown path uses,
    // assigned further below, at delivery time. A report that fires in
    // the window before that assignment (a due task on an early
    // scheduler tick while bootstrap is still, e.g., awaiting MCP
    // connects) is warn-logged and dropped, never lost silently; skips
    // never affect the task's own status, and the runner isolates sink
    // rejections. Skip-path logging is pinned by the sink's own unit
    // tests in telegram-channel.test.ts.
    reportSink: TelegramChannel.buildTaskReportSink({
      resolveChannel: () => telegramChannelForShutdown,
      logger,
    }),
    logger,
    metrics,
  });

  registerTaskTools(toolRegistry, {
    taskStore,
    taskRunner,
    createSession,
    agentToolsEnabled:
      config.tasks.enabled && config.tasks.agentToolsEnabled,
    defaultMaxAttempts: config.tasks.maxAttempts,
    defaultListLimit: 20,
  });

  const scheduler =
    config.tasks.enabled && config.tasks.schedulerEnabled
      ? new Scheduler({
          taskRunner,
          tickMs: config.tasks.schedulerTickMs,
          batch: config.tasks.schedulerBatch,
          logger,
          metrics,
        })
      : null;
  // `scheduler?.start()` is deliberately deferred until after the
  // Telegram channel object is constructed (near the end of bootstrap)
  // so a task report from the very first due tick can never observe a
  // missing channel — a not-yet-`up` channel queues reports itself.
  // The only cost is that overdue tasks fire their first tick a few
  // seconds later on a cold start; the tick cadence is unchanged.

  // Memory-v2 phase 5: cold-path consolidator. Owns its own
  // `setInterval` (scoped carve-out from "Scheduler is the only
  // periodic timer" invariant — analogous to the Telegram polling
  // carve-out). Started only when `memory.consolidation.enabled` is
  // true AND a reflection-slot llmComplete is available. Distillation
  // shares the reflection slot reserved above for link-generation;
  // when no slot was reserved (memory.reflection disabled or only one
  // llama-server slot) we fall back to slotId=-1 (no KV-cache reuse).
  let consolidatorJob: ConsolidatorJob | null = null;
  if (
    config.memory.lessons.enabled &&
    config.memory.consolidation.enabled
  ) {
    // One monotonic counter shared by every consolidator-origin trace
    // event (distill outcome + lesson/procedure deprecation) so the
    // synthetic `consolidator.ndjson` file stays totally ordered across
    // all event types within a tick. The consolidator does not run
    // through a per-session recorder, so we own the `seq` here.
    let consolidatorSeq = 0;
    // Reserve (or piggy-back on) the reflection slot for the distill
    // call. The slot is per-runtime, not per-job, so calling
    // `reserveReflectionSlot` again here is idempotent — the slot
    // manager returns the same id.
    const distillSlot = slotManager.reserveReflectionSlot() ?? -1;
    const distillLlmComplete: ReflectionLlmComplete = async (params) => {
      if (params.signal.aborted) {
        throw new DOMException("aborted", "AbortError");
      }
      const abortPromise = new Promise<never>((_, reject) => {
        params.signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
      const completionPromise = llmComplete({
        prompt: params.prompt,
        grammar: params.grammar,
        slotId: params.slotId,
        sessionId: params.sessionId,
        ...(params.responseFormat
          ? { responseFormat: params.responseFormat }
          : {}),
      });
      return Promise.race([completionPromise, abortPromise]);
    };
    const distillRunner = new DistillRunner({
      llmComplete: distillLlmComplete,
      slotId: distillSlot,
      timeoutMs: config.memory.consolidation.distillTimeoutMs,
      logger,
      metrics,
      // Cold-path trace emission. The consolidator does not run through
      // a per-session recorder, so we emit straight onto the bus with
      // the synthetic `consolidator` sessionId and the shared cold-path
      // `seq`. No-op when tracing is disabled.
      ...(traceBus
        ? {
            emitTrace: (event) => {
              traceBus.emit({
                type: "distill",
                sessionId: "consolidator",
                seq: consolidatorSeq++,
                ts: Date.now(),
                outcome: event.outcome,
                ...(typeof event.clusterSize === "number"
                  ? { clusterSize: event.clusterSize }
                  : {}),
                ...(typeof event.hasProcedure === "boolean"
                  ? { hasProcedure: event.hasProcedure }
                  : {}),
                ...(event.reason ? { reason: event.reason } : {}),
              });
            },
          }
        : {}),
      // Memory-v2 phase 7b — emit a combined LESSON+PROCEDURE
      // response when procedures are enabled. The grammar still
      // permits the procedure half to be empty (conceptual
      // clusters), so this stays the safe default-on once the
      // feature is configured. Cross-phase invariant 21: this
      // does **not** add a second LLM call.
      withProcedure: config.memory.procedures.enabled,
    });
    consolidatorJob = new ConsolidatorJob(
      {
        enabled: true,
        intervalMs: config.memory.consolidation.intervalMs,
        cooldownMs: config.memory.consolidation.cooldownMs,
        minClusterSize: config.memory.consolidation.minClusterSize,
        maxClustersPerTick:
          config.memory.consolidation.maxClustersPerTick,
        requireSharedTag: config.memory.consolidation.requireSharedTag,
        consolidationLeaseMs: 60_000,
        // Memory-v2 phase 6 — wire the age-based deprecation
        // threshold and the per-tick deprecation cap. Both come
        // from `memory.lessons.*` since they govern lesson rows.
        // `maxEntries` is held inside the `LessonStore` itself
        // (already passed via `LessonStoreOptions`) and surfaces
        // through `pickOverflowForDeprecation()`.
        deprecationAgeMs: config.memory.lessons.deprecationAgeMs,
        maxDeprecationsPerTick: 100,
        // Memory-v2 phase 7a — vote-driven decay runs once per
        // tick (cross-phase invariant 23). `0` here disables both
        // the decay pass and the vote-driven deprecation sweep
        // even if the `voteStore` dep is present, so the master
        // switch is honoured without re-checking `enabled` deep
        // inside the job.
        voteSignalDecay: config.memory.voting.enabled
          ? config.memory.voting.signalDecay
          : 0,
        // Memory-v2 phase 7b — procedure age threshold and cascade
        // hook live behind the procedures master switch.
        ...(config.memory.procedures.enabled
          ? {
              procedureDeprecationAgeMs:
                config.memory.procedures.deprecationAgeMs,
            }
          : {}),
      },
      {
        memoryStore: notesStore,
        linkStore,
        lessonStore,
        distillRunner,
        metrics,
        logger,
        ...(config.memory.procedures.enabled ? { procedureStore } : {}),
        ...(voteStore ? { voteStore } : {}),
        // Memory-v2 phase 6. Bridge the sweep's per-lesson demotion
        // callback to the trace bus. The consolidator runs
        // out-of-band so we use the synthetic `consolidator`
        // session id (matching the one the DistillRunner uses).
        // The bus fans out to the NDJSON sink which writes to
        // `<stateDir>/traces/consolidator.ndjson` — a dedicated
        // cold-path log keyed by sessionId. A local `seq` counter
        // keeps the file monotonically ordered; per-session
        // counters are recorder-owned, but the consolidator does
        // not run through a recorder.
        ...(traceBus
          ? ((): {
              onLessonDeprecated: (event: {
                lessonId: number;
                reason: string;
              }) => void;
              onProcedureCreated?: (event: {
                procedureId: number;
                parentLessonIds: readonly number[];
                parentMemoryIds: readonly number[];
                source: "consolidator" | "manual";
              }) => void;
              onProcedureDeprecated?: (event: {
                procedureId: number;
                reason: string;
              }) => void;
            } => {
              // Shares the hoisted `consolidatorSeq` declared above so
              // distill + lesson/procedure events stay ordered in the
              // same cold-path NDJSON file.
              return {
                onLessonDeprecated: ({ lessonId, reason }) =>
                  traceBus.emit({
                    type: "lesson_deprecated",
                    sessionId: "consolidator",
                    seq: consolidatorSeq++,
                    ts: Date.now(),
                    lessonId,
                    reason,
                  }),
                ...(config.memory.procedures.enabled
                  ? {
                      onProcedureCreated: ({
                        procedureId,
                        parentLessonIds,
                        parentMemoryIds,
                        source,
                      }) =>
                        traceBus.emit({
                          type: "procedure_created",
                          sessionId: "consolidator",
                          seq: consolidatorSeq++,
                          ts: Date.now(),
                          procedureId,
                          parentLessonIds: [...parentLessonIds],
                          parentMemoryIds: [...parentMemoryIds],
                          source,
                        }),
                      onProcedureDeprecated: ({ procedureId, reason }) =>
                        traceBus.emit({
                          type: "procedure_deprecated",
                          sessionId: "consolidator",
                          seq: consolidatorSeq++,
                          ts: Date.now(),
                          procedureId,
                          reason,
                        }),
                    }
                  : {}),
              };
            })()
          : {}),
      },
    );
    consolidatorJob.start();
  }

  const runtime = {
    config,
    loop,
    toolRegistry,
    skillRegistry,
    approvals,
    slotManager,
    sessionStore,
    turnController,
    steeringInbox,
    steer,
    profileStore,
    notesStore,
    lessonStore,
    procedureStore,
    linkStore,
    voteStore,
    taskStore,
    taskRunner,
    scheduler,
    webhookSessionStore,
    telegramChannel: null,
    mcpManager,
    providerRegistry,
    capabilities,
    toolDescriptors: effectiveToolDescriptors,
    grammar,
    logger,
    metrics,
    createSession,
    runTurn,
    executeTurn,
    refreshSkills,
    refreshMcp,
    reloadLlmProviders,
    reloadLlmProvider,
    setApprovalHandlerForSession: (sessionId, handler) =>
      approvalRouter.setForSession(sessionId, handler),
    setAnalyticsEnabled,
    reportOnboardingStep,
    reportModelConfigured,
    getApprovalLevel: () => approvals.getLevel(),
    setApprovalLevel: (level) => approvals.setLevel(level),
    getPlanMode: () => planMode,
    setPlanMode: (on: boolean) => {
      planMode = on;
    },
    shutdown,
  } as AgentRuntime & { telegramChannel: TelegramChannel | null };
  Object.defineProperty(runtime, "skillCatalog", {
    enumerable: true,
    get: () => skillCatalog,
  });

  // Telegram remote-control channel. The channel is always constructed
  // (even when `telegram.enabled === false` at boot) so slice-3B
  // live-control surfaces can flip it on without restarting the host —
  // the constructor is side-effect-free, only `start()` opens the
  // network connection. The channel owns token resolution end-to-end
  // (reads `TELEGRAM_BOT_TOKEN` from the env on construction);
  // bootstrap deliberately does not look at the env var so it stays
  // agnostic of telegram-specific naming. `start()` is fired-and-
  // forgotten so a slow `getMe` probe never delays the first user
  // turn; when `enabled=true` but no token is present, the channel
  // transitions to `down` with `lastError: "missing
  // TELEGRAM_BOT_TOKEN"`.
  const telegramChannel = new TelegramChannel({
    runtime,
    config,
    logger,
    metrics,
    emitStatus: (status) => options.handlers?.onChannelStatus?.(status),
    ...(options.overrides?.telegramBotFactory
      ? { botFactory: options.overrides.telegramBotFactory }
      : {}),
  });
  runtime.telegramChannel = telegramChannel;
  telegramChannelForShutdown = telegramChannel;
  if (config.telegram.enabled) {
    void telegramChannel.start().catch((err) => {
      logger.error("telegram: start() rejected unexpectedly", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // Deferred from the Scheduler construction site above: the first
  // due tick must not race the Telegram channel construction, so task
  // reports always find the channel object (and queue on it while it
  // is still starting).
  scheduler?.start();

  return runtime;
}

interface ResolvedModelProfile {
  profile: ReturnType<typeof detectModelProfile>;
  /** `/props.model_alias` verbatim, or `null` on fallback / probe miss. */
  modelAlias: string | null;
  /**
   * `/props.total_slots` when the probe succeeded. `null` means the probe
   * was skipped or failed; the caller should fall back to the SlotManager
   * default. Used to keep the in-process slot pool in sync with the server
   * so `slot_id` values we send always exist physically.
   */
  totalSlots: number | null;
}

async function resolveModelProfile(
  overrides: CreateAgentRuntimeOptions["overrides"] | undefined,
  llama: LlamaServerClient,
  logger: StructuredLogger,
  llamaUrl: string,
): Promise<ResolvedModelProfile> {
  if (overrides?.llamaPropsError) {
    logger.warn("model profile probe failed; using plain fallback", {
      error: overrides.llamaPropsError.message,
      url: llamaUrl,
    });
    return {
      profile: PLAIN_INSTRUCT_PROFILE,
      modelAlias: null,
      totalSlots: null,
    };
  }
  if (overrides?.llamaProps) {
    return logResolvedProfile(overrides.llamaProps, logger);
  }
  if (
    overrides?.llamaComplete ||
    overrides?.skipLlamaHealthCheck ||
    overrides?.deferLlamaHealthCheck
  ) {
    return {
      profile: PLAIN_INSTRUCT_PROFILE,
      modelAlias: null,
      totalSlots: null,
    };
  }
  try {
    const props = await llama.fetchProps();
    return logResolvedProfile(props, logger);
  } catch (error) {
    logger.warn("model profile probe failed; using plain fallback", {
      error: error instanceof Error ? error.message : String(error),
      url: llamaUrl,
    });
    return {
      profile: PLAIN_INSTRUCT_PROFILE,
      modelAlias: null,
      totalSlots: null,
    };
  }
}

function logResolvedProfile(
  props: Record<string, unknown>,
  logger: StructuredLogger,
): ResolvedModelProfile {
  const resolved = detectModelProfile(props);
  const alias = typeof props.model_alias === "string" ? props.model_alias : null;
  const totalSlots = extractTotalSlots(props);
  logger.info("model profile resolved", {
    id: resolved.id,
    alias,
    contextWindow: resolved.contextWindow ?? null,
    totalSlots,
  });
  return { profile: resolved, modelAlias: alias, totalSlots };
}

/**
 * Only wire the hot-swap manager when the runtime actually talks to a
 * real llama-server. Any test override that replaces the HTTP layer
 * (fake completions, pre-canned `/props`, or an explicit probe-failure
 * simulation) keeps the legacy static-profile wiring so existing fakes
 * do not need to stand up a fresh `fetchProps` stub.
 */
function shouldInstallProfileManager(
  overrides: CreateAgentRuntimeOptions["overrides"] | undefined,
): boolean {
  if (!overrides) return true;
  if (overrides.llamaComplete) return false;
  if (overrides.llamaProps) return false;
  if (overrides.llamaPropsError) return false;
  if (overrides.skipLlamaHealthCheck) return false;
  return true;
}

/**
 * Resolve the effective trace toggle. The config value wins when explicit
 * (`true` / `false`); otherwise the entry-point default decides (CLI is
 * `true`, sidecar is `false`, absent defaults to `false`).
 */
function resolveTraceEnabled(
  fromConfig: boolean | null,
  fromEntryPoint: boolean | undefined,
): boolean {
  if (fromConfig !== null) return fromConfig;
  return fromEntryPoint ?? false;
}

/**
 * Instantiate the async end-of-turn reflection runner when memory +
 * reflection are enabled in config. Reserves a dedicated slot from the
 * shared `SlotManager` so the main agent's KV cache is never evicted by
 * a reflection call. Falls back to `slotId: -1` (no slot affinity) when
 * the llama-server is configured with only one slot — reflection still
 * runs, it just doesn't get its own prefix cache reuse.
 *
 * Returns `undefined` (wiring skipped) when either memory layer is
 * disabled — the AgentLoop then behaves exactly as before the
 * reflection feature was introduced.
 */
function buildReflectionRunner(args: {
  config: AtomicAgentConfig;
  slotManager: SlotManager;
  llmComplete: (params: LlmStreamParams) => Promise<CompletionResult>;
  toolTransport?: import("../llm/provider/completion-types.js").ToolCallTransport;
  profileStore: ProfileStore;
  /**
   * Freeform notes store. Wired only when both `memory.notes.enabled`
   * and `memory.reflection.autoStoreNotes` are true — otherwise the
   * runner falls back to profile-only extraction and the NOTE channel
   * is silently dropped.
   */
  notesStore: MemoryStore;
  /** Memory-v2 phase 3. Optional; when omitted EVOLVE is dropped. */
  neighborEvolver?: NeighborEvolver;
  /**
   * Optional per-call trace sink. Bootstrap resolves the per-session
   * `TraceRecorder` by `event.sessionId` and forwards to
   * `recordReflection`.
   */
  emitTrace?: (event: ReflectionTraceEvent) => void;
  logger: StructuredLogger;
  metrics: AgentMetrics;
}): ReflectionRunner | undefined {
  const memory = args.config.memory;
  if (!memory.profile.enabled || !memory.reflection.enabled) return undefined;
  const reservedSlot = args.slotManager.reserveReflectionSlot();
  const reflectionSlotId = reservedSlot ?? -1;
  if (reservedSlot === null) {
    args.logger.warn(
      "reflection slot unavailable; reflection will run without slot affinity",
      { fallbackSlotId: reflectionSlotId },
    );
  }
  const reflectionLlmComplete: ReflectionLlmComplete = async (params) => {
    if (params.signal.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    const abortPromise = new Promise<never>((_, reject) => {
      params.signal.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    });
    const { signal: _signal, ...rest } = params;
    const completionPromise = args.llmComplete(rest);
    return Promise.race([completionPromise, abortPromise]);
  };
  const notesWriteEnabled =
    memory.notes.enabled &&
    memory.reflection.autoStoreNotes &&
    memory.reflection.maxNotesPerCall > 0;
  return createReflectionRunner({
    llmComplete: reflectionLlmComplete,
    ...(args.toolTransport ? { toolTransport: args.toolTransport } : {}),
    profileStore: args.profileStore,
    ...(notesWriteEnabled ? { memoryStore: args.notesStore } : {}),
    ...(args.neighborEvolver ? { neighborEvolver: args.neighborEvolver } : {}),
    ...(args.emitTrace ? { emitTrace: args.emitTrace } : {}),
    reflectionSlotId,
    timeoutMs: memory.reflection.timeoutMs,
    maxFactsPerCall: memory.reflection.maxFactsPerCall,
    maxNotesPerCall: notesWriteEnabled
      ? memory.reflection.maxNotesPerCall
      : 0,
    // v2.5 typed-NOTE extraction (Phase C). Threaded as a
    // boolean dep so the runner can pick the typed reflection prefix
    // and the parser can project [type=X] into the `type:<X>` tag.
    typedNotes: memory.reflection.typedNotes.enabled,
    // Multi-party reflection mode (config v19). When enabled, the
    // runner switches to REFLECTION_STABLE_PREFIX_ANY_SPEAKER so
    // third-party speakers in the USER channel become valid
    // extraction sources. Wins over `typedNotes`.
    anySpeaker: memory.reflection.anySpeaker,
    logger: args.logger,
    metrics: args.metrics,
  });
}

/**
 * Wire trace sinks into a fan-out bus. Always includes the on-disk
 * NDJSON sink so `atomic-agent trace show` can read the session back —
 * callers append additional sinks (sidecar relay, sentry, …) via
 * `handlers.traceSinks`.
 */
function buildTraceBus(args: {
  extraSinks: TraceSink[];
  dir: string;
  maxBytesPerSession: number;
  logger: StructuredLogger;
}): TraceBus {
  const ndjsonSink = createNdjsonTraceSink({
    dir: args.dir,
    maxBytesPerSession: args.maxBytesPerSession,
    logger: args.logger,
  });
  return createTraceBus([ndjsonSink, ...args.extraSinks]);
}
