import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { getConfig, resetConfigCache, getTrustConfigPaths } from "../../config/index.js";
import type { CreateAgentRuntimeOptions } from "../runtime-contract.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { ApprovalGate } from "../../approval/approval-gate.js";
import { ToolRegistry } from "../../tools/tool-registry.js";
import type { BrowserBackend } from "../../tools/browser/browser-backend.js";
import * as browserTools from "../../tools/browser/index.js";
import * as osTools from "../../tools/os/index.js";
import * as fusionTools from "../../tools/fusion/index.js";
import * as readScope from "../../tools/read-scope/index.js";
import { ProfileStore } from "../../memory/profile-store.js";
import { MemoryStore } from "../../memory/memory-store.js";
import { SkillRegistry } from "../../skills/skill-registry.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { LlamaServerClient } from "../../llm/llama-server-client.js";
import { resolveLlmConfig } from "../../llm/provider/index.js";
import { resolveRunMode, type ResolvedRunMode } from "../../llm/run-mode/index.js";
import * as mcp from "../../mcp/index.js";
import type { McpToolMeta, McpSamplingHandler } from "../../mcp/index.js";
import * as composio from "../../composio/index.js";
import { setDynamicResourceClassResolver } from "../../agent/tool-resource-class.js";
import { createRuntimeToolRegistry, registerRuntimeCoreTools, connectRuntimeMcpCatalog, registerRuntimeFusionAndReadScope } from "./runtime-tool-catalog.js";

const logger = new StructuredLogger({ level: "error", sinks: [] });
const externalOperation = (): never => { throw new Error("Test must not perform external work"); };
const backend: BrowserBackend = {
  ensureReady: async () => externalOperation(), shutdown: async () => {}, snapshot: async () => externalOperation(),
  hasRef: async () => externalOperation(), navigate: async () => externalOperation(), click: async () => externalOperation(),
  type: async () => externalOperation(), search: async () => externalOperation(), tabs: async () => externalOperation(), scroll: async () => externalOperation(),
};
const grammar = 'root ::= mcp-server-tool\nmcp-server-tool ::= "placeholder"\n';
const disabledServer = { name: "disabled", enabled: false, transport: { kind: "stdio", command: "must-not-start" } } satisfies mcp.McpServerConfig;

function meta(name: string): McpToolMeta {
  return { rawName: name, qualifiedName: `mcp.disabled.${name}`, server: "disabled", description: "Synthetic test tool", inputSchema: { type: "object" }, resourceClass: "pure_read" };
}

describe("runtime tool assembly phases and live MCP catalog", () => {
  let directory: string;
  const managers: mcp.McpManager[] = [];
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "atomic-runtime-catalog-"));
    vi.stubEnv("ATOMIC_AGENT_STATE_DIR", directory); vi.stubEnv("GITHUB_TOKEN", "");
    resetConfigCache();
    vi.spyOn(composio, "resolveComposioServerConfig").mockResolvedValue(undefined);
  });
  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.shutdown();
    setDynamicResourceClassResolver(null);
    vi.restoreAllMocks(); vi.unstubAllEnvs(); resetConfigCache();
    await rm(directory, { recursive: true, force: true });
  });
  function deps() {
    const config = getConfig();
    const approvals = new ApprovalGate({ emit: () => {}, level: 5 });
    let mode: ResolvedRunMode = resolveRunMode(resolveLlmConfig(config));
    let vision = false;
    const llama = new LlamaServerClient({ baseUrl: "http://unused.invalid" });
    return { input: { config, options: {}, toolRegistry: new ToolRegistry(), logger, dangerous: { approvals, approvalRequired: true }, llama,
      initialGrammar: grammar, visionOnLiveRoute: () => vision, resolveCurrentRunMode: () => mode },
      setFusion: (enabled: boolean) => { mode = { ...mode, effective: enabled ? "fusion" : "local" }; },
      setVision: (enabled: boolean) => { vision = enabled; },
    };
  }
  async function connect(input: Parameters<typeof connectRuntimeMcpCatalog>[0]) {
    const result = await connectRuntimeMcpCatalog(input); managers.push(result.mcpManager); return result;
  }

  it("registers terminal tools first and does not conceal a browser builder rejection", () => {
    const config = getConfig(); config.browser.enabled = true;
    const names: string[] = []; const original = ToolRegistry.prototype.register;
    vi.spyOn(ToolRegistry.prototype, "register").mockImplementation(function(this: ToolRegistry, definition) {
      names.push(definition.name); original.call(this, definition);
    });
    const failure = new Error("browser builder rejected");
    vi.spyOn(browserTools, "buildBrowserTools").mockImplementation(() => { throw failure; });
    expect(() => createRuntimeToolRegistry(config, backend, { approvals: new ApprovalGate({ emit: () => {} }), approvalRequired: true })).toThrow(failure);
    expect(names).toEqual(["finish", "reply"]);
  });

  it("passes security resources unchanged and preserves live request and git policy callbacks", () => {
    const config = getConfig(); config.browser.enabled = false; config.web.search.persistCache = false; config.web.search.provider = "duckduckgo";
    const profileStore = new ProfileStore({ dbFile: join(directory, "profile.sqlite") });
    const notesStore = new MemoryStore({ dbFile: join(directory, "notes.sqlite"), maxEntries: 20 });
    const shellJobs = new osTools.ShellJobRegistry({ jobMaxMs: 1000, maxJobs: 2 });
    try {
      const approvals = new ApprovalGate({ emit: () => {}, level: 5 }); const dangerous = { approvals, approvalRequired: true };
      const registry = createRuntimeToolRegistry(config, backend, dangerous);
      const declaredInputs = new osTools.DeclaredInputsRegistry();
      const requests = new Map<string, string>(); const recent = vi.fn(() => []);
      const registration = vi.spyOn(osTools, "registerOsTools");
      registerRuntimeCoreTools({ config, toolRegistry: registry, dangerous, sessionStore: { listRecentWorkingDirs: recent },
        resolveOriginalRequest: id => requests.get(id), declaredInputs, shellJobs, skillRegistry: new SkillRegistry({ globalDir: join(directory, "skills"), projectDir: null }), profileStore, notesStore });
      const wired = registration.mock.calls[0]?.[1]; if (!wired) throw new Error("OS tools not registered");
      expect(wired.approvals).toBe(approvals); expect(wired.approvalRequired).toBe(true);
      expect(wired.declaredInputs).toBe(declaredInputs); expect(wired.shellJobs).toBe(shellJobs);
      expect(wired.trustConfigPaths).toEqual(getTrustConfigPaths(config.paths)); expect(wired.stateDir).toBe(config.paths.stateDir);
      requests.set("session", "new request"); expect(wired.resolveOriginalRequest?.("session")).toBe("new request");
      wired.listRecentSessionDirs(7); expect(recent).toHaveBeenCalledWith(7);
      config.git.remoteSync = false; expect(wired.shellPolicy?.isGitRemoteSyncEnabled()).toBe(false);
      config.git.remoteSync = true; expect(wired.shellPolicy?.isGitRemoteSyncEnabled()).toBe(true);
      expect(registry.list().slice(0, 2).map(tool => tool.name)).toEqual(["finish", "reply"]);
      expect(registry.has("tool.view")).toBe(true);
    } finally { shellJobs.endAll(); notesStore.close(); profileStore.close(); }
  });

  it("starts configured MCP before reading its catalog and registers meta tools once", async () => {
    const { input } = deps(); input.config.mcp.servers = [disabledServer];
    const phases: string[] = [];
    const start = mcp.McpManager.prototype.start;
    vi.spyOn(mcp.McpManager.prototype, "start").mockImplementation(async function(this: mcp.McpManager) {
      phases.push("start"); await start.call(this); phases.push("started");
    });
    const metas = mcp.McpManager.prototype.listAllToolMeta;
    vi.spyOn(mcp.McpManager.prototype, "listAllToolMeta").mockImplementation(function(this: mcp.McpManager) {
      phases.push("catalog"); return metas.call(this);
    });
    const registration = vi.spyOn(input.toolRegistry, "register");
    const sampling = vi.spyOn(mcp, "createMcpSamplingHandler");
    const owner = await connect(input);
    expect(phases.slice(0, 3)).toEqual(["start", "started", "catalog"]);
    expect(sampling).toHaveBeenCalledWith({ llamaServerClient: input.llama, server: "*" });
    const names = registration.mock.calls.map(([tool]) => tool.name);
    expect(names).toEqual(["mcp.resource.list", "mcp.resource.read", "mcp.prompt.list", "mcp.prompt.get"]);
    const refresh = owner.createRefreshMcp(); await refresh(); await refresh();
    expect(registration).toHaveBeenCalledTimes(4);
  });

  it("updates grammar from the immutable baseline after add/remove while an external snapshot stays unchanged", async () => {
    const { input } = deps(); const owner = await connect(input); const snapshot = owner.getGrammar();
    expect(input.toolRegistry.list()).toHaveLength(0);
    await owner.mcpManager.addServerLive(disabledServer);
    const list = vi.spyOn(owner.mcpManager, "listAllToolMeta").mockReturnValue([meta("first")]);
    const refresh = owner.createRefreshMcp(); await refresh();
    expect(owner.getGrammar()).toContain("mcp.disabled.first"); expect(snapshot).toBe(grammar);
    expect(owner.effectiveToolDescriptors().some(tool => tool.name === "mcp.disabled.first")).toBe(true);
    list.mockReturnValue([meta("second")]); await refresh();
    expect(owner.getGrammar()).toContain("mcp.disabled.second"); expect(owner.getGrammar()).not.toContain("mcp.disabled.first");
    await owner.mcpManager.removeServerLive("disabled"); list.mockReturnValue([]); await refresh();
    expect(owner.getGrammar()).toBe(grammar);
    expect(owner.effectiveToolDescriptors().some(tool => tool.name.startsWith("mcp."))).toBe(false);
    expect(input.toolRegistry.list()).toHaveLength(4);
  });

  it("keeps descriptor array identity while gates hold and changes it only when live fusion or vision flips", async () => {
    const { input, setFusion, setVision } = deps(); input.config.vision.enabled = true;
    const owner = await connect(input); const initial = owner.effectiveToolDescriptors();
    expect(owner.effectiveToolDescriptors()).toBe(initial);
    expect(initial.some(tool => tool.name === "fusion.delegate" || tool.name === "vision.describe")).toBe(false);
    setFusion(true); const fusion = owner.effectiveToolDescriptors(); expect(fusion).not.toBe(initial);
    expect(fusion.some(tool => tool.name === "fusion.delegate")).toBe(true); expect(owner.effectiveToolDescriptors()).toBe(fusion);
    setVision(true); const vision = owner.effectiveToolDescriptors(); expect(vision).not.toBe(fusion);
    expect(vision.some(tool => tool.name === "vision.describe")).toBe(true); expect(owner.effectiveToolDescriptors()).toBe(vision);
    setFusion(false); setVision(false);
    expect(owner.effectiveToolDescriptors().map(tool => tool.name)).toEqual(initial.map(tool => tool.name));
  });

  it("uses the latest channel handler and retains isolated sampling slot wiring", async () => {
    const { input } = deps(); input.config.mcp.servers = [disabledServer];
    const oldHandler = vi.fn(), nextHandler = vi.fn();
    const options: Pick<CreateAgentRuntimeOptions, "handlers"> = { handlers: { onChannelStatus: oldHandler } };
    let handler: McpSamplingHandler | undefined; const original = mcp.createMcpSamplingHandler;
    vi.spyOn(mcp, "createMcpSamplingHandler").mockImplementation(params => { handler = original(params); return handler; });
    const complete = vi.spyOn(input.llama, "complete").mockResolvedValue({ content: "test", reasoningContent: "", stop: true, truncated: false, cacheHitTokens: 0, slotId: -1, modelId: null, timing: { promptMs: 0, predictedMs: 0, promptTokens: 0, predictedTokens: 0 } });
    const owner = await connect({ ...input, options }); options.handlers = { onChannelStatus: nextHandler };
    vi.spyOn(mcp.McpClient.prototype, "connect").mockRejectedValue(new Error("synthetic connect refusal"));
    await owner.mcpManager.addServerLive({ ...disabledServer, name: "later", enabled: true });
    expect(nextHandler).toHaveBeenLastCalledWith(expect.objectContaining({ channel: "mcp:later", state: "down" }));
    if (!handler) throw new Error("sampling was not wired");
    await handler({ messages: [], maxTokens: 8 }, new AbortController().signal);
    expect(complete.mock.calls[0]?.[0]).toMatchObject({ slotId: -1, cachePrompt: false, maxTokens: 8 });
  });

  it("preserves an unexpected manager-start rejection and does not invent failed-boot rollback", async () => {
    const { input } = deps(); input.config.mcp.servers = [disabledServer];
    const failure = new Error("manager start rejected"); let retained: mcp.McpManager | undefined;
    vi.spyOn(mcp.McpManager.prototype, "start").mockImplementation(async function(this: mcp.McpManager) {
      retained = this; throw failure;
    });
    const shutdown = vi.spyOn(mcp.McpManager.prototype, "shutdown");
    const metaRead = vi.spyOn(mcp.McpManager.prototype, "listAllToolMeta");
    try {
      await expect(connectRuntimeMcpCatalog(input)).rejects.toBe(failure);
      expect(shutdown).not.toHaveBeenCalled(); expect(metaRead).not.toHaveBeenCalled();
      expect(input.toolRegistry.list()).toHaveLength(0);
    } finally { await retained?.shutdown(); }
  });

  it("registers fusion after existing tools, then decorates reads with live security callbacks", () => {
    const config = getConfig(); const toolRegistry = new ToolRegistry();
    toolRegistry.register({ name: "os.fs.read", description: "fixture", readonly: true, run: async () => externalOperation() });
    const approvals = new ApprovalGate({ emit: () => {}, level: 5 });
    const dangerous = { approvals, approvalRequired: true };
    const builder = vi.spyOn(fusionTools, "buildFusionDelegateTool"); const confinement = vi.spyOn(readScope, "confineReads");
    const resolveOriginalRequest = vi.fn(() => "current request");
    registerRuntimeFusionAndReadScope({ config, toolRegistry, approvals, dangerous, declaredInputs: new osTools.DeclaredInputsRegistry(),
      resolveOriginalRequest, runTurn: async () => externalOperation(), createEphemeralSession: () => createEmptySessionState({ id: "worker", workingDir: directory }),
      prepareLocalLink: async () => {}, emitAgentLoopEventFor: () => {}, resolveCurrentRunMode: () => resolveRunMode(resolveLlmConfig(config)),
      providerRegistry: { getProvider: () => undefined }, llama: { measuredTokensPerSecond: () => null }, slotManager: { poolSize: () => 2 }, workingDir: directory, logger });
    const wired = builder.mock.calls[0]?.[0]; const protectedReads = confinement.mock.calls[0]?.[1];
    if (!wired || !protectedReads) throw new Error("late tool phase missing");
    expect(wired.approvals).toBe(approvals); expect(wired.approvalRequired).toBe(true);
    expect(wired.resolveOriginalRequest?.("session")).toBe("current request");
    expect(resolveOriginalRequest).toHaveBeenCalledWith("session");
    expect(wired.workerSupportsSlotAffinity("missing")).toBe(false);
    expect(protectedReads.approvals).toBe(dangerous);
    config.agent.readScope = "unrestricted"; expect(protectedReads.readScope?.()).toBe("unrestricted");
    config.agent.readScope = "working-dir"; expect(protectedReads.readScope?.()).toBe("working-dir");
    expect(toolRegistry.list().map(tool => tool.name)).toEqual(["os.fs.read", "fusion.delegate"]);
    expect(builder.mock.invocationCallOrder[0]).toBeLessThan(confinement.mock.invocationCallOrder[0] ?? 0);
  });
});
