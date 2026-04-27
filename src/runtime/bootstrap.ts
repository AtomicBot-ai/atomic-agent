import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

import type { AtomicAgentConfig } from "../config/index.js";
import { getConfig } from "../config/index.js";

import { TurnController } from "./turn-controller.js";
import type { TurnEventHook, TurnOrigin } from "./turn-controller.js";

import { LlamaServerClient } from "../llm/llama-server-client.js";
import type {
  CompletionResult,
  StreamChunk,
} from "../llm/llama-server-client.js";
import {
  buildGrammar,
  detectModelProfile,
  ModelProfileManager,
  PLAIN_INSTRUCT_PROFILE,
} from "../llm/index.js";
import { checkProfileGrammarAligned } from "../llm/profile-invariants.js";
import { SlotManager } from "../llm/slot-manager.js";
import { checkLlamaServer } from "../llm/llama-server-health.js";

import { ApprovalGate } from "../approval/approval-gate.js";
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
import { LlamaServerProvider } from "../llm/provider/index.js";
import type { LlmProvider } from "../llm/provider/index.js";

import { MemoryStore } from "../memory/memory-store.js";
import { ProfileStore } from "../memory/profile-store.js";
import { createDefaultMemoryContextProvider } from "../memory/memory-context-provider.js";
import {
  createReflectionRunner,
  type ReflectionLlmComplete,
  type ReflectionRunner,
} from "../memory/reflection/index.js";

import { SkillRegistry } from "../skills/skill-registry.js";
import { buildSkillCatalog } from "../skills/skill-catalog.js";

import { DEFAULT_TOOL_DESCRIPTORS } from "../prompt/tool-descriptors.js";
import { buildCapabilities } from "../prompt/capabilities.js";
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

export interface RuntimeEventHandlers {
  onAgentEvent?: (event: AgentLoopEvent) => void;
  onApprovalRequest?: (request: ApprovalRequest) => void;
  onSkillRegistryChange?: (entries: SkillCatalogEntry[]) => void;
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
  approvalRequired: boolean;
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
    llamaComplete?: (params: {
      prompt: string;
      grammar: string;
      slotId: number;
      sessionId: string;
    }) => Promise<CompletionResult>;
    /**
     * Streaming counterpart of `llamaComplete`. Tests inject a fake SSE
     * generator here; production wiring always hands a real
     * `LlamaServerClient.completeStream` through.
     */
    llamaCompleteStream?: (params: {
      prompt: string;
      grammar: string;
      slotId: number;
      sessionId: string;
    }) => AsyncGenerator<StreamChunk, CompletionResult, void>;
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
  const turnController = new TurnController({
    onHookError: (err, ctxInfo) => {
      logger.warn("turn event hook threw", {
        sessionId: ctxInfo.sessionId,
        origin: ctxInfo.origin,
        error: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const approvals = new ApprovalGate({
    emit: (request) => options.handlers?.onApprovalRequest?.(request),
    autoApprove: !options.approvalRequired,
  });
  const dangerous: DangerousToolOptions = {
    approvals,
    approvalRequired: options.approvalRequired,
  };

  if (
    !options.overrides?.skipLlamaHealthCheck &&
    !options.overrides?.deferLlamaHealthCheck &&
    !options.overrides?.llamaComplete
  ) {
    const health = await checkLlamaServer();
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
    logger.info("slot manager using default slot count (probe miss)", {
      slotCount: 4,
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

  const skillRegistry = new SkillRegistry({
    globalDir: config.paths.globalSkillsDir,
    projectDir: join(workingDir, config.paths.projectSkillsDirName),
  });
  await skillRegistry.refresh();

  const capabilities = await buildCapabilities({
    workingDir,
    browserChannel: config.browser.channel,
  });

  const profileStore = new ProfileStore({ dbFile: config.paths.memoryDbFile });
  const notesStore = new MemoryStore({
    dbFile: config.paths.memoryDbFile,
    maxEntries: config.memory.notes.maxEntries,
  });

  const toolRegistry = new ToolRegistry();
  toolRegistry.register(finishTool);
  toolRegistry.register(replyTool);
  for (const tool of buildBrowserTools(browserBackend, dangerous)) {
    toolRegistry.register(tool);
  }
  registerOsTools(toolRegistry, { ...dangerous, config: { http: config.http } });
  registerSkillTools(toolRegistry, skillRegistry, dangerous);
  toolRegistry.register(buildToolViewTool());
  registerMemoryTools(toolRegistry, {
    profileStore,
    profileEnabled: config.memory.profile.enabled,
    notesStore,
    notesEnabled: config.memory.notes.enabled,
    notesRecallDefaultK: config.memory.notes.recallDefaultK,
    notesMaxContentChars: config.memory.notes.maxContentChars,
  });

  // Vision provider wiring is deferred until after `profileManager` is
  // built so the provider can read the **current** model profile
  // through a getter instead of capturing a (potentially stale)
  // `plain-instruct` fallback at construction time. See
  // `LlamaServerProvider.capabilities` for the rationale.

  let skillCatalog: readonly SkillCatalogEntry[] = buildSkillCatalog(
    skillRegistry.list(),
  );

  const grammar = await buildGrammar(profile, config.paths.grammarsDir);
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
        logger,
      })
    : undefined;

  // Vision provider reads the live profile through a getter so its
  // `capabilities.vision` flag tracks `ModelProfileManager` hot-swaps.
  // Vision calls always use `slotId: -1` so the main agent + reflection
  // slots are never touched.
  const visionProvider: LlmProvider | undefined = config.vision.enabled
    ? new LlamaServerProvider(llama, {
        getProfile: () => profileManager?.getProfile() ?? profile,
        visionEnabledByConfig: config.vision.enabled,
        visionAutoDetect: config.vision.autoDetect,
        maxImageBytes: config.vision.maxImageBytes,
        maxImagesPerCall: config.vision.maxImagesPerCall,
      })
    : undefined;
  registerVisionTools(toolRegistry, {
    provider: visionProvider,
    enabled: config.vision.enabled,
    maxImagesPerCall: config.vision.maxImagesPerCall,
    maxImageBytes: config.vision.maxImageBytes,
  });
  // The descriptor stays in the prompt whenever the operator wired a
  // vision provider — even before the profile probe lands. The
  // descriptor blurb already says "Only available when the active
  // model + provider support multimodal input"; if the user asks for
  // image work before mmproj is loaded, the tool surfaces a clear
  // `VisionUnsupportedError` instead of silently disappearing from
  // the toolset.
  const effectiveToolDescriptors =
    config.vision.enabled && visionProvider !== undefined
      ? DEFAULT_TOOL_DESCRIPTORS
      : DEFAULT_TOOL_DESCRIPTORS.filter((d) => d.name !== "vision.describe");
  if (config.vision.enabled) {
    logger.info("vision provider configured", {
      provider: visionProvider?.name ?? "(none)",
      autoDetect: config.vision.autoDetect,
      registeredAtBootstrap: visionProvider !== undefined,
    });
  }

  const llmComplete =
    options.overrides?.llamaComplete ??
    (async (params) => {
      return llama.complete({
        prompt: params.prompt,
        grammar: params.grammar,
        slotId: params.slotId,
        sessionId: params.sessionId,
        cachePrompt: true,
      });
    });

  // Streaming is wired to the real llama-server by default. Tests that
  // inject a `llamaComplete` fake opt out of streaming implicitly unless
  // they also pass an `llamaCompleteStream` fake — otherwise the agent
  // would try to hit a non-existent server for every step.
  const llmCompleteStream = options.overrides?.disableStreaming
    ? undefined
    : options.overrides?.llamaCompleteStream ??
      (options.overrides?.llamaComplete
        ? undefined
        : (params) =>
            llama.completeStream({
              prompt: params.prompt,
              grammar: params.grammar,
              slotId: params.slotId,
              sessionId: params.sessionId,
              cachePrompt: true,
            }));

  const sessionStore = new SessionStore();
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

  const reflectionRunner = buildReflectionRunner({
    config,
    slotManager,
    llmComplete,
    profileStore,
    notesStore,
    logger,
    metrics,
  });

  // Read-side counterpart of reflection: pre-step recall injection and
  // memory-index pointer rendering. Wired only when `memory.notes` is
  // enabled — otherwise the runtime has nothing to read from and the
  // prompt tail skips both sections.
  const memoryContextProvider = config.memory.notes.enabled
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
      })
    : undefined;

  // The `skillCatalog` is a getter so that `agent-loop` reads the current
  // value on every step — `refreshSkills()` then does not require tearing
  // down the loop.
  const loopDeps = {
    registry: toolRegistry,
    slotManager,
    grammar,
    llmComplete,
    ...(llmCompleteStream ? { llmCompleteStream } : {}),
    toolDescriptors: effectiveToolDescriptors,
    capabilities,
    profile,
    ...(profileManager ? { profileManager } : {}),
    ...(config.memory.profile.enabled
      ? { profileFactsProvider: () => profileStore.list() }
      : {}),
    ...(reflectionRunner ? { reflectionRunner } : {}),
    ...(memoryContextProvider ? { memoryContextProvider } : {}),
    onEvent: (event: AgentLoopEvent) => {
      // The loop has no awareness of which session it is currently
      // driving; resolve that from the per-turn ALS frame so two
      // concurrent sessions never cross-contaminate trace records or
      // per-submission hooks.
      const ctx = turnContext.getStore();
      if (ctx) {
        const recorder = recorders.get(ctx.sessionId);
        recorder?.onAgentEvent(event);
        turnController.emit(ctx.sessionId, event);
      }
      options.handlers?.onAgentEvent?.(event);
    },
    metrics,
    logger,
  };
  Object.defineProperty(loopDeps, "skillCatalog", {
    enumerable: true,
    get: () => skillCatalog,
  });
  const loop = new AgentLoop(
    loopDeps as typeof loopDeps & { skillCatalog: readonly SkillCatalogEntry[] },
  );

  let shutdownCalled = false;
  const shutdown = async (): Promise<void> => {
    if (shutdownCalled) return;
    shutdownCalled = true;
    // Cancel any in-flight reflection before tearing down the profile
    // store — otherwise a late-arriving completion could try to write
    // into a closed SQLite connection.
    try {
      reflectionRunner?.abortPending();
    } catch {
      // runner already disposed
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
    try {
      taskStore.close();
    } catch {
      // already closed
    }
  };

  const refreshSkills = async (): Promise<void> => {
    await skillRegistry.refresh();
    skillCatalog = buildSkillCatalog(skillRegistry.list());
    options.handlers?.onSkillRegistryChange?.([...skillCatalog]);
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
    const submission = {
      sessionId: session.id,
      origin: runOptions.origin ?? "cli",
      run: () => executeTurn(session, userMessage, runOptions),
      ...(runOptions.eventHook ? { eventHook: runOptions.eventHook } : {}),
      ...(runOptions.signal ? { signal: runOptions.signal } : {}),
    } as const;
    return turnController.enqueue(submission);
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
  scheduler?.start();

  const runtime = {
    config,
    loop,
    toolRegistry,
    skillRegistry,
    approvals,
    slotManager,
    sessionStore,
    turnController,
    profileStore,
    notesStore,
    taskStore,
    taskRunner,
    scheduler,
    webhookSessionStore,
    capabilities,
    toolDescriptors: effectiveToolDescriptors,
    grammar,
    logger,
    metrics,
    createSession,
    runTurn,
    executeTurn,
    refreshSkills,
    shutdown,
  } as AgentRuntime;
  Object.defineProperty(runtime, "skillCatalog", {
    enumerable: true,
    get: () => skillCatalog,
  });
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
 * Extract `total_slots` from a `/props` payload. `llama-server` reports
 * the number as an integer at the top level; anything else (missing,
 * non-finite, non-positive) collapses to `null` so the caller falls back
 * to the SlotManager default.
 */
function extractTotalSlots(props: Record<string, unknown>): number | null {
  const raw = props.total_slots;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 1) {
    return null;
  }
  return Math.trunc(raw);
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
  llmComplete: (params: {
    prompt: string;
    grammar: string;
    slotId: number;
    sessionId: string;
  }) => Promise<CompletionResult>;
  profileStore: ProfileStore;
  /**
   * Freeform notes store. Wired only when both `memory.notes.enabled`
   * and `memory.reflection.autoStoreNotes` are true — otherwise the
   * runner falls back to profile-only extraction and the NOTE channel
   * is silently dropped.
   */
  notesStore: MemoryStore;
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
    const completionPromise = args.llmComplete({
      prompt: params.prompt,
      grammar: params.grammar,
      slotId: params.slotId,
      sessionId: params.sessionId,
    });
    return Promise.race([completionPromise, abortPromise]);
  };
  const notesWriteEnabled =
    memory.notes.enabled &&
    memory.reflection.autoStoreNotes &&
    memory.reflection.maxNotesPerCall > 0;
  return createReflectionRunner({
    llmComplete: reflectionLlmComplete,
    profileStore: args.profileStore,
    ...(notesWriteEnabled ? { memoryStore: args.notesStore } : {}),
    reflectionSlotId,
    timeoutMs: memory.reflection.timeoutMs,
    maxFactsPerCall: memory.reflection.maxFactsPerCall,
    maxNotesPerCall: notesWriteEnabled
      ? memory.reflection.maxNotesPerCall
      : 0,
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
