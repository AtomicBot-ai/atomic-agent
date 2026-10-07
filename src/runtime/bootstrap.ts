import { estimateUsageCostUsd } from "../llm/provider/usage-cost.js";
import { resolveServerTemplatePolicy } from "../llm/server-template-policy.js";
import { createContextCompaction } from "./context-compaction.js";
import { prepareRuntimeSkills } from "./composition/runtime-skills.js";
import { createRuntimeToolRegistry, registerRuntimeCoreTools, registerRuntimeVisionTools, connectRuntimeMcpCatalog, registerRuntimeFusionAndReadScope } from "./composition/runtime-tool-catalog.js";
import { prepareRuntimeSessionStore, installRuntimeSessionDelete, createRuntimeSessionFactories } from "./composition/runtime-session-services.js";
import { prepareRuntimeTurnState, createRuntimeTurnService } from "./composition/runtime-turn-service.js";
import { createRuntimeTaskStores, createRuntimeTaskRunner, createRuntimeScheduler } from "./composition/runtime-task-services.js";
import { connectRuntimeChannels } from "./composition/runtime-channels.js";
import type { AgentRuntime, CreateAgentRuntimeOptions } from "./runtime-contract.js";
export type { AgentRuntime, CreateAgentRuntimeOptions, RuntimeEventHandlers } from "./runtime-contract.js";
export { managedLocalLlmHealthFailureHint } from "./composition/runtime-local-profile.js";
import { createRuntimeObservability } from "./composition/runtime-observability.js";
import { createRuntimeTraces } from "./composition/runtime-traces.js";
import { prepareRuntimeLocalProfile, connectRuntimeLocalProfile } from "./composition/runtime-local-profile.js";
import { connectRuntimeProviders, createRuntimeModelContext, connectRuntimeFallback, createRuntimeProviderReloads } from "./composition/runtime-inference.js";
import { createRuntimeMemoryStores } from "./composition/runtime-memory-stores.js";
import { createRuntimeMemoryServices, createRuntimeMemoryConsolidator } from "./composition/runtime-memory-services.js";
import { createRuntimeLifecycle } from "./composition/runtime-lifecycle.js";
import { resolve } from "node:path";

import { getConfig } from "../config/index.js";

import { TurnController } from "./turn-controller.js";
import { SteeringInbox } from "./steering-inbox.js";

import { TelegramChannel } from "../channels/telegram/index.js";
import { DiscordChannel } from "../channels/discord/index.js";
import { SwarmRegistry } from "../channels/swarm/index.js";

import { installTransportDeadlines } from "../llm/transport-deadlines.js";

import { ApprovalGate } from "../approval/approval-gate.js";

import { ApprovalRouter } from "../approval/approval-router.js";

import type { DangerousToolOptions } from "../approval/dangerous-tool.js";

import { PlaywrightBackend } from "../tools/browser/playwright-backend.js";
import type { BrowserBackend } from "../tools/browser/browser-backend.js";
import { DeclaredInputsRegistry, ShellJobRegistry } from "../tools/os/index.js";

import { resolveLlmConfig } from "../llm/provider/index.js";

import { CostAccumulator } from "../llm/provider/cost-accumulator.js";

import { ProviderFallbackChain } from "../llm/fallback/index.js";
import { createFallbackChainResolver } from "./fallback-chain-resolver.js";
import { isLocalLinkWithoutModel } from "./local-link-availability.js";
import { createRuntimePromptPreview, buildRuntimePromptInput } from "./composition/runtime-prompt-preview.js";
export { SessionNotFoundError } from "./session-not-found-error.js";

import { createLessonLifecycleHook } from "../memory/lessons/lesson-lifecycle-hook.js";

import { createMemoryHealthAnnouncer } from "./announce-memory-health.js";

import { readAtomicMailApiKey } from "../atomic-mail/index.js";
import { buildCapabilities } from "../prompt/capabilities.js";

import type { SkillCatalogEntry, ToolDescriptor } from "../prompt/stable-prefix.js";

import { AgentLoop } from "../agent/agent-loop.js";

import { TurnUsageMeter } from "../analytics/index.js";

import { installGlobalErrorHandlers } from "../error-reporting/index.js";

/**
 * One-stop factory that wires the whole agent runtime. Both the CLI
 * (`atomic-agent run`) and the sidecar (`atomic-agent-sidecar`) go
 * through this function — there is no other way to construct a live
 * AgentLoop. Explicit construction phases share the same root so
 * entry points use the same wiring and lifecycle.
 */
export async function createAgentRuntime(
  options: CreateAgentRuntimeOptions,
): Promise<AgentRuntime> {
  const config = getConfig();
  // Before anything can make a request: Node's global `fetch` applies a
  // 300 s deadline of its own under every AbortSignal this codebase
  // arms, which made `firstTokenTimeoutMs`, `streamTotalTimeoutMs`, the
  // `/slots` unreachable budget and a Fusion worker's queue budget all
  // unreachable, and turned a wedged llama-server into a bare
  // `fetch failed` at 306 s. See `installTransportDeadlines`.
  installTransportDeadlines(config);
  const workingDir = resolve(options.workingDir);

  const observability = createRuntimeObservability(config, options);
  const { logger, metrics, analyticsStateStore } = observability;

  // Read the current reporter lazily so a hot-toggle is reflected without
  // re-installing the process-global handlers.
  installGlobalErrorHandlers(observability.getErrorReporter, {
    brokenPipe: options.brokenPipe,
  });

  const { setAnalyticsEnabled, reportOnboardingStep, reportModelConfigured } =
    observability.createControls();

  const traces = createRuntimeTraces(config, options, logger);
  const { traceBus, turnContext, touchRecorder, dropRecorder, ensureRecorder } = traces;

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

  const { emitAgentLoopEventFor, emitAgentLoopEvent } = traces.createEventRouting(
    turnController, options, observability.getErrorReporter,
  );

  // Memory sub-calls run fire-and-forget and fail without a word. This
  // counts consecutive timeouts / failures per session and sub-call and
  // lifts the first streak into one `memory_health_warning` (see
  // ../memory/docs/formation.md). The session comes from the
  // runner's own outcome, not the ALS frame: reflection settles after
  // `turn_finished`.
  const memoryHealth = createMemoryHealthAnnouncer({
    emit: emitAgentLoopEventFor,
    logger,
  });

  // Cross-provider fallover breaker. Owns no timer — every decision is
  // computed lazily from the wall clock when a turn asks for a provider
  // (../llm/docs/fallback.md). The notice sink lifts each
  // one-shot switch into a `provider_switched` AgentLoopEvent; the logger
  // records every advance, with the failed link's status and message.
  // Set once the provider registry exists (below). Until then the chain
  // is taken from config as before; nothing picks a provider that early.
  let builtProviderIds: (() => readonly string[]) | null = null;
  const fallbackChain = new ProviderFallbackChain({
    resolve: createFallbackChainResolver({
      readLlmConfig: () => resolveLlmConfig(getConfig()),
      builtProviderIds: () => builtProviderIds?.() ?? null,
      linkUnavailable: (llm, id) => isLocalLinkWithoutModel(llm, id, getConfig()),
      logger,
    }),
    noticeSink: (notice) =>
      emitAgentLoopEvent({ type: "provider_switched", ...notice }),
    logger,
  });

  // Approval requests flow through `ApprovalRouter`: per-session
  // handlers (Telegram channel, future Slack/etc.) win, otherwise the
  // host's `onApprovalRequest` callback fires. The fallback closure
  // reads `options.handlers` when an approval arrives. Sessions that
  // need a different handler register with the per-session router.
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

  // Issue #112. Every local text probe below hangs off this one answer,
  // and it is available here — hundreds of lines before
  // `ProviderRegistry.fromConfig` resolves the active provider —
  // because `resolveLlmConfig` is a pure function of config with no
  // I/O. A cloud-backed boot must not open `/health` or `/props`
  // against a llama-server nobody is routed to: the warnings it prints
  // read as an active-backend failure while the real provider is fine.
  const localProfile = await prepareRuntimeLocalProfile(config, options, logger);
  const { llama, profile, slotManager } = localProfile;
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
  const preparedSkills = await prepareRuntimeSkills(config, workingDir, logger);
  const { skillRegistry } = preparedSkills;

  const capabilities = await buildCapabilities({
    workingDir,
    browserChannel: config.browser.channel,
    // Only an inbox this machine holds the key for is the agent's to use.
    emailAddress: readAtomicMailApiKey() ? config.atomicMail.address : null,
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
  const memoryStores = await createRuntimeMemoryStores({
    config, metrics, onProfileEvicted: (eviction) => {
      const sessionId = turnContext.getStore()?.sessionId;
      logger.info("profile facts evicted over memory.profile.maxEntries", {
        evicted: eviction.evicted.length,
        maxEntries: eviction.maxEntries,
        activeUnpinned: eviction.activeUnpinned,
        ...(sessionId !== undefined ? { sessionId } : {}),
      });
      if (sessionId === undefined) return;
      touchRecorder(sessionId)?.recordProfileFactsEvicted({
        maxEntries: eviction.maxEntries,
        activeUnpinned: eviction.activeUnpinned,
        ids: eviction.evicted.map((fact) => fact.id),
        keys: eviction.evicted.map((fact) => fact.key),
      });
    },
  });
  const { profileStore, notesStore, embeddingClient, linkStore, lessonStore, procedureStore, voteStore } = memoryStores;

  const sessionStore = prepareRuntimeSessionStore(config, logger);
  // The commands `os.shell.run` detached at the default timeout (F47).
  // One registry for the runtime, so the turn-end (`executeTurn`),
  // session-delete and shutdown paths below can stop what a session
  // left running.
  const shellJobs = new ShellJobRegistry({
    jobMaxMs: config.tools.shell.jobMaxMs,
    maxJobs: config.tools.shell.maxJobs,
  });
  installRuntimeSessionDelete(sessionStore, dropRecorder, shellJobs);

  const toolRegistry = createRuntimeToolRegistry(config, browserBackend, dangerous);

  // What the operator asked for, per session, for the turn now running
  // on it — quoted into every fusion worker's brief (`worker-prompt.ts`)
  // and read by `os.fs.write` to tell an input the request names from
  // any other file (`fs-input-guard.ts`). Set and cleared by
  // `executeTurn` around the loop; a worker's record is its brief, whose
  // ORIGINAL REQUEST block is the operator's words. Only that turn can
  // call a tool on the session (the controller runs one turn per
  // session), so a read always finds its own turn's request.
  const turnRequests = new Map<string, string>();
  // The files a fan-out's contract declared as inputs, per worker
  // session: the worker runner declares them, `os.fs.write` refuses to
  // replace them (`fs-declared-inputs.ts`).
  const declaredInputs = new DeclaredInputsRegistry();
  registerRuntimeCoreTools({
    config, toolRegistry, dangerous, sessionStore, logger, resolveOriginalRequest: (id) => turnRequests.get(id),
    declaredInputs, shellJobs, skillRegistry, profileStore, notesStore, lessonStore, procedureStore,
  });

  // Vision provider wiring is deferred until after `profileManager` is
  // built so the provider can read the **current** model profile
  // through a getter instead of capturing a (potentially stale)
  // `plain-instruct` fallback at construction time. See
  // `LlamaServerProvider.capabilities` for the rationale.

  const skillCatalogState = preparedSkills.createCatalog();

  const connectedLocal = await connectRuntimeLocalProfile(config, options, logger, localProfile);
  const { profileManager, localBackend } = connectedLocal;
  const initialGrammar = connectedLocal.initialGrammar;

  const providers = await connectRuntimeProviders(config, logger, localProfile, connectedLocal);
  const { providerRegistry, resolveActiveLlmSlice, resolveCurrentRunMode, resolveActiveModelName, resolveRouteVision } = providers;
  builtProviderIds = () => providerRegistry.listIds();

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

  const modelContext = createRuntimeModelContext(config, providers);
  const { resolveModelPricing, observeContextWindow, raiseContextWindowTo, resolveCatalogContextWindow, resolveCurrentVisionProvider, visionOnLiveRoute } = modelContext;
  registerRuntimeVisionTools({ config, toolRegistry, resolveCurrentVisionProvider, logger });

  const mcpCatalog = await connectRuntimeMcpCatalog({
    config, options, toolRegistry, logger, dangerous, llama, initialGrammar,
    visionOnLiveRoute, resolveCurrentRunMode,
  });
  const { mcpManager, getGrammar, effectiveToolDescriptors } = mcpCatalog;

  if (config.vision.enabled) {
    logger.info("vision provider configured", {
      provider: textProvider.id,
      followsLiveRoute: true,
      autoDetect: config.vision.autoDetect,
      offeredAtBootstrap: visionOnLiveRoute(),
    });
  }

  const { prepareLocalLink, llmComplete, llmCompleteStream } = connectRuntimeFallback(options, {
    fallbackChain, resolveActiveLlmSlice, localBackend: connectedLocal.localBackend, profileManager,
    costAccumulator, turnUsageMeter, resolveModelPricing,
  });
  const { taskStore, webhookSessionStore } = createRuntimeTaskStores({ config, logger });
  const { reflectionRunner, memoryContextProvider } = createRuntimeMemoryServices({
    config, profileStore, notesStore, linkStore, lessonStore, procedureStore, voteStore, embeddingClient,
    slotManager, llmComplete, toolTransport: bootstrapLlmSlice.transport, logger, metrics, touchRecorder, memoryHealth,
  });

  const promptPreviewDeps = {
    workingDir, sessionStore, profileStore, capabilities, effectiveToolDescriptors,
    getSkillCatalog: skillCatalogState.getSkillCatalog,
    getLiveProfile: connectedLocal.getLiveProfile,
    resolveToolTransport: (id?: string) => resolveActiveLlmSlice(id ? fallbackChain.standingOverrideFor(id) ?? undefined : undefined).transport,
    profileWindowApplies: (id?: string) => resolveActiveLlmSlice(id ? fallbackChain.standingOverrideFor(id) ?? undefined : undefined).isLlamaServer,
    resolveCatalogContextWindow: (id?: string) => resolveCatalogContextWindow(id ? fallbackChain.standingOverrideFor(id) ?? undefined : undefined),
  };
  const compaction = createContextCompaction({
    config: () => getConfig().agent.compaction,
    sessionStore, turnController, complete: llmComplete,
    promptInput: (state) => buildRuntimePromptInput(getConfig(), promptPreviewDeps, state),
    route: (id, pin) => {
      const providerId = pin ?? fallbackChain.standingOverrideFor(id) ?? providerRegistry.activeText.id;
      const slice = resolveActiveLlmSlice(providerId);
      return {
        providerId, transport: slice.transport,
        contextWindow: slice.isLlamaServer ? (connectedLocal.getLiveProfile().contextWindow ?? resolveCatalogContextWindow(providerId)) : resolveCatalogContextWindow(providerId),
        serverTemplate: resolveServerTemplatePolicy(getConfig().localModels, connectedLocal.getLiveProfile()).useServerTemplate,
      };
    },
    sideCallSlotId: () => slotManager.sideCallSlotId(),
    costOf: (result, providerId) => {
      const pricing = resolveModelPricing(result.modelId, providerId)?.pricing;
      return pricing && result.usage ? estimateUsageCostUsd(result.usage, pricing) : undefined;
    },
    persist: (state, inTurn) => {
      const existed = sessionStore.load(state.id) !== null;
      sessionStore.save(state);
      // A deferred TUI session may get its first row at this checkpoint.
      if (inTurn && !existed) sessionStore.beginTurn(state.id);
    },
    warn: (sessionId, message) => logger.warn(message, { sessionId }),
    emit: (event) => {
      if (event.type === "compaction_failed" && event.result.status === "failed") {
        logger.warn("context compaction failed; continuing with history trimming", { sessionId: event.sessionId, reason: event.result.message });
      }
      emitAgentLoopEventFor(event.sessionId, event);
    },
  });

  // Plan mode. Session state, deliberately not config: it is a stance
  // for the next few turns, not a setting, and a "look but do not touch"
  // that survived a restart would be a mystery rather than a memory.
  let planMode = false;

  // The `skillCatalog` is a getter so that `agent-loop` reads the current
  // value on every step — `refreshSkills()` then does not require tearing
  // down the loop.
  const loopDeps = {
    compaction: compaction.control,
    registry: toolRegistry,
    // A getter, so `runtime.setPlanMode` is observed by the next tool
    // call rather than by the next process. Same reason the approval
    // gate is the single live switch rather than a boolean copied into
    // each tool registration.
    isPlanMode: () => planMode,
    // The gate itself, not a copied level: a batch of approval-gated calls
    // runs in order when nothing in it would ask (`--no-approval`), and the
    // step must see the level the operator has now, not at boot.
    approvalPosture: approvals,
    // The same live resolution the `fusion.delegate` descriptor gate
    // reads, so the tool the orchestrator is being pushed towards is
    // always in the catalog when the push happens.
    isFusionMode: () => resolveCurrentRunMode().effective === "fusion",
    clearFanoutTurnGrant: (sessionId: string) =>
      approvals.fanoutScopes.clearTurnGrant(sessionId),
    forgetDeclinedApprovals: (sessionId: string) => approvals.forgetDeclined(sessionId),
    slotManager,
    grammar: getGrammar(),
    llmComplete,
    // Mid-turn steering: the loop drains this at every step boundary.
    steeringInbox,
    ...(llmCompleteStream ? { llmCompleteStream } : {}),
    toolDescriptors: effectiveToolDescriptors(),
    capabilities,
    profile,
    contextWindow: resolveCatalogContextWindow,
    // The local leg's slot count once `/props` has answered — what the
    // `### fusion` facts state for an external server.
    liveWorkerSlots: () => slotManager.observedPoolSize(),
    onContextWindowObserved: observeContextWindow,
    onContextWindowExceeded: raiseContextWindowTo,
    // A pinned turn (`RunTurnOptions.providerId`, a fusion worker on the
    // local leg) is built for the pinned link's wire shape, not the
    // active provider's that the four getters below describe.
    resolveLlmSlice: (providerId: string) => {
      const slice = resolveActiveLlmSlice(providerId);
      return {
        contextWindow: resolveCatalogContextWindow(providerId),
        toolTransport: slice.transport,
        toolCallAdapter: slice.adapter,
        supportsSlotAffinity: slice.slotAffinity,
        supportsParallelTools: slice.parallelTools,
        strictTools: slice.strictTools,
        isLlamaServer: slice.isLlamaServer,
      };
    },
    ...(profileManager ? { profileManager } : {}),
    // Gates the two `/props` refreshes the loop owns, and carries the
    // lazy restore for a switch back to a local provider (issue #112).
    localBackend,
    ...(config.memory.profile.enabled
      ? { profileFactsProvider: () => profileStore.listForPrompt() }
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
            windowTurns: config.memory.reflection.segmentation.windowTurns,
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
    get: skillCatalogState.getSkillCatalog,
  });
  // Same live binding, for the same reason: `refreshSkills()` can turn
  // a catalog that fit into one that does not, and the `### skills`
  // truncation marker has to move with it.
  Object.defineProperty(loopDeps, "skillCatalogDropped", {
    enumerable: true,
    get: skillCatalogState.getSkillCatalogDropped,
  });
  // Late-binding getters for the MCP-driven fields. `grammar` and
  // `toolDescriptors` are recomputed by `runtime.refreshMcp()` after a
  // server is live-added or live-removed via the TUI MCP panel. The
  // AgentLoop reads both on every step so the rebuilt values land on
  // the next inference without restarting the loop.
  Object.defineProperty(loopDeps, "grammar", {
    enumerable: true,
    get: getGrammar,
  });
  Object.defineProperty(loopDeps, "toolDescriptors", {
    enumerable: true,
    get: () => effectiveToolDescriptors(),
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
  Object.defineProperty(loopDeps, "strictTools", {
    enumerable: true,
    get: () => resolveActiveLlmSlice().strictTools,
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
  let discordChannelForShutdown: DiscordChannel | null = null;
  let swarmForShutdown: SwarmRegistry | null = null;
  const turnState = prepareRuntimeTurnState();
  const { pendingSessionNamings, turnsInFlight } = turnState;
  const lifecycle = createRuntimeLifecycle({
    sessionStore, logger, steeringInbox, shellJobs, reflectionRunner, pendingSessionNamings, turnsInFlight, compaction,
    browserBackend, mcpManager, profileStore, notesStore, lessonStore, procedureStore,
    get scheduler() { return scheduler; },
    get taskRunner() { return taskRunner; },
    get telegramChannelForShutdown() { return telegramChannelForShutdown; },
    get discordChannelForShutdown() { return discordChannelForShutdown; },
    get swarmForShutdown() { return swarmForShutdown; },
    get consolidatorJob() { return consolidatorJob; },
    get taskStore() { return taskStore; },
    get analytics() { return observability.getAnalytics(); },
    get errorReporter() { return observability.getErrorReporter(); },
  });
  const { shutdown } = lifecycle;
  const refreshSkills = skillCatalogState.createRefreshSkills(options);

  const refreshMcp = mcpCatalog.createRefreshMcp();

  const { reloadLlmProviders, reloadLlmProvider } = createRuntimeProviderReloads(
    logger, localProfile, connectedLocal, providerRegistry,
  );

  const { createSession, createEphemeralSession } = createRuntimeSessionFactories(workingDir, sessionStore, ensureRecorder);
  const previewPrompt = createRuntimePromptPreview(config, promptPreviewDeps);

  const { executeTurn, steer, runTurn } = createRuntimeTurnService(config, {
    sessions: { sessionStore, turnContext, turnRequests },
    execution: { loop, turnController, steeringInbox, shellJobs, slotManager, llmComplete },
    inference: { providerRegistry, resolveActiveLlmSlice, resolveCurrentRunMode, resolveRouteVision, resolveActiveModelName, fallbackChain },
    traces, telemetry: { observability, analyticsStateStore, turnUsageMeter },
    state: turnState, lifecycle, logger,
  });

  const taskRunner = createRuntimeTaskRunner({
    config, taskStore, runTurn, sessionStore, createSession, toolRegistry,
    resolveTelegram: () => telegramChannelForShutdown, logger, metrics,
  });

  registerRuntimeFusionAndReadScope({
    config, toolRegistry, runTurn, createEphemeralSession, resolveOriginalRequest: (id) => turnRequests.get(id),
    declaredInputs, prepareLocalLink, emitAgentLoopEventFor, resolveCurrentRunMode,
    providerRegistry, llama, approvals, dangerous, slotManager, workingDir, logger,
  });

  const scheduler = createRuntimeScheduler({ config, taskRunner, logger, metrics });
  const consolidatorJob = createRuntimeMemoryConsolidator({
    config, notesStore, linkStore, lessonStore, procedureStore, voteStore,
    slotManager, llmComplete, logger, metrics, traceBus,
  });
  consolidatorJob?.start();

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
    discordChannel: null,
    swarm: null,
    mcpManager,
    providerRegistry,
    capabilities,
    toolDescriptors: effectiveToolDescriptors(),
    grammar: getGrammar(),
    logger,
    metrics,
    createSession,
    createEphemeralSession,
    runTurn,
    executeTurn,
    previewPrompt,
    compactSession: compaction.compactSession,
    getSessionCompaction: compaction.getSessionCompaction,
    cancelSessionCompaction: compaction.cancelSessionCompaction,
    refreshSkills,
    refreshMcp,
    reloadLlmProviders,
    reloadLlmProvider,
    refreshLocalModelProfile: async () => {
      await profileManager?.refresh();
    },
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
  } as AgentRuntime & {
    telegramChannel: TelegramChannel | null;
    discordChannel: DiscordChannel | null;
    swarm: SwarmRegistry | null;
  };
  Object.defineProperty(runtime, "skillCatalog", {
    enumerable: true,
    get: skillCatalogState.getSkillCatalog,
  });
  // Read the catalog owner on every access: refreshSkills replaces the
  // section, so the dropped count must follow its current entries.
  Object.defineProperty(runtime, "skillCatalogDropped", {
    enumerable: true,
    get: skillCatalogState.getSkillCatalogDropped,
  });
  // Same late binding as the loop's own getter: `/tools`, the sidecar
  // and every host that reads the catalog off the runtime must see the
  // fusion descriptor appear and disappear with the live run mode, not
  // with whatever the mode was when bootstrap ran.
  Object.defineProperty(runtime, "toolDescriptors", {
    enumerable: true,
    get: () => effectiveToolDescriptors(),
  });

  connectRuntimeChannels({
    runtime, config, logger, metrics, approvals, approvalRouter, options,
    connectTelegram: (channel) => { telegramChannelForShutdown = channel; },
    connectDiscord: (channel) => { discordChannelForShutdown = channel; },
    connectSwarm: (swarm) => { swarmForShutdown = swarm; },
  });

  // Deferred from the Scheduler construction site above: the first
  // due tick must not race the Telegram channel construction, so task
  // reports always find the channel object (and queue on it while it
  // is still starting).
  scheduler?.start();

  return runtime;
}
