import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type { AtomicAgentConfig } from "../config/index.js";
import { getConfig } from "../config/index.js";

import { LlamaServerClient } from "../llm/llama-server-client.js";
import type { CompletionResult } from "../llm/llama-server-client.js";
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

import type { ApprovalRequest } from "../approval/approval-gate.js";

export interface RuntimeEventHandlers {
  onAgentEvent?: (event: AgentLoopEvent) => void;
  onApprovalRequest?: (request: ApprovalRequest) => void;
  onSkillRegistryChange?: (entries: SkillCatalogEntry[]) => void;
  logSinks?: LogSink[];
  metricSinks?: MetricSink[];
}

export interface CreateAgentRuntimeOptions {
  workingDir: string;
  approvalRequired: boolean;
  handlers?: RuntimeEventHandlers;
  /** Optional overrides — used by tests to inject fakes. */
  overrides?: {
    llamaComplete?: (params: {
      prompt: string;
      grammar: string;
      slotId: number;
      sessionId: string;
    }) => Promise<CompletionResult>;
    browserBackend?: BrowserBackend;
    skipLlamaHealthCheck?: boolean;
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

  const toolRegistry = new ToolRegistry();
  toolRegistry.register(finishTool);
  toolRegistry.register(replyTool);
  for (const tool of buildBrowserTools(browserBackend, dangerous)) {
    toolRegistry.register(tool);
  }
  registerOsTools(toolRegistry, dangerous);
  registerSkillTools(toolRegistry, skillRegistry, dangerous);

  let skillCatalog: readonly SkillCatalogEntry[] = buildSkillCatalog(
    skillRegistry.list(),
  );

  const grammar = await loadGrammar(config.paths.grammarsDir);

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

  const sessionStore = new SessionStore();

  // The `skillCatalog` is a getter so that `agent-loop` reads the current
  // value on every step — `refreshSkills()` then does not require tearing
  // down the loop.
  const loopDeps = {
    registry: toolRegistry,
    slotManager,
    grammar,
    llmComplete,
    toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
    capabilities,
    onEvent: (event: AgentLoopEvent) => options.handlers?.onAgentEvent?.(event),
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
  };

  const refreshSkills = async (): Promise<void> => {
    await skillRegistry.refresh();
    skillCatalog = buildSkillCatalog(skillRegistry.list());
    options.handlers?.onSkillRegistryChange?.([...skillCatalog]);
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
    return state;
  };

  const runTurn = async (
    session: SessionState,
    userMessage: string,
    runOptions: { maxSteps?: number; signal?: AbortSignal } = {},
  ): Promise<RunTurnResult> => {
    const result = await loop.runTurn(session, {
      userMessage,
      maxSteps: runOptions.maxSteps ?? config.agent.maxSteps,
      signal: runOptions.signal ?? new AbortController().signal,
    });
    sessionStore.save(result.session);
    return result;
  };

  const runtime = {
    config,
    loop,
    toolRegistry,
    skillRegistry,
    approvals,
    slotManager,
    sessionStore,
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

async function loadGrammar(grammarsDir: string): Promise<string> {
  const path = join(grammarsDir, "tool-call.gbnf");
  return readFile(path, "utf8");
}
