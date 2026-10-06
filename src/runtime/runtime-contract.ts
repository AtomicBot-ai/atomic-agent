import type { BuiltPrompt } from "../prompt/build-prompt-types.js";
import type { AtomicAgentConfig } from "../config/index.js";
import type { LlmStreamParams } from "../agent/step/step-contract.js";
import type { TurnController } from "./turn-controller.js";
import type { SteeringInbox } from "./steering-inbox.js";
import type { TurnEventHook, TurnOrigin } from "./turn-controller.js";
import type { ChannelStatus } from "./channel-status.js";
import type { TelegramChannel } from "../channels/telegram/index.js";
import type { DiscordChannel } from "../channels/discord/index.js";
import type { SwarmRegistry } from "../channels/swarm/index.js";
import type { BotFactory } from "../channels/telegram/index.js";
import type { McpManager } from "../mcp/index.js";
import type { CompletionResult, StreamChunk } from "../llm/llama-server-client.js";
import type { SlotManager } from "../llm/slot-manager.js";
import type { ApprovalGate } from "../approval/approval-gate.js";
import type { ApprovalLevel } from "../approval/approval-level.js";
import type { ApprovalHandler } from "../approval/approval-router.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { BrowserBackend } from "../tools/browser/browser-backend.js";
import type { ToolRole } from "../tools/tool-roles.js";
import type { ProviderRegistry } from "../llm/provider/index.js";
import type { ReasoningEffort } from "../llm/provider/completion-types.js";
import type { MemoryStore } from "../memory/memory-store.js";
import type { ProfileStore } from "../memory/profile-store.js";
import type { LessonStore } from "../memory/lessons/lesson-store.js";
import type { ProcedureStore } from "../memory/procedures/procedure-store.js";
import type { LinkStore } from "../memory/links/index.js";
import type { VoteStore } from "../memory/voting/index.js";
import type { SkillRegistry } from "../skills/skill-registry.js";
import type { CapabilitiesSummary, SkillCatalogEntry, ToolDescriptor } from "../prompt/stable-prefix.js";
import type { AgentLoop } from "../agent/agent-loop.js";
import type { AgentLoopEvent, RunTurnResult } from "../agent/agent-contract.js";
import type { SessionStore, FusionWorkerMeta, SessionState } from "../session/index.js";
import type { TaskRunner, TaskStore } from "../tasks/index.js";
import type { Scheduler } from "../scheduler/index.js";
import type { WebhookSessionStore } from "../http/webhook-session-store.js";
import type { StructuredLogger } from "../tracing/structured-logger.js";
import type { LogSink } from "../tracing/structured-logger.js";
import type { MetricSink } from "../tracing/metrics-collector.js";
import type { AgentMetrics } from "../tracing/agent-metrics.js";
import type { TraceSink } from "../tracing/trace/index.js";
import type { ApprovalRequest } from "../approval/approval-gate.js";
import type { AnalyticsDisabledVia, AnalyticsSurface } from "../analytics/index.js";
import type { BrokenPipePolicy } from "../error-reporting/index.js";


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
  /**
   * `entries` is the rebuilt catalog, `dropped` how many installed
   * skills `skills.catalogTokenBudget` left out of it. Hosts that
   * display a count need both: an install can push the catalog over the
   * budget, so the number they show has to be able to stop growing and
   * say why (issue #466). Handlers written against the one-argument
   * signature keep working — the extra argument is simply ignored.
   */
  onSkillRegistryChange?: (
    entries: SkillCatalogEntry[],
    dropped: number,
  ) => void;
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
  /**
   * Whether this runtime is being created for an interactive launch a
   * person actually performed, which is what `app_opened` counts.
   *
   * Defaults to `false` because `createAgentRuntime` is also the entry
   * point for headless work — scheduled/cron tasks, `run`, `serve`,
   * the sidecar. Those create a runtime with nobody at the keyboard, and
   * counting them would inflate the denominator of the activation
   * funnel: one user with an hourly task would look like 24 launches a
   * day. Only the TUI passes `true`.
   */
  interactiveLaunch?: boolean;
  /**
   * What this process does when the reader of its stdout or stderr goes
   * away (see `BrokenPipePolicy`). Default `exit`; `serve` passes `mute`,
   * so a server whose host died keeps going until its orphan watch ends
   * it through the teardown, instead of exiting at its next log line.
   * Process-wide and first-come: the handlers are installed once.
   */
  brokenPipe?: BrokenPipePolicy;
  /**
   * Analytics `surface` of the entry point (the TUI passes `tui`).
   * Headless entry points leave it unset so `ATOMIC_AGENT_SURFACE` from
   * the desktop app applies, else `cli`.
   */
  analyticsSurface?: AnalyticsSurface;
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
   * Discord remote-control channel, or `null` when the build never
   * constructed one. Same contract as `telegramChannel`.
   */
  readonly discordChannel: DiscordChannel | null;
  /**
   * Extra Telegram / Discord bots (`config.swarm.units`), or `null` when
   * the build never constructed the registry. Same contract as the
   * primary channels: constructed unconditionally, units started only
   * when enabled with a token.
   */
  readonly swarm: SwarmRegistry | null;
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
  /**
   * Installed skills `skills.catalogTokenBudget` left out of
   * `skillCatalog`; `0` when every one fit. The agent loop gets this
   * count on `loopDeps` and turns it into the `### skills` truncation
   * marker (issue #466), but the prompt is not the only place the
   * catalog is counted: the `run` banner, `/api/capabilities`, the TUI
   * diagnostics line and `/skills dump` all report `skillCatalog.length` as
   * "installed". Without the count beside it every one of them states a
   * clipped number as the whole truth — the same misreading the prompt
   * marker exists to prevent, told to the operator instead of to the
   * model. Live getter for the same reason `skillCatalog` is one:
   * `refreshSkills()` can turn a catalog that fit into one that does
   * not, and a snapshot taken at boot would go stale on the first
   * install.
   */
  readonly skillCatalogDropped: number;
  readonly toolDescriptors: readonly ToolDescriptor[];
  readonly grammar: string;
  readonly logger: StructuredLogger;
  readonly metrics: AgentMetrics;
  /**
   * Create a fresh session state (id, workingDir, optional metadata),
   * persist it, and return it. User messages are fed through `runTurn`.
   *
   * `persist: false` keeps the state in memory only — no row, no trace
   * file — until something saves it, which for a chat session is its
   * first turn: `executeTurn` opens the recorder and saves the result.
   * The TUI mints its sessions that way because an allocation nobody
   * types into left a row the session rail hides (it lists threads that
   * have a first prompt), so there was no row to press `x` on and
   * nothing could ever delete it. Every caller that hands the id to
   * something else before that first turn takes the default: a durable
   * task writes `session_id` into `tasks.sqlite`, a webhook and a
   * Telegram chat remember a mapping, and each expects a later `load`
   * to answer.
   */
  createSession(input?: {
    metadata?: Record<string, unknown>;
    persist?: boolean;
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
   *
   * `providerId` pins every completion of the turn to one configured
   * provider and bypasses the fallback chain (a fusion worker on the
   * local leg); an id the registry does not know rejects before the
   * turn is queued — a pinned worker fails loudly rather than silently
   * running on the active provider. `taskMaxDurationMs` is the turn's
   * wall-clock ceiling (see `RunTurnOptions`).
   */
  runTurn(
    session: SessionState,
    userMessage: string,
    options?: {
      maxSteps?: number;
      signal?: AbortSignal;
      eventHook?: TurnEventHook;
      origin?: TurnOrigin;
      providerId?: string;
      taskMaxDurationMs?: number;
      /**
       * Hide tools from this turn (see `RunTurnOptions.toolFilter`).
       * `fusion.delegate` narrows a worker's catalog with it.
       */
      toolFilter?: (name: string) => boolean;
      /** The turn's tool role (see `RunTurnOptions.toolRole`); a worker is a `builder`. */
      toolRole?: ToolRole;
      /** See `RunTurnOptions.reasoningEffort` — a fusion worker's setting. */
      reasoningEffort?: ReasoningEffort;
      /** See `RunTurnOptions.maxOutputTokens` — a fusion worker's cap. */
      maxOutputTokens?: number;
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
    options?: {
      maxSteps?: number;
      signal?: AbortSignal;
      providerId?: string;
      taskMaxDurationMs?: number;
      toolFilter?: (name: string) => boolean;
      toolRole?: ToolRole;
      reasoningEffort?: ReasoningEffort;
      maxOutputTokens?: number;
    },
  ): Promise<RunTurnResult>;
  /**
   * Mint an in-memory fusion worker session stamped with `meta`. Unlike
   * `createSession` — whose deferred form is saved by its first turn —
   * a worker is never persisted and opens no trace recorder; a
   * turn run on it is `ephemeral` (no memory recall, reflection or
   * lesson bump) and is never saved, so the id never reaches the session
   * list. The orchestrator reads the returned transcript and discards
   * it. See `src/session/fusion-worker-session.ts`.
   */
  createEphemeralSession(meta: FusionWorkerMeta): SessionState;
  /**
   * Build — never run, never persist — the prompt the next turn would
   * open with, for a composer's context readout before any message is
   * sent (the desktop's `POST /api/context-preview`). `sessionId` null
   * means a fresh thread in this workspace: an unpersisted state with a
   * throwaway id, so nothing lands in sessions.sqlite. An unknown id
   * throws a `SessionNotFoundError`. Pure: no recall / memory-index
   * prefetch runs, so those two sections are empty here and only appear
   * once a real turn has built them.
   */
  previewPrompt(input: { sessionId: string | null; userMessage?: string }): BuiltPrompt;
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
   * Re-read the local model's `/props` now (profile, vision, context
   * window, slot pool) instead of at the next local turn. The TUI calls
   * it after every managed daemon (re)start — by hand, by the
   * supervisor, after a port move — so the capabilities a restart
   * changed land on the live provider before anything asks for them.
   * Never throws; a failed probe keeps the prior profile.
   */
  refreshLocalModelProfile(): Promise<void>;
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
   * (the TUI settings tab). Idempotent. Turning it off first sends
   * `analytics_disabled` with `via` (default `settings`).
   */
  setAnalyticsEnabled(
    enabled: boolean,
    via?: AnalyticsDisabledVia,
  ): Promise<void>;
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
   * responsibility. Idempotent; pending prompts
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
