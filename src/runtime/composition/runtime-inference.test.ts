import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as configuration from "../../config/index.js";
import type { AtomicAgentConfig } from "../../config/index.js";
import { resolveLlmConfig } from "../../llm/provider/index.js";
import { LlamaServerClient } from "../../llm/llama-server-client.js";
import type { CompletionResult } from "../../llm/llama-server-client.js";
import { PLAIN_INSTRUCT_PROFILE } from "../../llm/model-profile.js";
import { ModelProfileManager } from "../../llm/model-profile-manager.js";
import { DeferredLocalBackendProbes } from "../../llm/local-backend-gate.js";
import { DEFAULT_FALLBACK_TIMING, ProviderFallbackChain } from "../../llm/fallback/index.js";
import { CostAccumulator } from "../../llm/provider/cost-accumulator.js";
import { TurnUsageMeter } from "../../analytics/index.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { connectRuntimeFallback, connectRuntimeProviders, createRuntimeModelContext, createRuntimeProviderReloads, type RuntimeProviders } from "./runtime-inference.js";

function completion(modelId = "priced-model"): CompletionResult {
  return {
    content: "answer", reasoningContent: "", stop: true, truncated: false,
    timing: { promptMs: 1, predictedMs: 2, promptTokens: 10, predictedTokens: 5 },
    cacheHitTokens: 0, slotId: -1, modelId,
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  };
}

const params = { prompt: "request", grammar: "grammar", slotId: -1, sessionId: "turn" };

describe("runtime provider/context/fallback/reload phases", () => {
  let config: AtomicAgentConfig;
  let logger: StructuredLogger;
  const connected = { getLiveProfile: () => PLAIN_INSTRUCT_PROFILE, getLiveModelId: () => "local-id" };
  let local: { llama: LlamaServerClient; modelAlias: string | null };
  let providers: RuntimeProviders;
  let acquiredRegistry: RuntimeProviders["providerRegistry"] | undefined;
  beforeEach(async () => {
    acquiredRegistry = undefined;
    config = configuration.loadConfig();
    config.localModels.managed.modelId = null;
    config.vision.enabled = true;
    config.llm = {
      ...resolveLlmConfig(config),
      activeTextProvider: "cloud",
      providers: [
        { id: "cloud", kind: "openai-compatible", baseUrl: "http://cloud.invalid", defaultChatModel: "cloud-model", supportsVision: false },
        { id: "served", kind: "openai-compatible", baseUrl: "http://served.invalid", defaultChatModel: "priced-model", supportsVision: true,
          userModels: [{ id: "priced-model", kind: "chat", contextWindow: 32000, supportsTools: "strict", pricing: { input: 1, output: 2 } }] },
        { id: "local", kind: "llama-server", url: "http://local.invalid" },
      ],
    };
    logger = new StructuredLogger({ level: "debug", sinks: [] });
    local = { llama: new LlamaServerClient(), modelAlias: " alias-model " };
    vi.spyOn(configuration, "getConfig").mockImplementation(() => config);
    providers = await connectRuntimeProviders(config, logger, local, connected);
    acquiredRegistry = providers.providerRegistry;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const id of acquiredRegistry?.listIds() ?? []) await acquiredRegistry?.getProvider(id)?.close();
  });

  it("slice resolves the live registry provider with live config transport and per-model strictness", async () => {
    expect(providers.resolveActiveLlmSlice().provider.id).toBe("cloud");
    await providers.providerRegistry.swapActive("served");
    expect(providers.resolveActiveLlmSlice().provider.id).toBe("served");
    expect(providers.resolveActiveLlmSlice().strictTools).toBe(true);
    config = { ...config, llm: { ...resolveLlmConfig(config), toolTransport: "grammar" } };
    expect(providers.resolveActiveLlmSlice().transport).toBe("grammar");
    expect(providers.resolveActiveLlmSlice("local").isLlamaServer).toBe(true);
    expect(providers.resolveActiveLlmSlice("missing").provider.id).toBe("served");
  });

  it("model naming rereads provider config and preserves managed/alias/profile fallback order", () => {
    expect(providers.resolveActiveModelName()).toBe("cloud-model");
    config = { ...config, llm: { ...resolveLlmConfig(config), activeTextProvider: "local", providers: [{ id: "local", kind: "llama-server" }] } };
    config.localModels.managed.modelId = "managed-id";
    expect(providers.resolveActiveModelName()).toBe("managed-id");
    config.localModels.managed.modelId = null;
    expect(providers.resolveActiveModelName()).toBe("alias-model");
  });

  it("route vision uses the current enable flag, pinned route and unknown-provider null", () => {
    expect(providers.resolveRouteVision("cloud")).toBe(false);
    expect(providers.resolveRouteVision("served")).toBe(true);
    expect(providers.resolveRouteVision("missing")).toBeNull();
    config = { ...config, vision: { ...config.vision, enabled: false } };
    expect(providers.resolveRouteVision("served")).toBe(false);
    expect(providers.resolveRouteVision("missing")).toBe(false);
  });

  it("model context partitions learned windows by live provider/model and clamps real catalog values", () => {
    const context = createRuntimeModelContext(config, providers);
    expect(context.resolveCatalogContextWindow()).toBeNull();
    context.observeContextWindow(8192);
    expect(context.resolveCatalogContextWindow()).toBe(8192);
    config = { ...config, llm: { ...resolveLlmConfig(config), activeTextProvider: "served" } };
    expect(context.resolveCatalogContextWindow()).toBe(32000);
    context.observeContextWindow(64000);
    expect(context.resolveCatalogContextWindow()).toBe(32000);
    config = { ...config, llm: { ...resolveLlmConfig(config), activeTextProvider: "cloud" } };
    expect(context.resolveCatalogContextWindow()).toBe(8192);
    context.raiseContextWindowTo(10000);
    expect(context.resolveCatalogContextWindow()).toBe(10000);
  });

  it("vision wiring follows live providers while retaining the original boot enable snapshot", async () => {
    const context = createRuntimeModelContext(config, providers);
    expect(context.visionOnLiveRoute()).toBe(false);
    await providers.providerRegistry.swapActive("served");
    expect(context.resolveCurrentVisionProvider(undefined)?.id).toBe("served");
    expect(context.resolveCurrentVisionProvider("cloud")?.id).toBe("cloud");
    expect(context.visionOnLiveRoute()).toBe(true);
    config = { ...config, vision: { ...config.vision, enabled: false } };
    expect(providers.resolveRouteVision("served")).toBe(false);
    expect(context.visionOnLiveRoute()).toBe(true);
  });

  function fallback() {
    const fallbackChain = new ProviderFallbackChain({ resolve: () => ({ chain: ["cloud", "served"], timing: DEFAULT_FALLBACK_TIMING }) });
    const localBackend = new DeferredLocalBackendProbes({ isActive: () => false, restore: async () => {} }, false);
    const context = createRuntimeModelContext(config, providers);
    const costAccumulator = new CostAccumulator();
    const turnUsageMeter = new TurnUsageMeter();
    turnUsageMeter.begin("turn");
    const deps = { fallbackChain, resolveActiveLlmSlice: providers.resolveActiveLlmSlice, localBackend, profileManager: undefined, costAccumulator, turnUsageMeter, resolveModelPricing: context.resolveModelPricing };
    return { deps, costAccumulator, turnUsageMeter, fallbackChain };
  }

  it("unary usage is priced against the served pin rather than the active provider", async () => {
    const fixture = fallback();
    const served = providers.providerRegistry.getProvider("served");
    if (!served) throw new Error("served fixture missing");
    vi.spyOn(served, "complete").mockResolvedValue(completion());
    const pick = vi.spyOn(fixture.fallbackChain, "pickProvider");
    const wired = connectRuntimeFallback({}, fixture.deps);
    const result = await wired.llmComplete({ ...params, providerId: "served" });
    expect(result.servedTransport).toBe("native_tools");
    expect(pick).not.toHaveBeenCalled();
    expect(fixture.turnUsageMeter.snapshot("turn")).toMatchObject({ promptTokens: 10, completionTokens: 5, costUsd: 0.00002 });
    expect(fixture.costAccumulator.snapshot().sessionUsd).toBeCloseTo(0.00002);
  });

  it("stream usage reaches the turn meter without double recording the unary cost accumulator", async () => {
    const fixture = fallback();
    const served = providers.providerRegistry.getProvider("served");
    if (!served) throw new Error("served fixture missing");
    vi.spyOn(served, "completeStream").mockImplementation(async function* () {
      yield { delta: "answer", reasoningDelta: "", done: false };
      return completion();
    });
    const wired = connectRuntimeFallback({}, fixture.deps);
    if (!wired.llmCompleteStream) throw new Error("stream fixture missing");
    const stream = wired.llmCompleteStream({ ...params, providerId: "served" });
    let next = await stream.next();
    expect(next.value.servedTransport).toBe("native_tools");
    while (!next.done) next = await stream.next();
    expect(fixture.turnUsageMeter.snapshot("turn")).toMatchObject({ promptTokens: 10, completionTokens: 5, costUsd: 0.00002 });
    expect(fixture.costAccumulator.snapshot().sessionUsd).toBe(0);
  });

  it("prepareLocalLink warms a cold local route once and later refreshes only stale state", async () => {
    const fixture = fallback();
    const events: string[] = [];
    const localBackend = new DeferredLocalBackendProbes({ isActive: () => false, restore: async () => { events.push("restore"); } }, false);
    const profileManager = new ModelProfileManager({ llama: local.llama, initialProfile: PLAIN_INSTRUCT_PROFILE, initialGrammar: "initial", initialModelId: null });
    vi.spyOn(profileManager, "refreshIfStale").mockImplementation(async () => {
      events.push("stale"); return { profileChanged: false, profileId: "plain-instruct", modelId: null };
    });
    const wired = connectRuntimeFallback({}, { ...fixture.deps, localBackend, profileManager });
    await wired.prepareLocalLink("cloud");
    expect(events).toEqual([]);
    await wired.prepareLocalLink("local");
    expect(events).toEqual(["restore"]);
    await wired.prepareLocalLink("local");
    expect(events).toEqual(["restore", "stale"]);
    expect(localBackend.takeLinkServed()).toBe(true);
  });

  it("completion/stream overrides retain exact identity and disableStreaming precedence", () => {
    const fixture = fallback();
    const complete = async () => completion();
    const stream = async function* () { yield { delta: "", reasoningDelta: "", done: true }; return completion(); };
    expect(connectRuntimeFallback({ overrides: { llamaComplete: complete } }, fixture.deps).llmCompleteStream).toBeUndefined();
    const wired = connectRuntimeFallback({ overrides: { llamaComplete: complete, llamaCompleteStream: stream } }, fixture.deps);
    expect(wired.llmComplete).toBe(complete);
    expect(wired.llmCompleteStream).toBe(stream);
    expect(connectRuntimeFallback({ overrides: { disableStreaming: true, llamaCompleteStream: stream } }, fixture.deps).llmCompleteStream).toBeUndefined();
  });

  it("reload creation reads current config at its own phase and each reload resets before reading", async () => {
    const events: string[] = [];
    vi.mocked(configuration.getConfig).mockImplementation(() => { events.push("read"); return config; });
    vi.spyOn(configuration, "resetConfigCache").mockImplementation(() => { events.push("reset"); });
    const merge = vi.spyOn(providers.providerRegistry, "mergeProvidersFromConfig").mockImplementation(async (fresh, ctx) => {
      events.push("merge"); expect(fresh).toBe(config); expect(ctx.config).toBe(config); expect(ctx.llamaClient).toBe(local.llama);
      expect(ctx.getProfile).toBe(connected.getLiveProfile); expect(ctx.getModelId).toBe(connected.getLiveModelId); return ["added"];
    });
    const replace = vi.spyOn(providers.providerRegistry, "replaceProviderFromConfig").mockImplementation(async (id, fresh, ctx) => {
      events.push(`replace:${id}`); expect(fresh).toBe(config); expect(ctx.config).toBe(config);
    });
    const reloads = createRuntimeProviderReloads(logger, local, connected, providers.providerRegistry);
    expect(events).toEqual(["read"]);
    config = { ...config, agent: { ...config.agent, maxSteps: 17 } };
    await reloads.reloadLlmProviders();
    await reloads.reloadLlmProvider("served");
    expect(events).toEqual(["read", "reset", "read", "merge", "reset", "read", "replace:served"]);
    expect(merge).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it("reload propagates the original registry rejection after resetting config", async () => {
    const failure = new Error("registry factory rejected");
    vi.spyOn(configuration, "resetConfigCache").mockImplementation(() => {});
    vi.spyOn(providers.providerRegistry, "replaceProviderFromConfig").mockRejectedValue(failure);
    const reloads = createRuntimeProviderReloads(logger, local, connected, providers.providerRegistry);
    await expect(reloads.reloadLlmProvider("served")).rejects.toBe(failure);
  });
});
