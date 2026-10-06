import type { AtomicAgentConfig } from "../../config/index.js";
import { getConfig, getTrustConfigPaths } from "../../config/index.js";
import type { CreateAgentRuntimeOptions } from "../runtime-contract.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { DangerousToolOptions } from "../../approval/dangerous-tool.js";
import type { ApprovalGate } from "../../approval/approval-gate.js";
import type { SessionStore } from "../../session/session-store.js";
import type { SkillRegistry } from "../../skills/skill-registry.js";
import type { LlamaServerClient } from "../../llm/llama-server-client.js";
import type { ProviderRegistry } from "../../llm/provider/index.js";
import { resolveLlmConfig } from "../../llm/provider/index.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import { visionCapableAlternatives } from "../../llm/provider/model-vision.js";
import { resolveModelPricingFor } from "../resolve-model-pricing.js";
import { ToolRegistry } from "../../tools/tool-registry.js";
import { finishTool } from "../../tools/finish.js";
import { replyTool } from "../../tools/conversation/index.js";
import { buildBrowserTools } from "../../tools/browser/index.js";
import type { BrowserBackend } from "../../tools/browser/browser-backend.js";
import { registerOsTools, type DeclaredInputsRegistry, type ShellJobRegistry } from "../../tools/os/index.js";
import { registerVerifyTools, runChecks } from "../../tools/verify/index.js";
import { registerGithubTools } from "../../tools/github/index.js";
import { resolveGithubToken } from "../../github/index.js";
import { registerSkillTools } from "../../tools/skill/index.js";
import { buildToolViewTool } from "../../tools/tool-view/index.js";
import { registerMemoryTools, type RegisterMemoryToolsOptions } from "../../tools/memory/index.js";
import { sessionGroundingSource, verifyProfileNameFacts } from "../../memory/name-grounding.js";
import { registerVisionTools, type RegisterVisionToolsOptions } from "../../tools/vision/index.js";
import { buildFusionDelegateTool, readSlotOccupancy, type FusionDelegateDeps } from "../../tools/fusion/index.js";
import { confineReads } from "../../tools/read-scope/index.js";
import { McpManager, buildMcpPromptGetTool, buildMcpPromptListTool, buildMcpResourceListTool, buildMcpResourceReadTool, buildMcpToolDescriptors, createMcpSamplingHandler, mergeMcpDescriptors, applyMcpToolNameRule, buildMcpToolNameRule } from "../../mcp/index.js";
import { DEFAULT_TOOL_DESCRIPTORS } from "../../prompt/tool-descriptors.js";
import type { ToolDescriptor } from "../../prompt/stable-prefix.js";
import { filterToolDescriptorsByConfig } from "../filter-disabled-tools.js";
import { readAtomicMailApiKey } from "../../atomic-mail/index.js";
import { resolveComposioServerConfig } from "../../composio/index.js";

export function createRuntimeToolRegistry(
  config: AtomicAgentConfig,
  browserBackend: BrowserBackend,
  dangerous: DangerousToolOptions,
) {


  const toolRegistry = new ToolRegistry();
  toolRegistry.register(finishTool);
  toolRegistry.register(replyTool);
  if (config.browser.enabled) {
    for (const tool of buildBrowserTools(browserBackend, dangerous)) {
      toolRegistry.register(tool);
    }
  }
  return toolRegistry;
}

export function registerRuntimeCoreTools(input: {
  config: AtomicAgentConfig;
  toolRegistry: ToolRegistry;
  dangerous: DangerousToolOptions;
  sessionStore: Pick<SessionStore, "listRecentWorkingDirs" | "listSummaryPage" | "listChatLines">;
  logger: StructuredLogger;
  resolveOriginalRequest: (sessionId: string) => string | undefined;
  declaredInputs: DeclaredInputsRegistry;
  shellJobs: ShellJobRegistry;
  skillRegistry: SkillRegistry;
} & Pick<RegisterMemoryToolsOptions, "profileStore" | "notesStore" | "lessonStore" | "procedureStore">): void {
  const { config, toolRegistry, dangerous, sessionStore, resolveOriginalRequest, declaredInputs,
    shellJobs, skillRegistry, profileStore, notesStore, lessonStore, procedureStore, logger } = input;

  registerOsTools(toolRegistry, {
    ...dangerous,
    config: {
      http: config.http,
      web: config.web,
      projects: config.projects,
      tools: config.tools,
    },
    listRecentSessionDirs: (limit) => sessionStore.listRecentWorkingDirs(limit),
    resolveOriginalRequest: resolveOriginalRequest,
    declaredInputs,
    // The trust surface (`config.json` + `.env`) is resolved once, here,
    // and injected into the fs tools — the tools layer must not know
    // where it lives. Pinned by the level-4 `trust_config` case in
    // bootstrap.test.ts.
    trustConfigPaths: getTrustConfigPaths(config.paths),
    // Lets `os.web.search` persist its result cache and provider cooldown
    // across processes (#256); `web.search.persistCache: false` opts out.
    // Pinned by the `#256` seam case in bootstrap.test.ts — the direct
    // persistence tests cannot see this line.
    stateDir: config.paths.stateDir,
    // The closed-repository switch, read live: the Integrations hub
    // writes `git.remoteSync` and resets the config cache, so the very
    // next `git push` through the shell sees the new answer without a
    // restart. The guard never reads config itself.
    shellPolicy: {
      isGitRemoteSyncEnabled: () => getConfig().git.remoteSync,
    },
    shellJobs,
  });
  // The read-only `verify.*` family: syntax per file, and (below) a
  // command / service / page run against a throwaway copy of the
  // working directory. Registered next to the OS tools because it is
  // the review half of what they build.
  registerVerifyTools(toolRegistry, {
    ...dangerous,
    config: { browser: config.browser },
  });
  // Always registered; each call resolves `GITHUB_TOKEN` afresh so a
  // token saved in the Integrations hub works on the next turn. The
  // descriptors, by contrast, are gated on the token (see
  // `rebuildToolDescriptorsFromMcp`) so the model never sees tools it
  // cannot exercise.
  registerGithubTools(toolRegistry, dangerous);
  registerSkillTools(toolRegistry, skillRegistry, dangerous);
  toolRegistry.register(buildToolViewTool());
  // Older stored names stay out of the prompt until checked against actual
  // user messages. The background walk never deletes facts or blocks boot.
  const nameGroundingSource = sessionGroundingSource(sessionStore);
  if (config.memory.profile.enabled) {
    void verifyProfileNameFacts({ store: profileStore, source: nameGroundingSource, logger })
      .catch((err: unknown) => {
        logger.warn("profile name check failed; unchecked names stay out of the prompt", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }
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
    nameGroundingSource,
  });
}

export function registerRuntimeVisionTools(input: {
  config: AtomicAgentConfig;
  toolRegistry: ToolRegistry;
  resolveCurrentVisionProvider: RegisterVisionToolsOptions["provider"];
  logger: StructuredLogger;
}): void {
  const { config, toolRegistry, resolveCurrentVisionProvider, logger } = input;

  registerVisionTools(toolRegistry, {
    provider: config.vision.enabled ? resolveCurrentVisionProvider : undefined,
    enabled: config.vision.enabled,
    maxImagesPerCall: config.vision.maxImagesPerCall,
    maxImageBytes: config.vision.maxImageBytes,
    // A refusal names vision-capable models on the same provider, read
    // from the live config so it follows the entry being refused.
    visionAlternatives: (providerId) => {
      const entry = resolveLlmConfig(getConfig()).providers.find(
        (candidate) => candidate.id === providerId,
      );
      return entry ? visionCapableAlternatives(entry) : [];
    },
    logger,
  });
}

export async function connectRuntimeMcpCatalog(input: {
  config: AtomicAgentConfig;
  options: Pick<CreateAgentRuntimeOptions, "handlers">;
  toolRegistry: ToolRegistry;
  logger: StructuredLogger;
  dangerous: DangerousToolOptions;
  llama: LlamaServerClient;
  initialGrammar: string;
  visionOnLiveRoute: () => boolean;
  resolveCurrentRunMode: () => ResolvedRunMode;
}) {
  const { config, options, toolRegistry, logger, dangerous, llama, initialGrammar,
    visionOnLiveRoute, resolveCurrentRunMode } = input;
  let grammar = initialGrammar;

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
  // server) requires `refreshMcp()` to rebuild the stable prefix /
  // grammar — see ../../mcp/docs/client.md.
  // Composio rides the same rails: when a key is configured we mint (or
  // reuse) a tool-router session and mount its hosted endpoint as one
  // more MCP server. With no key `resolveComposioServerConfig` returns
  // `undefined` and this line is the only trace of the integration —
  // no server, no tools, nothing for the model to reach for. Failure is
  // soft: an unreachable Composio must not stop the agent from booting.
  const composioServerConfig = await resolveComposioServerConfig({
    composio: config.composio,
    userConfigFile: config.paths.userConfigFile,
    logger,
  });
  const mcpServerConfigs = [
    ...(config.mcp?.servers ?? []),
    ...(composioServerConfig ? [composioServerConfig] : []),
  ];
  const mcpEnabled = mcpServerConfigs.length > 0;
  const mcpManager = new McpManager(mcpServerConfigs, {
    toolRegistry,
    logger,
    // Same approval wiring as the native dangerous tools: servers at
    // the default `approval_gated` trust get their calls routed
    // through `requireApproval` (issue #132).
    dangerous,
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
  // once when servers are present lets the live-add path (variant γ) skip a
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
      connected: mcpManager.listStatuses().filter((s) => s.state === "up")
        .length,
      tools: mcpToolMetas.length,
    });
  }

  // The descriptor stays in the prompt while the live route can see
  // (`visionRouteAvailable`) — for a local link even before the profile
  // probe lands. The descriptor blurb already says "Only available when
  // the active model + provider support multimodal input"; if the user
  // asks for image work before mmproj is loaded, the tool surfaces a
  // clear refusal naming the provider instead of silently disappearing
  // from the toolset.
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
      // Live, like the fusion gate: offered while some leg of the
      // current route can see (see `visionRouteAvailable`).
      vision: {
        enabled: config.vision.enabled,
        providerAvailable: visionOnLiveRoute(),
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
      email: {
        available:
          readAtomicMailApiKey() !== null && config.atomicMail.address !== null,
      },
      mcp: { enabled: liveMcpEnabled },
      // Read at rebuild time, not boot time: the Integrations hub calls
      // `refreshMcp()` after a token save, which lands here.
      github: { connected: resolveGithubToken() !== null },
      // The fan-out descriptor (and the `### fusion` guidance block that
      // keys off it) only exists while the resolver says fusion — an
      // orchestrator that cannot delegate must not be told it can.
      fusion: { enabled: resolveCurrentRunMode().effective === "fusion" },
    });
    if (!liveMcpEnabled) return base;
    return mergeMcpDescriptors(
      base,
      buildMcpToolDescriptors(mcpManager.listAllToolMeta()),
    );
  };
  /**
   * The descriptor list the loop reads, with a LIVE fusion gate.
   *
   * The gate cannot be a boot snapshot. `resolveCurrentRunMode()`
   * changes answer the moment the operator switches the active provider
   * or the stored mode — Manage → LLM writes the config file and resets
   * the config cache in the same breath — and a list frozen at boot left
   * the whole mode inert: an operator who started on local or cloud and
   * switched into fusion got the mode's chrome, no `fusion.delegate`
   * descriptor and no `### fusion` guidance, so the orchestrator never
   * reached for the tool and fusion silently did nothing until a
   * restart.
   *
   * Rebuilding is not free (it filters the whole catalog and re-merges
   * the MCP descriptors), so the array is memoised on the gate: while
   * the gate holds, every read returns the *same array identity* and the
   * stable prefix stays byte-identical. When the gate flips the prefix
   * legitimately changes once and that session's KV cache is dropped —
   * exactly what installing a skill or live-adding an MCP server
   * (`refreshMcp`) already costs, and for the same reason: the tool
   * catalog changed, so the prefix must.
   */
  //
  // The vision gate is memoised the same way and for the same reason:
  // switching to a provider that cannot see drops `vision.describe`
  // from the prompt, switching back restores it — one prefix change per
  // flip, none while the route holds.
  const liveDescriptorGates = (): string =>
    `${resolveCurrentRunMode().effective === "fusion"}|${visionOnLiveRoute()}`;
  let cachedToolDescriptors = rebuildToolDescriptorsFromMcp();
  let cachedDescriptorGates = liveDescriptorGates();
  const rebuildToolDescriptors = (): readonly ToolDescriptor[] => {
    cachedDescriptorGates = liveDescriptorGates();
    cachedToolDescriptors = rebuildToolDescriptorsFromMcp();
    return cachedToolDescriptors;
  };
  const effectiveToolDescriptors = (): readonly ToolDescriptor[] =>
    liveDescriptorGates() === cachedDescriptorGates
      ? cachedToolDescriptors
      : rebuildToolDescriptors();
  const createRefreshMcp = () => {


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
      rebuildToolDescriptors();
      logger.info("mcp: catalog refreshed", {
        servers: serverCount,
        tools: metas.length,
      });
    };
    return refreshMcp;
  };
  return { mcpManager, getGrammar: () => grammar, effectiveToolDescriptors, createRefreshMcp };
}

export function registerRuntimeFusionAndReadScope(input: {
  config: AtomicAgentConfig;
  toolRegistry: ToolRegistry;
  runTurn: FusionDelegateDeps["runTurn"];
  createEphemeralSession: FusionDelegateDeps["createEphemeralSession"];
  resolveOriginalRequest: (sessionId: string) => string | undefined;
  declaredInputs: DeclaredInputsRegistry;
  prepareLocalLink: FusionDelegateDeps["warmWorkerBackend"];
  emitAgentLoopEventFor: FusionDelegateDeps["emitEvent"];
  resolveCurrentRunMode: FusionDelegateDeps["resolveRunMode"];
  providerRegistry: Pick<ProviderRegistry, "getProvider">;
  llama: Pick<LlamaServerClient, "measuredTokensPerSecond" | "fetchSlots">;
  approvals: ApprovalGate;
  dangerous: DangerousToolOptions;
  slotManager: FusionDelegateDeps["slotManager"];
  workingDir: string;
  logger: StructuredLogger;
}): void {
  const { config, toolRegistry, runTurn, createEphemeralSession, resolveOriginalRequest, declaredInputs,
    prepareLocalLink, emitAgentLoopEventFor, resolveCurrentRunMode, providerRegistry,
    llama, approvals, dangerous, slotManager, workingDir, logger } = input;


  // The orchestrator's fan-out. Registered UNCONDITIONALLY: the tool
  // re-reads `resolveRunMode()` on every call and refuses when fusion is
  // not effective, which is the correct and only gate it needs. A boot
  // gate here was worse than redundant — it made the tool unreachable
  // for the rest of the process to anyone who switched into fusion
  // mid-session, so the mode ran with its chip, its tint and its config
  // and no way to delegate. What the model is *told* about still tracks
  // the live mode: `effectiveToolDescriptors()` adds and drops the
  // descriptor (and with it the `### fusion` guidance) as the resolver's
  // answer changes.
  toolRegistry.register(
    buildFusionDelegateTool({
      runTurn: (session, userMessage, turnOptions) =>
        runTurn(session, userMessage, turnOptions),
      createEphemeralSession,
      resolveOriginalRequest: resolveOriginalRequest,
      declaredInputs,
      // The worker leg's pricing, when the catalogue or a hand-priced
      // entry knows it — the status table's spend line.
      resolveWorkerPricing: (providerId, modelId) =>
        resolveModelPricingFor(
          resolveLlmConfig(getConfig()),
          modelId,
          providerId,
        )?.pricing,
      // The same client the llama-server provider serves workers with,
      // so the speed a worker's time limit is sized from is the speed
      // its own completions run at.
      localTokensPerSecond: () => llama.measuredTokensPerSecond(),
      probeSlotOccupancy: async () => {
        try {
          return readSlotOccupancy(await llama.fetchSlots());
        } catch {
          return null;
        }
      },
      approvals,
      approvalRequired: dangerous.approvalRequired,
      slotManager,
      resolveRunMode: resolveCurrentRunMode,
      workerSupportsSlotAffinity: (providerId) =>
        providerRegistry.getProvider(providerId)?.capabilities
          .supportsSlotAffinity ?? false,
      warmWorkerBackend: prepareLocalLink,
      // The PARENT's id, explicitly: the hook these fire from runs
      // under the worker's ALS frame, where the ambient session is a
      // throwaway nobody is listening to.
      emitEvent: emitAgentLoopEventFor,
      workingDir,
      outputCharCap: config.agent.batchToolResultCharCap,
      // A contract's declared `checks` run through the verify family,
      // each on a throwaway copy of the workspace, so a fan-out is judged
      // by what its output does, never by what a worker's reply says.
      runChecks: (specs, ctx) =>
        runChecks(specs, {
          workingDir: ctx.workingDir,
          signal: ctx.signal,
          config,
        }),
      logger,
    }),
  );
  // Every session reads inside its working directory and the paths the
  // user named unasked, by default (`agent.readScope`,
  // `src/tools/read-scope/`); a read outside that asks through the
  // ladder as `fs_read_outside` — the same gate and surfaces as every
  // other gated action — and a `y` widens the session's roots. A fusion
  // worker is confined more narrowly still — its working directory and
  // its fan-out's write scope, never the brief's — and refused, since
  // nobody is at the other end of its prompt. The shell gets the same
  // scope as a token check. Installed here, after every native
  // filesystem tool and the shell are registered. The scope is re-read
  // per call, so `agent.readScope: "unrestricted"` needs no restart.
  confineReads(toolRegistry, {
    grantedDirs: (sessionId) => approvals.fanoutScopes.scopeFor(sessionId),
    readScope: () => getConfig().agent.readScope,
    approvals: dangerous,
  });
}
