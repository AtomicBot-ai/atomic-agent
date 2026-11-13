import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configuration from "../../config/index.js";
import type { AtomicAgentConfig } from "../../config/index.js";
import type { LlmStreamParams } from "../../agent/step/step-contract.js";
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
import { OpenAiHttpError } from "../../llm/provider/openai/openai-http.js";
import { DailySpendStore } from "../../session/daily-spend.js";
import { DailySpendLimitError } from "../../llm/reliability/spend-limit-error.js";
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

  it("files a window a pinned link revealed under that link, never the active model (ATO-1028)", () => {
    // Fusion: the cloud orchestrator is active, a local worker overflowed.
    const context = createRuntimeModelContext(config, providers);
    context.observeContextWindow(8192, "local");
    expect(context.resolveCatalogContextWindow()).toBeNull();
    expect(context.resolveCatalogContextWindow("cloud")).toBeNull();
    expect(context.resolveCatalogContextWindow("local")).toBe(8192);
  });

  it("an Ollama route learns its real window once per model and the budget uses it (ATO-1276)", async () => {
    config = { ...config, llm: { ...resolveLlmConfig(config), activeTextProvider: "ollama", providers: [
      ...resolveLlmConfig(config).providers,
      { id: "ollama", kind: "openai-compatible", baseUrl: "http://localhost:11434", defaultChatModel: "qwen3:8b" },
    ] } };
    const readOllamaWindow = vi.fn(async () => 4096);
    const context = createRuntimeModelContext(config, providers, { readOllamaWindow });
    await context.primeLocalContextWindow();
    expect(readOllamaWindow).toHaveBeenCalledWith("http://localhost:11434", "qwen3:8b");
    expect(context.resolveCatalogContextWindow()).toBe(4096);
    expect(context.resolveCatalogContextWindow("ollama")).toBe(4096);
    await context.primeLocalContextWindow("ollama");
    expect(readOllamaWindow).toHaveBeenCalledTimes(1);
    // A smaller window the server later refused at still wins.
    context.observeContextWindow(3000, "ollama");
    expect(context.resolveCatalogContextWindow()).toBe(3000);
  });

  it("an Ollama probe that fails leaves the window unknown and never touches other providers", async () => {
    config = { ...config, llm: { ...resolveLlmConfig(config), activeTextProvider: "ollama", providers: [
      ...resolveLlmConfig(config).providers,
      { id: "ollama", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", defaultChatModel: "llama3.1" },
    ] } };
    const readOllamaWindow = vi.fn(async (): Promise<number | null> => { throw new Error("down"); });
    const context = createRuntimeModelContext(config, providers, { readOllamaWindow });
    await expect(context.primeLocalContextWindow()).resolves.toBeUndefined();
    expect(context.resolveCatalogContextWindow()).toBeNull();
    readOllamaWindow.mockClear();
    await context.primeLocalContextWindow("cloud");
    await context.primeLocalContextWindow("local");
    expect(context.resolveCatalogContextWindow("cloud")).toBeNull();
    expect(readOllamaWindow).not.toHaveBeenCalled();
  });

  it("an Ollama model that is not loaded yet is probed again later, not stuck at a guess (ATO-1276)", async () => {
    config = { ...config, llm: { ...resolveLlmConfig(config), activeTextProvider: "ollama", providers: [
      ...resolveLlmConfig(config).providers,
      { id: "ollama", kind: "openai-compatible", baseUrl: "http://localhost:11434", defaultChatModel: "llama3.1" },
    ] } };
    // First probe: model not loaded, no num_ctx -> the reader knows nothing.
    // After the first request the server loaded it with 32768.
    const readOllamaWindow = vi.fn(async (): Promise<number | null> => null);
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const context = createRuntimeModelContext(config, providers, { readOllamaWindow });
      await context.primeLocalContextWindow();
      expect(context.resolveCatalogContextWindow()).toBeNull();
      // Inside the retry window: no new probe.
      await context.primeLocalContextWindow();
      expect(readOllamaWindow).toHaveBeenCalledTimes(1);
      readOllamaWindow.mockResolvedValue(32768);
      now.mockReturnValue(1_000_000 + 16_000);
      await context.primeLocalContextWindow();
      expect(readOllamaWindow).toHaveBeenCalledTimes(2);
      expect(context.resolveCatalogContextWindow()).toBe(32768);
    } finally {
      now.mockRestore();
    }
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

  // ATO-277: message_sent reads the served link from the meter.
  it("a fallover records the link that actually served, and counts it as a fallback", async () => {
    const fixture = fallback();
    fixture.turnUsageMeter.begin("turn", "cloud");
    const cloud = providers.providerRegistry.getProvider("cloud");
    const served = providers.providerRegistry.getProvider("served");
    if (!cloud || !served) throw new Error("provider fixtures missing");
    vi.spyOn(cloud, "complete").mockRejectedValue(
      new OpenAiHttpError("unavailable", 503, "http://cloud.invalid", false, null, "cloud"),
    );
    vi.spyOn(served, "complete").mockResolvedValue(completion());
    const wired = connectRuntimeFallback({}, fixture.deps);
    await wired.llmComplete(params);
    expect(fixture.turnUsageMeter.snapshot("turn")).toMatchObject({
      servedProviderId: "served",
      fallbackCalls: 1,
      promptTokens: 10,
    });
  });

  it("stream usage reaches both the turn meter and the cost accumulator, once (ATO-1289)", async () => {
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
    expect(fixture.costAccumulator.snapshot().sessionUsd).toBeCloseTo(0.00002);
    expect(fixture.costAccumulator.snapshot().lastModelId).toBe("priced-model");
  });

  it("a streamed completion with no session still reaches the cost accumulator, like the unary path (ATO-1289)", async () => {
    const fixture = fallback();
    const served = providers.providerRegistry.getProvider("served");
    if (!served) throw new Error("served fixture missing");
    vi.spyOn(served, "completeStream").mockImplementation(async function* () {
      yield { delta: "answer", reasoningDelta: "", done: false };
      return completion();
    });
    const wired = connectRuntimeFallback({}, fixture.deps);
    if (!wired.llmCompleteStream) throw new Error("stream fixture missing");
    const noSession = { prompt: params.prompt, grammar: params.grammar, slotId: params.slotId };
    // The type asks for a session; a caller outside a turn has none at run time.
    const stream = wired.llmCompleteStream({ ...noSession, providerId: "served" } as LlmStreamParams);
    let next = await stream.next();
    while (!next.done) next = await stream.next();
    expect(fixture.costAccumulator.snapshot().sessionUsd).toBeCloseTo(0.00002);
    expect(fixture.turnUsageMeter.snapshot("turn")).not.toHaveProperty("costUsd");
  });

  it("a streamed completion the service billed is counted at the billed cost (ATO-1289)", async () => {
    const fixture = fallback();
    const served = providers.providerRegistry.getProvider("served");
    if (!served) throw new Error("served fixture missing");
    const billed = completion();
    billed.usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0.5 };
    vi.spyOn(served, "completeStream").mockImplementation(async function* () {
      yield { delta: "answer", reasoningDelta: "", done: false };
      return billed;
    });
    const wired = connectRuntimeFallback({}, fixture.deps);
    if (!wired.llmCompleteStream) throw new Error("stream fixture missing");
    const stream = wired.llmCompleteStream({ ...params, providerId: "served" });
    let next = await stream.next();
    while (!next.done) next = await stream.next();
    expect(fixture.costAccumulator.snapshot().sessionUsd).toBeCloseTo(0.5);
  });

  describe("daily spend and its ceiling (ATO-649)", () => {
    function withDailySpend(limitUsd?: number, onDailyLimit?: "stop" | "local") {
      config.llm = {
        ...(config.llm ?? resolveLlmConfig(config)),
        costTracking: {
          enabled: false,
          showInStatusBar: false,
          dailyResetHourUtc: 0,
          ...(limitUsd !== undefined ? { dailyLimitUsd: limitUsd } : {}),
          ...(onDailyLimit !== undefined ? { onDailyLimit } : {}),
        },
      };
      const dir = mkdtempSync(join(tmpdir(), "daily-spend-"));
      const dailySpend = new DailySpendStore({ path: join(dir, "daily-spend.json") });
      const fixture = fallback();
      return { ...fixture, dailySpend, deps: { ...fixture.deps, dailySpend } };
    }

    it("adds a priced cloud completion to today's total", async () => {
      const fixture = withDailySpend();
      const served = providers.providerRegistry.getProvider("served");
      if (!served) throw new Error("served fixture missing");
      vi.spyOn(served, "complete").mockResolvedValue(completion());
      const wired = connectRuntimeFallback({}, fixture.deps);
      await wired.llmComplete({ ...params, providerId: "served" });
      expect(fixture.dailySpend.today().usd).toBeCloseTo(0.00002);
      expect(fixture.dailySpend.today().pricedCalls).toBe(1);
    });

    it("refuses every paid link once today's spend reached the limit, before sending", async () => {
      const fixture = withDailySpend(1);
      fixture.dailySpend.record({ kind: "priced", usd: 1.2, source: "provider" });
      const cloud = providers.providerRegistry.getProvider("cloud");
      const served = providers.providerRegistry.getProvider("served");
      if (!cloud || !served) throw new Error("provider fixtures missing");
      const cloudCall = vi.spyOn(cloud, "complete").mockResolvedValue(completion());
      const servedCall = vi.spyOn(served, "complete").mockResolvedValue(completion());
      const wired = connectRuntimeFallback({}, fixture.deps);
      await expect(wired.llmComplete(params)).rejects.toBeInstanceOf(DailySpendLimitError);
      expect(cloudCall).not.toHaveBeenCalled();
      expect(servedCall).not.toHaveBeenCalled();
    });

    it("stops at the limit by default: no paid call now or on a later turn, and no move to the local link", async () => {
      const fixture = withDailySpend(1);
      fixture.dailySpend.record({ kind: "priced", usd: 1.2, source: "provider" });
      const fallbackChain = new ProviderFallbackChain({
        resolve: () => ({ chain: ["cloud", "local"], timing: DEFAULT_FALLBACK_TIMING }),
      });
      const cloud = providers.providerRegistry.getProvider("cloud");
      const localLink = providers.providerRegistry.getProvider("local");
      if (!cloud || !localLink) throw new Error("provider fixtures missing");
      const cloudCall = vi.spyOn(cloud, "complete").mockResolvedValue(completion());
      const localCall = vi.spyOn(localLink, "complete").mockResolvedValue(completion("local-id"));
      const wired = connectRuntimeFallback({}, { ...fixture.deps, fallbackChain });
      const first = await wired.llmComplete(params).then(
        () => null,
        (err: unknown) => err,
      );
      expect(first).toBeInstanceOf(DailySpendLimitError);
      expect((first as DailySpendLimitError).onLimit).toBe("stop");
      expect((first as Error).message).toContain("Daily cloud limit reached: $1.20 of $1.00");
      expect((first as Error).message).toContain("Cloud calls are paused until tomorrow");
      // The next turn the same day is refused the same way.
      await expect(wired.llmComplete({ ...params, sessionId: "next-turn" })).rejects.toBeInstanceOf(
        DailySpendLimitError,
      );
      expect(cloudCall).not.toHaveBeenCalled();
      expect(localCall).not.toHaveBeenCalled();
      expect(fallbackChain.activeOverrideFor("turn")).toBeNull();
    });

    it("onDailyLimit \"local\" moves an over-budget turn on to the local link, which answers", async () => {
      const fixture = withDailySpend(1, "local");
      fixture.dailySpend.record({ kind: "priced", usd: 1.2, source: "provider" });
      const notices: string[] = [];
      const fallbackChain = new ProviderFallbackChain({
        resolve: () => ({ chain: ["cloud", "local"], timing: DEFAULT_FALLBACK_TIMING }),
        noticeSink: (notice) => notices.push(`${notice.from}->${notice.to}:${notice.cause ?? ""}`),
      });
      const cloud = providers.providerRegistry.getProvider("cloud");
      const localLink = providers.providerRegistry.getProvider("local");
      if (!cloud || !localLink) throw new Error("provider fixtures missing");
      const cloudCall = vi.spyOn(cloud, "complete").mockResolvedValue(completion());
      vi.spyOn(localLink, "complete").mockResolvedValue({ ...completion("local-id"), content: "local answer" });
      const wired = connectRuntimeFallback({}, { ...fixture.deps, fallbackChain });
      await expect(wired.llmComplete(params)).resolves.toMatchObject({ content: "local answer" });
      expect(cloudCall).not.toHaveBeenCalled();
      expect(notices).toEqual(["cloud->local:spend-limit"]);
    });

    it("lets paid links through below the limit and with no limit set", async () => {
      for (const limit of [5, undefined]) {
        const fixture = withDailySpend(limit);
        fixture.dailySpend.record({ kind: "priced", usd: 1.2, source: "provider" });
        const served = providers.providerRegistry.getProvider("served");
        if (!served) throw new Error("served fixture missing");
        vi.spyOn(served, "complete").mockResolvedValue(completion());
        const wired = connectRuntimeFallback({}, fixture.deps);
        await expect(wired.llmComplete({ ...params, providerId: "served" })).resolves.toMatchObject({
          content: "answer",
        });
      }
    });
  });

  it("a local completion without a usage block still counts its timings toward the turn, unpriced (ATO-276)", async () => {
    const fixture = fallback();
    const served = providers.providerRegistry.getProvider("served");
    if (!served) throw new Error("served fixture missing");
    const local: CompletionResult = { ...completion(), timing: { promptMs: 1, predictedMs: 2, promptTokens: 300, predictedTokens: 20 }, cacheHitTokens: 100 };
    delete local.usage;
    vi.spyOn(served, "complete").mockResolvedValue(local);
    const wired = connectRuntimeFallback({}, fixture.deps);
    await wired.llmComplete({ ...params, providerId: "served" });
    const snapshot = fixture.turnUsageMeter.snapshot("turn");
    // #735 records which provider served the turn; no costUsd: unpriced.
    expect(snapshot).toEqual({ promptTokens: 300, completionTokens: 20, cachedTokens: 100, servedProviderId: "served" });
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
