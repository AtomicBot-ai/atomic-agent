import type { AtomicAgentConfig } from "../../config/index.js";
import { getConfig, resetConfigCache } from "../../config/index.js";
import type { CreateAgentRuntimeOptions } from "../runtime-contract.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { RuntimeLocalProfile, RuntimeConnectedLocalProfile } from "./runtime-local-profile.js";
import type { LlmStreamParams } from "../../agent/step/step-contract.js";
import type { CompletionResult } from "../../llm/llama-server-client.js";
import { ProviderRegistry, resolveLlmConfig, type LlmProvider } from "../../llm/provider/index.js";
import { resolveActiveToolTransport } from "../../llm/provider/registry/resolve-tool-transport.js";
import { modelWantsStrictTools } from "../../llm/provider/model-strict-tools.js";
import { resolveRunMode, type ResolvedRunMode } from "../../llm/run-mode/index.js";
import { sanitizeModelAlias } from "../../analytics/index.js";
import type { TurnUsageMeter } from "../../analytics/index.js";
import type { CostAccumulator } from "../../llm/provider/cost-accumulator.js";
import type { ResolvedModel } from "../../llm/provider/model-resolver.js";
import { resolveModelPricingFor } from "../resolve-model-pricing.js";
import { LearnedContextWindows } from "../learned-context-windows.js";
import { resolveVisionProvider, visionRouteAvailable } from "../vision-route.js";
import { providerIdIsLlamaServer } from "../../llm/provider/registry/active-text-provider.js";
import { createLocalLinkPreparer } from "../../llm/local-backend-gate.js";
import type { ProviderFallbackChain } from "../../llm/fallback/index.js";
import {
  createFallbackCompleter,
  createFallbackStreamer,
  type FallbackSeamDeps,
} from "../llm-fallback-seam.js";

type RuntimeInferenceOptions = Pick<CreateAgentRuntimeOptions, "overrides">;

export async function connectRuntimeProviders(
  config: AtomicAgentConfig,
  logger: StructuredLogger,
  local: Pick<RuntimeLocalProfile, "llama" | "modelAlias">,
  connected: Pick<RuntimeConnectedLocalProfile, "getLiveProfile" | "getLiveModelId">,
) {
  const { llama, modelAlias } = local;
  const { getLiveProfile, getLiveModelId } = connected;
  const providerRegistry = await ProviderRegistry.fromConfig(config, {
    config,
    llamaClient: llama,
    getProfile: getLiveProfile,
    getModelId: getLiveModelId,
    logger,
  });

  /**
   * Re-read on every inference so TUI `setActive` hot-swap takes effect.
   * `providerId` overrides which provider is used for this call — the
   * fallback chain passes the chosen link's id; transport/adapter/slot
   * affinity are then resolved for THAT provider, not the active one. An
   * unknown id degrades to the active provider (a raced config edit).
   */
  const resolveActiveLlmSlice = (providerId?: string) => {
    const fresh = getConfig();
    const resolved = resolveLlmConfig(fresh);
    const provider =
      (providerId ? providerRegistry.getProvider(providerId) : undefined) ??
      providerRegistry.activeText;
    return {
      provider,
      transport: resolveActiveToolTransport(resolved, provider),
      adapter: provider.toolCallAdapter ?? null,
      slotAffinity: provider.capabilities.supportsSlotAffinity,
      parallelTools: provider.capabilities.supportsParallelTools,
      strictTools: modelWantsStrictTools(resolved, provider.id),
      // The entry's kind, not the provider object's — `LlmProvider` has
      // no kind and a llama-server link is only identifiable from the
      // config entry it was built from.
      isLlamaServer:
        resolved.providers.find((p) => p.id === provider.id)?.kind ===
        "llama-server",
    };
  };

  /**
   * The live run mode. Re-read per call, never captured: the resolver's
   * rule is that `llm.activeTextProvider` is authoritative, so an
   * operator who switches provider by hand drops out of fusion on the
   * next read and `fusion.delegate` must see that immediately.
   */
  const resolveCurrentRunMode = (): ResolvedRunMode => {
    const fresh = getConfig();
    return resolveRunMode(resolveLlmConfig(fresh), {
      managedModelId: fresh.localModels.managed.modelId,
    });
  };

  /**
   * Real model identifier for analytics. Cloud providers carry the model
   * in their config entry (`defaultChatModel` / `model`). Local llama-server
   * has no model name in its synthesized `local-llama` entry, so we prefer
   * the managed GGUF id (`localModels.managed.modelId`); in external mode
   * (no GGUF id) we fall back to the sanitized operator `--alias`
   * (`/props.model_alias`). The detected profile id (e.g. `plain-instruct`)
   * is only a last-resort fallback — it names the prompt profile, not the
   * model, so it must never be the primary source.
   */
  const resolveActiveModelName = (): string => {
    const liveConfig = getConfig();
    const resolved = resolveLlmConfig(liveConfig);
    const entry = resolved.providers.find(
      (p) => p.id === resolved.activeTextProvider,
    );
    return (
      entry?.defaultChatModel ??
      entry?.model ??
      liveConfig.localModels.managed.modelId ??
      sanitizeModelAlias(modelAlias) ??
      getLiveProfile().id
    );
  };

  /**
   * Whether the model on `providerId` can read images, for the route
   * note. `null` when the provider is unknown. Per provider today; a
   * per-model answer slots in here without touching the note.
   */
  const resolveRouteVision = (providerId: string): boolean | null => {
    if (!getConfig().vision.enabled) return false;
    const provider = providerRegistry.getProvider(providerId);
    return provider === undefined ? null : provider.capabilities.vision;
  };

  return {
    providerRegistry,
    resolveActiveLlmSlice,
    resolveCurrentRunMode,
    resolveActiveModelName,
    resolveRouteVision,
  };
}

export type RuntimeProviders = Awaited<ReturnType<typeof connectRuntimeProviders>>;

export function createRuntimeModelContext(
  config: AtomicAgentConfig,
  providers: Pick<RuntimeProviders, "providerRegistry" | "resolveCurrentRunMode" | "resolveActiveModelName">,
) {
  const {
    providerRegistry,
    resolveCurrentRunMode,
    resolveActiveModelName,
  } = providers;
  /**
   * Pricing for a model id on the provider that served it (default: the
   * active one). See `resolveModelPricingFor` for the sources and why
   * the served id, not the active id, is the right key.
   */
  const resolveModelPricing = (
    modelId: string | null,
    providerId?: string,
  ): ResolvedModel | undefined =>
    resolveModelPricingFor(resolveLlmConfig(getConfig()), modelId, providerId);

  /**
   * The active model's context window, for providers the `/props` probe
   * cannot reach.
   *
   * `source === "default"` is deliberately treated as unknown. That
   * branch is `DEFAULT_CHAT`'s nominal 128k — a placeholder, not a fact
   * about the model actually serving the request — and a budget computed
   * against a guessed window silently mis-sizes every prompt. Better to
   * report no window and let the caller fall back to a fixed cap it can
   * defend. The same reasoning keeps the TUI gauge from drawing itself
   * against that number.
   *
   * Resolved per step rather than captured once, so switching model
   * mid-session is picked up by the next prompt.
   */
  /**
   * Context windows the model server revealed — by cutting a reply short
   * (`completion_truncated` with cause `context_window`, where prompt +
   * reply tokens is the window) or by refusing a request as too large
   * (`prompt_repacked`). Keyed by provider and model, kept for the life
   * of the process: the same server keeps the same window, and a
   * restart may well change it (llama.cpp `-c`, Lemonade's auto-sizing).
   * A demonstrated window overrides the catalogue's nominal 128k default
   * and clamps a real catalogue entry, since a server can run a model
   * with less context than the model supports. A window only moves
   * towards what the server demonstrated — see `LearnedContextWindows`.
   */
  const observedContextWindows = new LearnedContextWindows();
  const activeModelKey = (): string =>
    `${resolveLlmConfig(getConfig()).activeTextProvider}/${resolveActiveModelName()}`;
  const observeContextWindow = (contextWindow: number): void => {
    observedContextWindows.observe(activeModelKey(), contextWindow);
  };
  const raiseContextWindowTo = (tokens: number): void => {
    observedContextWindows.raise(activeModelKey(), tokens);
  };
  const resolveCatalogContextWindow = (): number | null => {
    const observed = observedContextWindows.get(activeModelKey());
    const model = resolveModelPricing(resolveActiveModelName());
    const catalogued =
      !model || model.source === "default" || model.contextWindow <= 0
        ? null
        : model.contextWindow;
    if (observed === undefined) return catalogued;
    return catalogued === null ? observed : Math.min(observed, catalogued);
  };

  // Vision follows the live route (`vision-route.ts`): each call asks
  // the registry for the provider serving that step — the pinned fusion
  // worker leg, else the active text provider — so a `/llm provider`,
  // `/model` or route-picker switch takes effect on the next call. The
  // boot provider used to be captured here, and kept receiving images
  // after the operator had moved off it.
  const resolveCurrentVisionProvider = (
    providerId: string | undefined,
  ): LlmProvider | undefined =>
    resolveVisionProvider(providerRegistry, providerId);
  const visionOnLiveRoute = (): boolean =>
    config.vision.enabled &&
    visionRouteAvailable({
      registry: providerRegistry,
      isLlamaServer: (providerId) =>
        providerIdIsLlamaServer(resolveLlmConfig(getConfig()), providerId),
      fusionWorkerProviderId: () => {
        const mode = resolveCurrentRunMode();
        return mode.effective === "fusion" ? mode.workerProviderId : null;
      },
    });

  return {
    resolveModelPricing,
    observeContextWindow,
    raiseContextWindowTo,
    resolveCatalogContextWindow,
    resolveCurrentVisionProvider,
    visionOnLiveRoute,
  };
}

export type RuntimeModelContext = ReturnType<typeof createRuntimeModelContext>;

export function connectRuntimeFallback(
  options: RuntimeInferenceOptions,
  deps: {
    fallbackChain: ProviderFallbackChain;
    resolveActiveLlmSlice: RuntimeProviders["resolveActiveLlmSlice"];
    localBackend: RuntimeConnectedLocalProfile["localBackend"];
    profileManager: RuntimeConnectedLocalProfile["profileManager"];
    costAccumulator: CostAccumulator | undefined;
    turnUsageMeter: TurnUsageMeter;
    resolveModelPricing: RuntimeModelContext["resolveModelPricing"];
  },
) {
  const {
    fallbackChain,
    resolveActiveLlmSlice,
    localBackend,
    profileManager,
    costAccumulator,
    turnUsageMeter,
    resolveModelPricing,
  } = deps;
  // Fold a unary completion's usage into cost + meter. Lifted out of the
  // seam so the fallback loop + `servedTransport` stamp live in the
  // testable `llm-fallback-seam` module (which knows nothing about cost
  // tracking). The per-provider retry budget (PR #90) still runs one
  // level below, inside `provider.complete`, so the breaker only ever
  // sees an error after those retries are spent.
  const recordUnaryUsage = (
    params: LlmStreamParams,
    result: CompletionResult,
    servedProviderId: string,
  ): void => {
    if (!result.usage) return;
    const model = resolveModelPricing(result.modelId, servedProviderId);
    if (costAccumulator) {
      costAccumulator.recordTurn({
        modelId: result.modelId,
        usage: result.usage,
        ...(model ? { model } : {}),
      });
    }
    if (params.sessionId) {
      turnUsageMeter.record({
        sessionId: params.sessionId,
        usage: result.usage,
        ...(model ? { model } : {}),
      });
    }
  };

  const recordStreamUsage = (
    sessionId: string | undefined,
    result: CompletionResult,
    servedProviderId: string,
  ): void => {
    if (!result.usage || !sessionId) return;
    const model = resolveModelPricing(result.modelId, servedProviderId);
    turnUsageMeter.record({
      sessionId,
      usage: result.usage,
      ...(model ? { model } : {}),
    });
  };

  /**
   * Warm a `llama-server` link before it is asked to infer: replay the
   * probes a cloud boot deferred, refresh a stale profile, and let the
   * loop know a local link is serving. A no-op for every other kind.
   *
   * Two callers, one seam. The fallback chain uses it when a cloud→local
   * fallover is about to happen, and `fusion.delegate` uses it before it
   * fans out — same problem, since a fusion boot is cloud-active and
   * leaves the local backend on deferred state (plain profile, one-slot
   * pool, no `/props`) until something reaches for it.
   */
  const prepareLocalLink = createLocalLinkPreparer({
    gate: localBackend,
    isLocalLink: (providerId) =>
      providerIdIsLlamaServer(resolveLlmConfig(getConfig()), providerId),
    refreshIfStale: async () => {
      await profileManager?.refreshIfStale();
    },
  });

  const fallbackSeamDeps: FallbackSeamDeps = {
    fallbackChain,
    resolveSlice: (providerId) => {
      const { provider, transport } = resolveActiveLlmSlice(providerId);
      return { provider, transport };
    },
    // Issue #112. The one place that knows a cloud→local fallover is
    // about to happen: the chain has already picked the link and the
    // completion has not been sent, so warm it here rather than infer
    // against it. No-op on every other attempt — one boolean after the
    // first call. See `prepareLocalLink` above.
    prepareLink: prepareLocalLink,
    recordUnaryUsage,
    recordStreamUsage,
  };

  const llmComplete =
    options.overrides?.llamaComplete ??
    createFallbackCompleter(fallbackSeamDeps);

  const llmCompleteStream = options.overrides?.disableStreaming
    ? undefined
    : (options.overrides?.llamaCompleteStream ??
      (options.overrides?.llamaComplete
        ? undefined
        : createFallbackStreamer(fallbackSeamDeps)));


  return {
    prepareLocalLink,
    llmComplete,
    llmCompleteStream,
  };
}

export function createRuntimeProviderReloads(
  logger: StructuredLogger,
  local: Pick<RuntimeLocalProfile, "llama">,
  connected: Pick<RuntimeConnectedLocalProfile, "getLiveProfile" | "getLiveModelId">,
  providerRegistry: ProviderRegistry,
) {
  const { llama } = local;
  const { getLiveProfile, getLiveModelId } = connected;
  const llmProviderCtx = {
    config: getConfig(),
    llamaClient: llama,
    getProfile: getLiveProfile,
    getModelId: getLiveModelId,
    logger,
  };

  const reloadLlmProviders = async (): Promise<void> => {
    resetConfigCache();
    const fresh = getConfig();
    llmProviderCtx.config = fresh;
    const added = await providerRegistry.mergeProvidersFromConfig(fresh, {
      config: fresh,
      llamaClient: llama,
      getProfile: getLiveProfile,
      getModelId: getLiveModelId,
      logger,
    });
    if (added.length > 0) {
      logger.info("llm: providers registered", { ids: added.join(",") });
    }
  };

  const reloadLlmProvider = async (id: string): Promise<void> => {
    resetConfigCache();
    const fresh = getConfig();
    llmProviderCtx.config = fresh;
    await providerRegistry.replaceProviderFromConfig(id, fresh, {
      config: fresh,
      llamaClient: llama,
      getProfile: getLiveProfile,
      getModelId: getLiveModelId,
      logger,
    });
    logger.info("llm: provider refreshed", { id });
  };


  return {
    reloadLlmProviders,
    reloadLlmProvider,
  };
}
