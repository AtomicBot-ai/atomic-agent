import type { AtomicAgentConfig } from "../../config/index.js";
import { DEFAULT_MAX_AUDIO_BYTES, getConfig, getStateSecretPaths, getTrustConfigPaths } from "../../config/index.js";
import type { CreateAgentRuntimeOptions } from "../runtime-contract.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { DangerousToolOptions } from "../../approval/dangerous-tool.js";
import type { ApprovalGate } from "../../approval/approval-gate.js";
import type { SessionStore } from "../../session/session-store.js";
import type { SkillRegistry } from "../../skills/skill-registry.js";
import { LlamaServerClient } from "../../llm/llama-server-client.js";
import { renewTransportPool } from "../../llm/transport-deadlines.js";
import type { ProviderRegistry } from "../../llm/provider/index.js";
import { resolveLlmConfig } from "../../llm/provider/index.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import { visionCapableAlternatives } from "../../llm/provider/model-vision.js";
import { providerIdIsLlamaServer } from "../../llm/provider/registry/active-text-provider.js";
import { audioInputAllowedOn } from "../vision-route.js";
import { resolveModelPricingFor } from "../resolve-model-pricing.js";
import type { SessionUsageLedger } from "../../session/usage-meter.js";
import type { CostAccumulator } from "../../llm/provider/cost-accumulator.js";
import { isLocalServerUrl } from "../../llm/provider/openai/local-server-url.js";
import { ToolRegistry } from "../../tools/tool-registry.js";
import { FileCheckpointStore, fileCheckpointsRoot } from "../../tools/os/fs/fs-checkpoint-store.js";
import { checkpointBeforeInvoke } from "../../tools/os/fs/fs-checkpoint-targets.js";
import { knownSecretsFromEnv, type KnownSecret } from "../../error-reporting/secret-detector.js";
import { commandIssuedSecrets } from "../../llm/provider/openai/api-key-command.js";
import { isSecretEnvName } from "../../sandbox/command-env.js";
import { resolveExtraApiKeys } from "../../config/resolve-llm-api-key.js";
import type { ToolOutputSpill } from "../../tools/tool-output-spill.js";
import { finishTool } from "../../tools/finish.js";
import { buildAskUserTool, replyTool } from "../../tools/conversation/index.js";
import { browserScenarioDir, buildBrowserPageRenderer, buildBrowserTools, UserSiteApprovals, type BrowserExtractModelRef } from "../../tools/browser/index.js";
import type { BrowserBackend } from "../../tools/browser/browser-backend.js";
import { registerOsScreenTools, registerOsTools, type DeclaredInputsRegistry, type ShellJobRegistry, type WebSearchKeyHelp } from "../../tools/os/index.js";
import { registerVerifyTools, runChecks } from "../../tools/verify/index.js";
import { registerGithubTools } from "../../tools/github/index.js";
import { resolveGithubToken } from "../../github/index.js";
import { registerSkillTools, skillNameForPath, trackSkillEdits } from "../../tools/skill/index.js";
import { SkillChangeRecorder, skillCuratorPaths } from "../../skills/curator/index.js";
import { isProjectFolderTrusted } from "../../skills/project-trust.js";
import { buildToolViewTool } from "../../tools/tool-view/index.js";
import { planUpdateTool } from "../../tools/plan/index.js";
import { buildCanvasRenderTool } from "../../tools/canvas/index.js";
import { applyToolSearch, buildToolSearchTool, deferredToolNames, toolSearchActive } from "../../tools/tool-search/index.js";
import { buildSessionsSearchTool, registerMemoryTools, type RegisterMemoryToolsOptions } from "../../tools/memory/index.js";
import { buildFilesSearchTool, type FileIndexApi } from "../../tools/files/index.js";
import { registerLogbookTools } from "../../tools/logbook/index.js";
import { logbookToolOffered } from "../../logbook/index.js";
import { sessionGroundingSource, verifyProfileNameFacts } from "../../memory/name-grounding.js";
import { registerVisionTools, type RegisterVisionToolsOptions } from "../../tools/vision/index.js";
import { IMAGE_GENERATE_TOOL, openRouterImageKey, registerImageTools } from "../../tools/image/index.js";
import { registerVideoTools, VIDEO_GENERATE_TOOL, VIDEO_RENDER_HTML_TOOL } from "../../tools/video/index.js";
import { AUDIO_TRANSCRIBE_TOOL, registerAudioListenTools, registerAudioTools } from "../../tools/audio/index.js";
import { captureImageGenerated, captureVideoGenerated } from "../../analytics/analytics-events.js";
import type { AnalyticsClient } from "../../analytics/analytics-client.js";
import { buildFusionDelegateTool, readSlotOccupancy, servedModelName, type FusionDelegateDeps } from "../../tools/fusion/index.js";
import { MintedSessionMetadata, buildSubagentRunTool } from "../../tools/subagent/index.js";
import { confineReads } from "../../tools/read-scope/index.js";
import { McpManager, buildMcpPromptGetTool, buildMcpPromptListTool, buildMcpResourceListTool, buildMcpResourceReadTool, buildMcpToolDescriptors, createMcpSamplingHandler, mergeMcpDescriptors, applyMcpToolNameRule, buildMcpToolNameRule } from "../../mcp/index.js";
import { DEFAULT_TOOL_DESCRIPTORS } from "../../prompt/tool-descriptors.js";
import type { McpServerConfig } from "../../mcp/mcp-types.js";
import { mcpAppsUiFromEnv } from "../../mcp/mcp-apps.js";
import { loadPluginMcpServers } from "../../plugins/plugin-mcp.js";
import { createPluginMcpLiveStop } from "../../plugins/plugin-mcp-live.js";
import { listPluginSubagents } from "../../plugins/plugin-subagents.js";
import { loadAgentProfiles, normaliseProfileName, readSettingsAgentProfiles, type AgentProfile } from "../../agent-profiles/index.js";
import type { ToolDescriptor } from "../../prompt/stable-prefix.js";
import { filterToolDescriptorsByConfig } from "../filter-disabled-tools.js";
import { readAtomicMailApiKey } from "../../atomic-mail/index.js";
import { resolveComposioServerConfig } from "../../composio/index.js";
import { activePolicy, mcpServerPolicy } from "../../policy/index.js";
import { isForeignLlamaServer } from "../../llm/run-mode/foreign-llama-server.js";

export { isForeignLlamaServer };

/** Header names whose value is a credential (`Authorization`, `X-Api-Key`, `Cookie`, ...). */
const SECRET_HEADER = /authorization|api[-_]?key|token|secret|password|cookie|auth/i;

/**
 * The exact secrets masked in tool output (ATO-1077): the agent's `.env`
 * (loaded into `process.env`) and the credentials stored in the config
 * file: provider keys and secret headers, the local server's key,
 * webhook secrets, MCP servers' secret env values and headers, and the
 * tokens provider key commands printed this process (Vertex AI). Read
 * per call, so a key added through `/providers` mid-session is covered.
 */
export function runtimeKnownSecrets(
  config: Partial<Pick<AtomicAgentConfig, "llm" | "localModels" | "webhooks" | "mcp">>,
  env: NodeJS.ProcessEnv = process.env,
): KnownSecret[] {
  const out = knownSecretsFromEnv(env);
  const add = (label: string, value: unknown): void => {
    if (typeof value === "string" && value.length > 0) out.push({ label, value });
  };
  const addHeaders = (label: string, headers: Readonly<Record<string, string>> | undefined): void => {
    for (const [name, value] of Object.entries(headers ?? {})) {
      if (!SECRET_HEADER.test(name)) continue;
      add(label, value);
      // `Bearer <token>` also appears without its scheme.
      const token = /^\S+\s+(\S{8,})$/.exec(value)?.[1];
      if (token !== undefined) add(label, token);
    }
  };
  for (const entry of config.llm?.providers ?? []) {
    add(`${entry.id}-key`, entry.apiKey);
    // Masking only: every named variable, the OpenAI ones included (ATO-1703).
    for (const extra of resolveExtraApiKeys(entry, env, { scopeOpenAiKey: false })) {
      add(`${entry.id}-key`, extra);
    }
    addHeaders(`${entry.id}-header`, entry.headers);
  }
  // Tokens printed by provider key commands (Vertex AI) live only in memory.
  for (const secret of commandIssuedSecrets()) add(secret.label, secret.value);
  add("local-models-key", config.localModels?.apiKey);
  for (const [name, hook] of Object.entries(config.webhooks ?? {})) {
    add(`webhook-${name}-secret`, hook.secret);
  }
  for (const server of config.mcp?.servers ?? []) {
    for (const [name, value] of Object.entries(server.env ?? {})) {
      if (isSecretEnvName(name)) add(`mcp-${server.name}-${name}`, value);
    }
    if (server.transport.kind !== "stdio") addHeaders(`mcp-${server.name}-header`, server.transport.headers);
  }
  return out;
}

/**
 * Enabled plugins' `agents/*.md` as subagent profiles, named
 * `plugin:agent`; a name that does not normalise is skipped.
 */
function pluginAgentProfiles(stateDir: string): AgentProfile[] {
  const out: AgentProfile[] = [];
  for (const p of listPluginSubagents(stateDir).profiles) {
    const [plugin, agent] = [normaliseProfileName(p.plugin), normaliseProfileName(p.name.slice(p.plugin.length + 1))];
    if (plugin === null || agent === null || p.prompt.trim().length === 0) continue;
    out.push({
      name: `${plugin}:${agent}`,
      description: p.description,
      prompt: p.prompt.trim(),
      ...(p.model === undefined ? {} : { model: p.model }),
      ...(p.tools.length === 0 ? {} : { tools: p.tools }),
      source: "plugin",
      file: p.file,
    });
  }
  return out;
}

export function createRuntimeToolRegistry(
  config: AtomicAgentConfig,
  browserBackend: BrowserBackend,
  dangerous: DangerousToolOptions,
  outputSpill?: ToolOutputSpill,
  /** The model `browser.extract` calls; bootstrap fills it in once the completer exists. */
  browserExtract: BrowserExtractModelRef = {},
) {


  const toolRegistry = new ToolRegistry({
    ...(outputSpill ? { outputSpill } : {}),
    knownSecrets: () => runtimeKnownSecrets(getConfig()),
    // Outside text read on a session holds its risky silent approvals
    // for the rest of the turn when `agent.taintReview` is on (ATO-618).
    onUntrustedOutput: (sessionId, source) =>
      dangerous.approvals.noteUntrustedContent(sessionId, source),
    // "Roll back here" (ATO-1056): what a file tool is about to change is
    // saved first, per session, so a chat can be taken back with its files.
    beforeInvoke: checkpointBeforeInvoke(new FileCheckpointStore(fileCheckpointsRoot(config.paths.stateDir))),
  });
  toolRegistry.register(finishTool);
  toolRegistry.register(replyTool);
  if (config.browser.enabled) {
    const domainPolicy = {
      blockedDomains: config.browser.blockedDomains,
      allowedDomains: config.browser.allowedDomains,
      userProfile: config.browser.connect === "user-chrome",
      ...(config.browser.connect === "user-chrome" ? { userSites: new UserSiteApprovals() } : {}),
      // ATO-1377: the same switch as os.web.fetch and os.http.request.
      ...(config.http.urlDataGuard !== undefined ? { urlDataGuard: config.http.urlDataGuard } : {}),
    };
    for (const tool of buildBrowserTools(
      browserBackend,
      dangerous,
      domainPolicy,
      browserExtract,
      browserScenarioDir(config.paths.stateDir),
    )) {
      toolRegistry.register(tool);
    }
  }
  return toolRegistry;
}

/**
 * The `os.web.fetch` browser step (ATO-968): only the agent's own
 * browser, only when the browser tools are on, under the same domain
 * lists. The user's own Chrome is never read in the background.
 */
function webFetchRenderer(
  config: AtomicAgentConfig,
  backend: BrowserBackend | undefined,
): { webFetchRenderPage?: ReturnType<typeof buildBrowserPageRenderer> } {
  if (backend === undefined || !config.browser.enabled) return {};
  if (config.browser.connect === "user-chrome") return {};
  return {
    webFetchRenderPage: buildBrowserPageRenderer(backend, {
      blockedDomains: config.browser.blockedDomains,
      allowedDomains: config.browser.allowedDomains,
    }),
  };
}

export function registerRuntimeCoreTools(input: {
  config: AtomicAgentConfig;
  toolRegistry: ToolRegistry;
  dangerous: DangerousToolOptions;
  sessionStore: Pick<SessionStore, "listRecentWorkingDirs" | "listSummaryPage" | "listChatLines" | "searchTranscripts" | "listSearchableChatLines">
    & Partial<Pick<SessionStore, "isIncognito">>;
  logger: StructuredLogger;
  resolveOriginalRequest: (sessionId: string) => string | undefined;
  resolvePreviousReply?: (sessionId: string) => string | undefined;
  /** Whether the session's running turn can show an `ask_user` card (ATO-489). */
  canAskUser?: (sessionId: string) => boolean;
  declaredInputs: DeclaredInputsRegistry;
  shellJobs: ShellJobRegistry;
  skillRegistry: SkillRegistry;
  /** Where the user adds an Exa key, for the web-search error (ATO-345). */
  webSearchKeyHelp?: WebSearchKeyHelp;
  /** The agent's browser, for the `os.web.fetch` bot-wall step (ATO-968). */
  browserBackend?: BrowserBackend;
  /** "My files" (ATO-1621): `files.search` is registered when there is an index. */
  fileIndex?: FileIndexApi;
} & Pick<RegisterMemoryToolsOptions, "profileStore" | "notesStore" | "lessonStore" | "procedureStore">): void {
  const { config, toolRegistry, dangerous, sessionStore, resolveOriginalRequest, resolvePreviousReply, declaredInputs,
    shellJobs, skillRegistry, profileStore, notesStore, lessonStore, procedureStore, logger,
    webSearchKeyHelp, canAskUser, fileIndex } = input;

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
    resolvePreviousReply,
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
    ...(webSearchKeyHelp === undefined ? {} : { webSearchKeyHelp }),
    ...webFetchRenderer(config, input.browserBackend),
    // A folder the operator trusted (any project skill or instruction
    // file said yes to) starts language servers without a question
    // (ATO-503). Read live, like the skill gate.
    isTrustedProject: (dir) => isProjectFolderTrusted(config.paths.userConfigFile, config.skills.projectTrust, dir),
  });
  // Computer use (ATO-525): screenshot, click, type, key — macOS, and
  // the screenshot alone on Windows and Linux (ATO-527); opt-in
  // (`tools.screen.enabled`, default off). A screenshot asks as
  // `screen_capture`, every input action as `screen_control`; the
  // descriptors follow the same gate below.
  registerOsScreenTools(toolRegistry, {
    ...dangerous,
    enabled: config.tools.screen.enabled,
    // ATO-1018: drawing marks only (and the screenshot it reads), on by default.
    point: config.tools.screen.point,
  });
  // The read-only `verify.*` family: syntax per file, and (below) a
  // command / service / page run against a throwaway copy of the
  // working directory. Registered next to the OS tools because it is
  // the review half of what they build.
  registerVerifyTools(toolRegistry, {
    ...dangerous,
    config: { browser: config.browser },
    // The same guard policy as `os.shell.run`: a `git push` started by
    // verify.run obeys the remote-sync switch too (ATO-1266).
    shellPolicy: {
      isGitRemoteSyncEnabled: () => getConfig().git.remoteSync,
    },
  });
  // Always registered; each call resolves `GITHUB_TOKEN` afresh so a
  // token saved in the Integrations hub works on the next turn. The
  // descriptors, by contrast, are gated on the token (see
  // `rebuildToolDescriptorsFromMcp`) so the model never sees tools it
  // cannot exercise.
  registerGithubTools(toolRegistry, dangerous);
  // Skill scripts inherit the shell's filtered environment and its
  // passthrough list (ATO-877): one answer to "which keys reach a child".
  // Skill history (ATO-580): every `skill.view` / `skill.run_script` of a
  // user-installed skill counts as a use, and the file tools snapshot a
  // skill folder before the agent changes it and log the change after.
  const skillHistory = new SkillChangeRecorder(config.paths.globalSkillsDir, skillCuratorPaths(config.paths.stateDir));
  const reportSkillHistoryError = (err: unknown, tool: string): void => {
    logger.warn("skill history: bookkeeping failed; the tool call was not affected", {
      tool,
      error: err instanceof Error ? err.message : String(err),
    });
  };
  registerSkillTools(
    toolRegistry,
    skillRegistry,
    dangerous,
    config.tools.shell.envPassthrough,
    config.paths.stateDir,
    (record) => {
      if (record.source !== "global" || record.plugin !== undefined) return;
      const name = skillNameForPath(config.paths.globalSkillsDir, record.rootDir);
      if (name === null) return;
      void skillHistory.recordUse(name).catch((err: unknown) => reportSkillHistoryError(err, "skill usage"));
    },
  );
  trackSkillEdits(toolRegistry, { recorder: skillHistory, onError: reportSkillHistoryError });
  // `tool.view` is registered with `tool.search` in the MCP catalog phase:
  // it reads the same live descriptor list.
  // The live checklist (ATO-486): pure, always on, no approval.
  toolRegistry.register(planUpdateTool);
  // ATO-1137: a chart or HTML page saved as a new file in the working
  // folder and shown in the chat as a canvas. Always on; the write goes
  // through the fs approval funnel like `os.fs.write`.
  toolRegistry.register(buildCanvasRenderTool({
    ...dangerous,
    trustConfigPaths: getTrustConfigPaths(config.paths),
  }));
  // Clarifying questions with ready answers (ATO-489): through the
  // approval gate, so the turn waits like an approval and only the
  // person answers. Registered for the whole process, but each turn
  // offers it only where a question card is drawn (TUI, CLI, Telegram,
  // an HTTP client sending `X-Atomic-Questions`): `surfaceShowsQuestions`
  // in executeTurn. Hidden from the desktop until ATO-1502 ships its card.
  // A call from a turn where it is hidden is answered at once, no question raised.
  toolRegistry.register(buildAskUserTool({
    approvals: dangerous.approvals,
    ...(canAskUser !== undefined ? { canAsk: canAskUser } : {}),
  }));
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
    // ATO-586: an incognito chat's memory writes are refused.
    ...(sessionStore.isIncognito
      ? { isIncognitoSession: (sessionId: string) => sessionStore.isIncognito!(sessionId) }
      : {}),
  });
  // ATO-1151: search past chats word for word, then read around a hit.
  // Read-only and always on; the index is built on the first search.
  toolRegistry.register(buildSessionsSearchTool({ source: sessionStore }));
  // ATO-1621: passages from the folders in My files, with ready citations.
  if (fileIndex) toolRegistry.register(buildFilesSearchTool({ index: fileIndex }));
  // ATO-2363: reads the local logbook; its descriptor is gated live below.
  registerLogbookTools(toolRegistry, { stateDir: config.paths.stateDir });
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
  // `audio.listen` (ATO-497, decision 62): registered unless
  // `vision.audioInput` is `false`; the descriptor gate
  // (`audioOnLiveRoute`) offers it. Unset (auto) means a local model
  // that reports audio only, so a call on a cloud link is refused
  // unless the operator set `true`. Each call also checks the model can hear.
  const audioInput = config.vision.audioInput;
  registerAudioListenTools(toolRegistry, {
    provider: resolveCurrentVisionProvider,
    enabled: audioInput !== false,
    maxAudioBytes: config.vision.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES,
    allowProvider: (provider) =>
      audioInputAllowedOn(
        providerIdIsLlamaServer(resolveLlmConfig(getConfig()), provider.id),
        audioInput,
      ),
  });
}

/**
 * `image.generate`: registered always, offered while an OpenRouter key is
 * configured (the `image` gate below). Key, data folder and analytics
 * client are read per call, so a key saved or analytics turned off
 * mid-session applies to the next picture.
 */
export function registerRuntimeImageTools(input: {
  toolRegistry: ToolRegistry;
  dangerous: DangerousToolOptions;
  getAnalytics: () => AnalyticsClient | null;
  /** Absent: no progress lines (the Core download on the first picture goes unannounced). */
  emitAgentLoopEventFor?: FusionDelegateDeps["emitEvent"];
}): void {
  const { toolRegistry, dangerous, getAnalytics, emitAgentLoopEventFor } = input;
  registerImageTools(toolRegistry, {
    ...dangerous,
    dataDir: () => getConfig().paths.localModelsDataDir,
    openRouterKey: () => openRouterImageKey(getConfig()),
    report: (event) => captureImageGenerated(getAnalytics(), event),
    ...(emitAgentLoopEventFor ? {
      onProgress: (sessionId: string, update: { fraction: number; elapsedMs: number; label: string }) => emitAgentLoopEventFor(sessionId, {
        type: "tool_progress", tool: IMAGE_GENERATE_TOOL, fraction: update.fraction, elapsedMs: update.elapsedMs, label: update.label,
      }),
    } : {}),
  });
}

/**
 * `video.generate`: registered always, offered while an OpenRouter key is
 * configured (the `video` gate below), like `image.generate`. Its
 * progress reaches the session's UIs as `tool_progress` events.
 * `video.render_html` (ATO-1164) rides along: local, free, ungated.
 */
export function registerRuntimeVideoTools(input: {
  toolRegistry: ToolRegistry;
  dangerous: DangerousToolOptions;
  getAnalytics: () => AnalyticsClient | null;
  emitAgentLoopEventFor: FusionDelegateDeps["emitEvent"];
}): void {
  const { toolRegistry, dangerous, getAnalytics, emitAgentLoopEventFor } = input;
  registerVideoTools(toolRegistry, {
    ...dangerous,
    dataDir: () => getConfig().paths.localModelsDataDir,
    openRouterKey: () => openRouterImageKey(getConfig()),
    report: (event) => captureVideoGenerated(getAnalytics(), event),
    onProgress: (sessionId, update) => emitAgentLoopEventFor(sessionId, {
      type: "tool_progress", tool: VIDEO_GENERATE_TOOL, fraction: update.fraction, elapsedMs: update.elapsedMs, label: update.label,
    }),
    // ATO-1164: HTML page to .mp4 on the local browser and ffmpeg, ungated.
    renderHtml: {
      browserConfig: () => getConfig(),
      trustConfigPaths: () => getTrustConfigPaths(getConfig().paths),
      onProgress: (sessionId, update) => emitAgentLoopEventFor(sessionId, {
        type: "tool_progress", tool: VIDEO_RENDER_HTML_TOOL, fraction: update.fraction, elapsedMs: update.elapsedMs, label: update.label,
      }),
    },
  });
}

/**
 * `audio.transcribe` (ATO-702): speech to text with whisper.cpp, always
 * on. What it lacks on first use (the speech model; on Windows and Linux
 * the whisper.cpp build) downloads into the models folder after an
 * `http` approval; the download's progress reaches the session's UIs as
 * `tool_progress` events, like `video.generate`.
 */
export function registerRuntimeAudioTools(input: {
  toolRegistry: ToolRegistry;
  dangerous: DangerousToolOptions;
  emitAgentLoopEventFor: FusionDelegateDeps["emitEvent"];
}): void {
  const { toolRegistry, dangerous, emitAgentLoopEventFor } = input;
  registerAudioTools(toolRegistry, {
    ...dangerous,
    dataDir: () => getConfig().paths.localModelsDataDir,
    onProgress: (sessionId, update) => emitAgentLoopEventFor(sessionId, {
      type: "tool_progress", tool: AUDIO_TRANSCRIBE_TOOL, fraction: update.fraction, elapsedMs: update.elapsedMs, label: update.label,
    }),
  });
}

/** What `connectRuntimeMcpCatalog` tells about the MCP grammar it applies. */
export interface McpGrammarHolder {
  setMcpToolNameRule(rule: string | null, nativeTools: boolean): void;
}

/**
 * The bootstrap seam between the MCP catalog and the hot-swap
 * `ModelProfileManager`: the agent loop reads the manager's grammar
 * before the catalog's, so without this hook the manager's grammar
 * would admit no MCP tools at all (ATO-1029). No manager, no hook.
 */
export function mcpGrammarHookFor(holder: McpGrammarHolder | null | undefined): {
  onMcpToolNameRule?: (rule: string | null, nativeTools: boolean) => void;
} {
  return holder ? { onMcpToolNameRule: (rule, nativeTools) => holder.setMcpToolNameRule(rule, nativeTools) } : {};
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
  /** Live audio gate (`audioRouteAvailable`); absent reads as off. */
  audioOnLiveRoute?: () => boolean;
  resolveCurrentRunMode: () => ResolvedRunMode;
  /**
   * Told every MCP tool-name rule this catalog applies, so a grammar held
   * elsewhere (the hot-swap `ModelProfileManager`, which the agent loop
   * reads first) admits the same `mcp.*` names (ATO-1029); `nativeTools`
   * is whether the `mcp.resource.*` / `mcp.prompt.*` tools are registered.
   */
  onMcpToolNameRule?: (rule: string | null, nativeTools: boolean) => void;
  /**
   * The live route's context window, when known. `agent.tools.search:
   * "auto"` defers the non-core tools behind `tool.search` on a small
   * one (ATO-558). Absent ⇒ only the catalog size decides.
   */
  resolveContextWindow?: () => number | null | undefined;
}) {
  const { config, options, toolRegistry, logger, dangerous, llama, initialGrammar,
    visionOnLiveRoute, resolveCurrentRunMode, onMcpToolNameRule, resolveContextWindow } = input;
  const audioOnLiveRoute = input.audioOnLiveRoute ?? ((): boolean => false);
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
  // Servers from installed plugins (ATO-562) ride the same rails, named
  // `<plugin>-<server>` and always approval-gated. A broken plugin only logs.
  const ownServers = [
    ...(config.mcp?.servers ?? []),
    ...(composioServerConfig ? [composioServerConfig] : []),
  ];
  const ownServerNames = new Set(ownServers.map(s => s.name));
  const pluginMcp = safePluginMcpServers(config.paths.stateDir, ownServerNames, logger);
  const mcpServerConfigs = [...ownServers, ...pluginMcp.servers];
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
    // ATO-704 / ATO-1492: only a host that wires a port (serve does)
    // makes servers see the elicitation capability (see docs/client.md).
    ...(options.handlers?.onMcpElicitation
      ? { elicitationPort: options.handlers.onMcpElicitation }
      : {}),
    // Browser sign-ins of remote servers live in `<stateDir>/mcp-oauth/`.
    oauthStateDir: config.paths.stateDir,
    // ATO-1135: a host that renders MCP Apps pages (the desktop app) says so
    // with ATOMIC_AGENT_MCP_APPS_UI; only then do clients advertise the
    // extension and read a tool's `ui://` page after a call.
    ...(mcpAppsUiFromEnv() ? { appsUi: true } : {}),
    // Admin MCP allowlist (ATO-587), read live so a refreshed policy applies on restart.
    serverPolicy: (server) => mcpServerPolicy(activePolicy(), server),
    ...(options.handlers?.onChannelStatus
      ? {
          onStatus: (status) =>
            options.handlers!.onChannelStatus!({
              channel: `mcp:${status.name}`,
              // The channel contract has no sign-in state; "down" with
              // "Sign in required" as the error says the same thing.
              state: status.state === "needs_auth" ? "down" : status.state,
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
    grammar = applyMcpToolNameRule(baseGrammar, rule, mcpMetaToolsRegistered);
    onMcpToolNameRule?.(rule, mcpMetaToolsRegistered);
    logger.info("mcp: manager started", {
      configured: mcpServerConfigs.length,
      connected: mcpManager.listStatuses().filter((s) => s.state === "up")
        .length,
      tools: mcpToolMetas.length,
    });
  } else {
    // MCP off: neither the native `mcp.resource.*` / `mcp.prompt.*` tools
    // nor any per-server tool is registered, so the grammar names none.
    grammar = applyMcpToolNameRule(baseGrammar, null, false);
    onMcpToolNameRule?.(null, false);
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
      // Live, like vision: unset `vision.audioInput` offers it only on a
      // local model that reports audio (decision 62).
      audio: { enabled: audioOnLiveRoute() },
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
      sessions: {
        agentToolsEnabled:
          config.tasks.enabled && config.tasks.sessionToolsEnabled === true,
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
      // The other side of the same gate (ATO-1670): subagent.run is
      // offered outside Fusion, where fusion.delegate is not.
      subagent: { enabled: resolveCurrentRunMode().effective !== "fusion" },
      image: { available: openRouterImageKey(getConfig()) !== undefined },
      // Same key, same reason: every clip is made on OpenRouter.
      video: { available: openRouterImageKey(getConfig()) !== undefined },
      // Boot-time, like the registration above: the tools exist only when
      // they were switched on before start. All of them on a Mac; capture
      // alone on Windows and Linux (ATO-527).
      screen: {
        enabled:
          config.tools.screen.enabled &&
          (process.platform === "darwin" || process.platform === "win32" || process.platform === "linux"),
        point: config.tools.screen.point && process.platform === "darwin",
        control: process.platform === "darwin",
      },
      logbook: { enabled: logbookToolOffered(config.paths.stateDir) },
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
  // flip, none while the route holds. The image gate too: saving or
  // removing an OpenRouter key adds or drops `image.generate` and
  // `video.generate` (one gate value: they share the key).
  //
  // Tool search (ATO-558) is one more gate: when `agent.tools.search`
  // (live config) and the route's window or the catalog size say so,
  // the prompt describes only the core tools in full and lists the rest
  // as one-liners behind `tool.search`. `fullToolDescriptors` keeps the
  // undeferred list — what `tool.search` searches and loads from.
  let fullToolDescriptors = rebuildToolDescriptorsFromMcp();
  const toolSearchOn = (): boolean =>
    toolSearchActive(
      getConfig().agent.tools?.search ?? "auto",
      fullToolDescriptors.length,
      resolveContextWindow?.(),
    );
  const liveDescriptorGates = (): string =>
    `${resolveCurrentRunMode().effective === "fusion"}|${visionOnLiveRoute()}|${audioOnLiveRoute()}|${openRouterImageKey(getConfig()) !== undefined}|${toolSearchOn()}|${logbookToolOffered(config.paths.stateDir)}`;
  let cachedDescriptorGates = liveDescriptorGates();
  let cachedToolDescriptors = applyToolSearch(fullToolDescriptors, toolSearchOn());
  const rebuildToolDescriptors = (): readonly ToolDescriptor[] => {
    fullToolDescriptors = rebuildToolDescriptorsFromMcp();
    cachedDescriptorGates = liveDescriptorGates();
    cachedToolDescriptors = applyToolSearch(fullToolDescriptors, toolSearchOn());
    return cachedToolDescriptors;
  };
  const effectiveToolDescriptors = (): readonly ToolDescriptor[] =>
    liveDescriptorGates() === cachedDescriptorGates
      ? cachedToolDescriptors
      : rebuildToolDescriptors();
  // Registered whatever the mode: its descriptor is only in the prompt
  // while search mode is on, and a call outside it still searches the
  // full catalog harmlessly.
  const toolSearchCatalog = () => {
    const effective = effectiveToolDescriptors();
    return {
      descriptors: fullToolDescriptors,
      deferred: deferredToolNames(fullToolDescriptors, effective),
    };
  };
  toolRegistry.register(buildToolSearchTool({ catalog: toolSearchCatalog }));
  // `tool.view` loads by exact name any tool search mode deferred to a
  // `# extras` one-liner, including the statically frequent ones
  // (`os.git.status`) and MCP tools the static catalog does not hold.
  toolRegistry.register(buildToolViewTool({ deferred: toolSearchCatalog }));
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
      grammar = applyMcpToolNameRule(baseGrammar, rule, mcpMetaToolsRegistered);
      onMcpToolNameRule?.(rule, mcpMetaToolsRegistered);
      rebuildToolDescriptors();
      logger.info("mcp: catalog refreshed", {
        servers: serverCount,
        tools: metas.length,
      });
    };
    return refreshMcp;
  };
  /**
   * Stop a plugin's running MCP servers the moment its state no longer
   * allows them (code stopped, plugin or server off, plugin removed;
   * ATO-1407), from this process or another (the CLI the desktop runs).
   * Returns the unwatch; a no-op when no plugin server was started.
   */
  const watchPluginMcp = (refreshMcp: () => Promise<void>): (() => void) => {
    if (pluginMcp.servers.length === 0) return () => {};
    return createPluginMcpLiveStop({
      stateDir: config.paths.stateDir,
      manager: mcpManager,
      started: pluginMcp.servers,
      owners: pluginMcp.owners,
      takenNames: ownServerNames,
      refresh: refreshMcp,
      logger,
    }).watch();
  };
  return { mcpManager, getGrammar: () => grammar, effectiveToolDescriptors, createRefreshMcp, watchPluginMcp };
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
  providerRegistry: Pick<ProviderRegistry, "getProvider" | "modelVariant">;
  llama: Pick<
    LlamaServerClient,
    "measuredTokensPerSecond" | "fetchSlots" | "probeHealth"
  >;
  approvals: ApprovalGate;
  dangerous: DangerousToolOptions;
  slotManager: FusionDelegateDeps["slotManager"];
  workingDir: string;
  logger: StructuredLogger;
  turnBudget?: FusionDelegateDeps["turnBudget"];
  /** The composer's `$` readout: escalation and judge calls land here (ATO-1388). */
  sessionUsage?: Pick<SessionUsageLedger, "record">;
  /** `llm.costTracking`'s session and day totals: escalation and judge calls count here too (ATO-1497). */
  costAccumulator?: Pick<CostAccumulator, "recordTurn">;
  liveWorkers?: FusionDelegateDeps["liveWorkers"];
  steerWorker?: FusionDelegateDeps["steerWorker"];
  orchestratorTurnSpendUsd?: FusionDelegateDeps["orchestratorTurnSpendUsd"];
  runCheckpoints?: FusionDelegateDeps["runCheckpoints"];
  outcomeLog?: FusionDelegateDeps["outcomeLog"];
}): void {
  const { config, toolRegistry, runTurn, createEphemeralSession, resolveOriginalRequest, declaredInputs,
    prepareLocalLink, emitAgentLoopEventFor, resolveCurrentRunMode, providerRegistry,
    llama, approvals, dangerous, slotManager, workingDir, logger, turnBudget,
    orchestratorTurnSpendUsd, liveWorkers, steerWorker, runCheckpoints, sessionUsage, outcomeLog, costAccumulator } = input;
  // Every worker session minted here, by id, so subagent.run reads the
  // caller's own depth stamp (ATO-1670). Worker sessions are never stored.
  const mintedSessions = new MintedSessionMetadata();
  const createTrackedEphemeralSession: FusionDelegateDeps["createEphemeralSession"] = (meta, dir, inherit) =>
    mintedSessions.remember(createEphemeralSession(meta, dir, inherit));


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
      createEphemeralSession: createTrackedEphemeralSession,
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
      // A local worker sent after one was cut off, on a server that still
      // answers, goes out on fresh connections (ATO-1357).
      renewLocalTransport: () => renewTransportPool(),
      probeSlotOccupancy: async () => {
        try {
          return readSlotOccupancy(await llama.fetchSlots());
        } catch {
          return null;
        }
      },
      // Asked before a local worker is sent after one was cut off
      // (ATO-917): a server that stopped answering fails the task now.
      probeLocalHealth: () => llama.probeHealth(),
      // Per local server (ATO-1318): this client only ever asks the main
      // local server (`localModels.url`), so it is the probe for a leg on
      // that server alone. A second local server has no probe here and
      // its leg is not checked, rather than checked against the wrong one.
      probeLocalHealthFor: (providerId) => {
        const entry = resolveLlmConfig(getConfig()).providers.find((p) => p.id === providerId);
        if (entry === undefined || entry.kind !== "llama-server") return undefined;
        const main = getConfig().localModels.url;
        const same = (a: string, b: string): boolean =>
          a.trim().replace(/\/+$/, "") === b.trim().replace(/\/+$/, "");
        return entry.url === undefined || same(entry.url, main)
          ? () => llama.probeHealth()
          : undefined;
      },
      // ATO-1562: a llama.cpp server that is not this agent's own serves
      // whatever it loaded; its worker rows are labelled with that name.
      // Asked per fan-out, bounded by the client's probe timeout. The
      // main local server (`localModels.url`) is ours and keeps its label.
      servedModelOf: async (providerId) => {
        const entry = resolveLlmConfig(getConfig()).providers.find((p) => p.id === providerId);
        if (entry === undefined || !isForeignLlamaServer(entry, getConfig().localModels.url)) return null;
        const client = new LlamaServerClient({
          baseUrl: entry.url!,
          ...(entry.apiKey === undefined ? {} : { apiKey: entry.apiKey }),
        });
        return servedModelName(await client.fetchProps());
      },
      // The turn's $ / time caps (ATO-947), reset at each fusion turn's
      // start by the loop; read only when a cap is configured.
      ...(turnBudget === undefined ? {} : { turnBudget }),
      ...(orchestratorTurnSpendUsd === undefined
        ? {}
        : { orchestratorTurnSpendUsd }),
      // Escalation (ATO-942): one completion pinned to the configured
      // escalation provider — never the fallback chain, so it cannot
      // land on a model the operator did not pick for it.
      escalationComplete: async ({ providerId, model, prompt, maxOutputTokens, signal, sessionId }) => {
        // ATO-1560: the escalation's / judge's own model on that provider
        // runs on the provider's copy built for it, like a per-turn model.
        const provider =
          model === undefined
            ? providerRegistry.getProvider(providerId)
            : await providerRegistry.modelVariant(providerId, model);
        if (provider === undefined) {
          throw new Error(
            model === undefined
              ? `escalation provider ${providerId} is not configured`
              : `escalation provider ${providerId} cannot run model ${model}`,
          );
        }
        const result = await provider.complete({
          prompt,
          maxOutputTokens,
          signal,
        });
        // These calls go straight to the provider, past the seam that
        // feeds the session's readout, so they are counted here on the
        // session that delegated (ATO-1388). Priced like any other call:
        // no known price stays "unpriced", a local server stays local.
        if (sessionUsage !== undefined && sessionId !== undefined) {
          try {
            const resolved = resolveLlmConfig(getConfig());
            const entry = resolved.providers.find((p) => p.id === providerId);
            const model = resolveModelPricingFor(resolved, result.modelId, providerId);
            sessionUsage.record(sessionId, {
              providerId,
              modelId: result.modelId,
              ...(result.usage === undefined ? {} : { usage: result.usage }),
              ...(model === undefined ? {} : { model }),
              local:
                entry !== undefined &&
                (entry.kind === "llama-server" || isLocalServerUrl(entry.baseUrl ?? entry.url)),
              plan: entry?.kind === "subscription-cli" || entry?.kind === "subscription-oauth",
            });
          } catch {
            // The readout never takes an escalation down.
          }
        }
        // The same call in `llm.costTracking`'s session and day totals
        // (ATO-1497), gated like the fallback seam's: any call with usage,
        // no session needed.
        if (costAccumulator !== undefined && result.usage !== undefined) {
          try {
            const model = resolveModelPricingFor(resolveLlmConfig(getConfig()), result.modelId, providerId);
            costAccumulator.recordTurn({
              modelId: result.modelId,
              usage: result.usage,
              ...(model === undefined ? {} : { model }),
            });
          } catch {
            // Cost tracking never takes an escalation down.
          }
        }
        return {
          content: result.content,
          ...(result.usage === undefined ? {} : { usage: result.usage }),
        };
      },
      ...(liveWorkers === undefined ? {} : { liveWorkers }),
      ...(steerWorker === undefined ? {} : { steerWorker }),
      // Run checkpoints (ATO-617): a fan-out cut off by a restart can be
      // resumed from its unfinished wave.
      ...(runCheckpoints === undefined ? {} : { runCheckpoints }),
      // The outcome log (ATO-949): what past runs showed, for the planner.
      ...(outcomeLog === undefined ? {} : { outcomeLog }),
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
      // Fan-outs never write in the agent's own state directory (ATO-1267).
      agentStateDir: config.paths.stateDir,
      // Subagent profiles a task may name (ATO-566), read per fan-out so a
      // new file or a trust answer applies without a restart. Project
      // files load only once the folder trusted them.
      resolveAgentProfiles: (dir) =>
        loadAgentProfiles({
          workingDir: dir,
          stateDir: config.paths.stateDir,
          configFile: config.paths.userConfigFile,
          startupTrust: config.skills.projectTrust,
          settingsProfiles: () =>
            readSettingsAgentProfiles(config.paths.userConfigFile, () => getConfig().llm?.runMode?.agentProfiles),
          pluginProfiles: () => pluginAgentProfiles(config.paths.stateDir),
        }),
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
  // Subagents outside Fusion (ATO-1670), on the shared worker runner.
  // Registered unconditionally like fusion.delegate; the descriptor gate
  // above hides it in Fusion, and the tool refuses there too.
  toolRegistry.register(
    buildSubagentRunTool({
      runTurn: (session, userMessage, turnOptions) =>
        runTurn(session, userMessage, turnOptions),
      createEphemeralSession: createTrackedEphemeralSession,
      readSessionMetadata: (sessionId) => mintedSessions.read(sessionId),
      resolveOriginalRequest,
      approvals,
      emitEvent: emitAgentLoopEventFor,
      workingDir,
      resolveRunMode: resolveCurrentRunMode,
      // The calling session's model: the step's pinned provider, else the
      // active one with its configured chat model.
      resolveSessionLeg: (pinnedProviderId) => {
        const resolved = resolveLlmConfig(getConfig());
        const providerId = pinnedProviderId ?? resolved.activeTextProvider;
        const entry = resolved.providers.find((p) => p.id === providerId);
        return { providerId, model: entry?.defaultChatModel ?? entry?.model ?? providerId };
      },
      workerSupportsSlotAffinity: (providerId) =>
        providerRegistry.getProvider(providerId)?.capabilities
          .supportsSlotAffinity ?? false,
      // Declared `files` are asked about once per call, as a fan-out is.
      approvalRequired: dangerous.approvalRequired,
      agentStateDir: config.paths.stateDir,
      // Prices subagent completions under the turn's spend ceiling, the
      // same resolver fusion.delegate's workers are priced with.
      resolveWorkerPricing: (providerId, modelId) =>
        resolveModelPricingFor(resolveLlmConfig(getConfig()), modelId, providerId)?.pricing,
      // "Local" as the session readout above decides it: a llama-server
      // entry or one on a local server URL. Anything else configured is cloud.
      isCloudProvider: (providerId) => {
        const entry = resolveLlmConfig(getConfig()).providers.find((p) => p.id === providerId);
        return (
          entry !== undefined &&
          entry.kind !== "llama-server" &&
          !isLocalServerUrl(entry.baseUrl ?? entry.url)
        );
      },
      // The same profile loader fusion.delegate is given.
      resolveAgentProfiles: (dir) =>
        loadAgentProfiles({
          workingDir: dir,
          stateDir: config.paths.stateDir,
          configFile: config.paths.userConfigFile,
          startupTrust: config.skills.projectTrust,
          pluginProfiles: () => pluginAgentProfiles(config.paths.stateDir),
        }),
      outputCharCap: config.agent.batchToolResultCharCap,
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
  // The agent's own secret files (`.env`, `config.json`, local server
  // keys) ask as `state_secret` on any read or shell command naming
  // them, whatever the scope and below full trust (ATO-877).
  confineReads(toolRegistry, {
    grantedDirs: (sessionId) => approvals.fanoutScopes.scopeFor(sessionId),
    readScope: () => getConfig().agent.readScope,
    approvals: dangerous,
    stateSecrets: {
      stateDir: config.paths.stateDir,
      files: getStateSecretPaths(config.paths),
    },
  });
}

function safePluginMcpServers(
  stateDir: string,
  taken: ReadonlySet<string>,
  logger: StructuredLogger,
): { servers: McpServerConfig[]; owners: Record<string, string> } {
  try {
    const { servers, skipped, owners } = loadPluginMcpServers(stateDir, taken);
    for (const s of skipped) logger.warn("plugin MCP server skipped", { plugin: s.plugin, server: s.server, reason: s.reason });
    return { servers, owners };
  } catch (err) {
    logger.warn("plugin MCP servers unavailable", { error: err instanceof Error ? err.message : String(err) });
    return { servers: [], owners: {} };
  }
}
