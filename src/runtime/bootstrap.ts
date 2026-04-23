import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type { AtomicAgentConfig } from "../config/index.js";
import { getConfig } from "../config/index.js";

import { LlamaServerClient } from "../llm/llama-server-client.js";
import type {
  CompletionResult,
  StreamChunk,
} from "../llm/llama-server-client.js";
import {
  buildGrammar,
  detectModelProfile,
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
import { registerMemoryTools } from "../tools/memory/index.js";

import { ProfileStore } from "../memory/profile-store.js";

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

import { StructuredLogger } from "../telemetry/structured-logger.js";
import type { LogSink } from "../telemetry/structured-logger.js";
import { MetricsCollector } from "../telemetry/metrics-collector.js";
import type { MetricSink } from "../telemetry/metrics-collector.js";
import { AgentMetrics } from "../telemetry/agent-metrics.js";
import {
  createNdjsonTraceSink,
  createTraceBus,
  createTraceRecorder,
  type TraceBus,
  type TraceRecorder,
  type TraceSink,
} from "../telemetry/trace/index.js";

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
   * `config.telemetry.trace.enabled` is `null` (the default). CLI / TUI /
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
   * Durable user-profile store. Present even when
   * `memory.profile.enabled` is `false`, because the store owns the
   * SQLite connection used by any future feature that reuses the same
   * file. Callers should respect the config flag before writing.
   */
  readonly profileStore: ProfileStore;
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
   */
  runTurn(
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
    config.telemetry.trace.enabled,
    options.traceDefault,
  );
  const traceBus = traceEnabled
    ? buildTraceBus({
        extraSinks: options.handlers?.traceSinks ?? [],
        dir: config.telemetry.trace.dir,
        maxBytesPerSession: config.telemetry.trace.maxBytesPerSession,
        logger,
      })
    : null;
  const recorders = new Map<string, TraceRecorder>();
  let currentRecorder: TraceRecorder | null = null;

  const approvals = new ApprovalGate({
    emit: (request) => options.handlers?.onApprovalRequest?.(request),
    autoApprove: !options.approvalRequired,
  });
  const dangerous: DangerousToolOptions = {
    approvals,
    approvalRequired: options.approvalRequired,
  };

  if (!options.overrides?.skipLlamaHealthCheck && !options.overrides?.llamaComplete) {
    const health = await checkLlamaServer();
    if (!health.reachable) {
      logger.warn("llama-server health check failed", {
        error: health.error,
        url: config.llama.url,
      });
    } else {
      logger.info("llama-server reachable", {
        url: config.llama.url,
        latencyMs: health.latencyMs,
      });
    }
  }

  const llama = new LlamaServerClient();
  const slotManager = new SlotManager();
  const profile = await resolveModelProfile(options.overrides, llama, logger, config.llama.url);

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

  const toolRegistry = new ToolRegistry();
  toolRegistry.register(finishTool);
  toolRegistry.register(replyTool);
  for (const tool of buildBrowserTools(browserBackend, dangerous)) {
    toolRegistry.register(tool);
  }
  registerOsTools(toolRegistry, { ...dangerous, config: { http: config.http } });
  registerSkillTools(toolRegistry, skillRegistry, dangerous);
  registerMemoryTools(toolRegistry, {
    profileStore,
    tracesDir: config.telemetry.trace.dir,
    historyMaxResults: config.memory.history.maxResults,
    tracingEnabled: traceEnabled,
    profileEnabled: config.memory.profile.enabled,
    historyEnabled: config.memory.history.enabled,
  });

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

  // The `skillCatalog` is a getter so that `agent-loop` reads the current
  // value on every step — `refreshSkills()` then does not require tearing
  // down the loop.
  const loopDeps = {
    registry: toolRegistry,
    slotManager,
    grammar,
    llmComplete,
    ...(llmCompleteStream ? { llmCompleteStream } : {}),
    toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
    capabilities,
    profile,
    ...(config.memory.profile.enabled
      ? { profileFactsProvider: () => profileStore.list() }
      : {}),
    onEvent: (event: AgentLoopEvent) => {
      currentRecorder?.onAgentEvent(event);
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

  const runTurn = async (
    session: SessionState,
    userMessage: string,
    runOptions: { maxSteps?: number; signal?: AbortSignal } = {},
  ): Promise<RunTurnResult> => {
    currentRecorder = ensureRecorder(session);
    try {
      const result = await loop.runTurn(session, {
        userMessage,
        maxSteps: runOptions.maxSteps ?? config.agent.maxSteps,
        signal: runOptions.signal ?? new AbortController().signal,
      });
      sessionStore.save(result.session);
      return result;
    } finally {
      currentRecorder = null;
    }
  };

  const runtime = {
    config,
    loop,
    toolRegistry,
    skillRegistry,
    approvals,
    slotManager,
    sessionStore,
    profileStore,
    capabilities,
    toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
    grammar,
    logger,
    metrics,
    createSession,
    runTurn,
    refreshSkills,
    shutdown,
  } as AgentRuntime;
  Object.defineProperty(runtime, "skillCatalog", {
    enumerable: true,
    get: () => skillCatalog,
  });
  return runtime;
}

async function resolveModelProfile(
  overrides: CreateAgentRuntimeOptions["overrides"] | undefined,
  llama: LlamaServerClient,
  logger: StructuredLogger,
  llamaUrl: string,
) {
  if (overrides?.llamaPropsError) {
    logger.warn("model profile probe failed; using plain fallback", {
      error: overrides.llamaPropsError.message,
      url: llamaUrl,
    });
    return PLAIN_INSTRUCT_PROFILE;
  }
  if (overrides?.llamaProps) {
    return logResolvedProfile(overrides.llamaProps, logger);
  }
  if (overrides?.llamaComplete || overrides?.skipLlamaHealthCheck) {
    return PLAIN_INSTRUCT_PROFILE;
  }
  try {
    const props = await llama.fetchProps();
    return logResolvedProfile(props, logger);
  } catch (error) {
    logger.warn("model profile probe failed; using plain fallback", {
      error: error instanceof Error ? error.message : String(error),
      url: llamaUrl,
    });
    return PLAIN_INSTRUCT_PROFILE;
  }
}

function logResolvedProfile(
  props: Record<string, unknown>,
  logger: StructuredLogger,
) {
  const resolved = detectModelProfile(props);
  logger.info("model profile resolved", {
    id: resolved.id,
    alias: typeof props.model_alias === "string" ? props.model_alias : null,
    contextWindow: resolved.contextWindow ?? null,
  });
  return resolved;
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
