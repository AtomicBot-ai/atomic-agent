import { getConfig } from "../../config/index.js";
import type { UserLlmProviderEntry } from "../../config/index.js";
import { resolveLlmProviderApiKey } from "../../config/resolve-llm-api-key.js";
import { checkLlamaServer } from "../../llm/llama-server-health.js";
import { resolveLlmConfig } from "../../llm/provider/registry/index.js";
import {
  getModelsStatus,
  listProviders,
  reloadProvider,
  removeProvider,
  setActiveProvider,
  type ModelsServiceDeps,
  type ProviderConfigEntry,
  type ProviderServiceDeps,
} from "../../runtime-api/index.js";
import {
  removeLlmProvider,
  setActiveTextProviderInConfig,
} from "../../tui/persist-llm-provider.js";
import type {
  ModelsStatusPayload,
  ModelsStatusResult,
  ProviderListPayload,
  ProviderListResult,
  ProviderReloadPayload,
  ProviderReloadResult,
  ProviderRemovePayload,
  ProviderRemoveResult,
  ProviderSetActivePayload,
  ProviderSetActiveResult,
} from "../protocol/index.js";
import type { SidecarHandlerContext } from "./handler-context.js";

/**
 * `provider.*` — LLM provider control (list / setActive / reload / remove) and
 * the read-only `models.status`. Mirrors the TUI Providers orchestrator:
 * hot-swap the live registry, persist the choice into config.json, then reload
 * providers from config. The runtime never starts a llama-server — provider
 * ops only re-point the active text backend.
 */
export function registerProviderHandlers(ctx: SidecarHandlerContext): void {
  const { router, runtime } = ctx;

  const providerDeps: ProviderServiceDeps = {
    listIds: () => runtime.providerRegistry.listIds(),
    getCapabilities: (id) =>
      runtime.providerRegistry.getProvider(id)?.capabilities ?? null,
    getActiveTextId: () => runtime.providerRegistry.activeText.id,
    listConfigEntries: () => resolveConfigEntries(),
    setActive: async (id) => {
      await runtime.providerRegistry.setActive(id);
    },
    removeProvider: (id) => runtime.providerRegistry.removeProvider(id),
    reloadProvider: (id) => runtime.reloadLlmProvider(id),
    reloadProviders: () => runtime.reloadLlmProviders(),
    setActiveInConfig: (id) => setActiveTextProviderInConfig(id),
    removeFromConfig: (id) => removeLlmProvider(id),
  };

  router.register<ProviderListPayload, ProviderListResult>(
    "provider.list",
    () => listProviders(providerDeps),
  );

  router.register<ProviderSetActivePayload, ProviderSetActiveResult>(
    "provider.setActive",
    (request) => setActiveProvider(providerDeps, request.payload.id),
  );

  router.register<ProviderReloadPayload, ProviderReloadResult>(
    "provider.reload",
    async (request) => {
      await reloadProvider(providerDeps, request.payload.id);
      return { ok: true };
    },
  );

  router.register<ProviderRemovePayload, ProviderRemoveResult>(
    "provider.remove",
    async (request) => {
      await removeProvider(providerDeps, request.payload.id);
      return { ok: true };
    },
  );

  router.register<ModelsStatusPayload, ModelsStatusResult>(
    "models.status",
    async () => {
      const provider = runtime.providerRegistry.activeText;
      const config = getConfig();
      const deps: ModelsServiceDeps = {
        // Contract: reachability probes the llama-server `/health` endpoint
        // (SIDECAR.md §290), not the provider adapter.
        health: () => checkLlamaServer(),
        url: config.localModels.url,
        mode: config.localModels.mode,
        // Prefer the live model profile (real loaded id + `/props`
        // context window); fall back to config for external mode or when
        // the profile manager is stubbed out.
        activeModelId:
          runtime.profileManager?.getModelId() ??
          resolveActiveModelId(provider.id),
        contextWindow:
          runtime.profileManager?.getProfile().contextWindow ??
          provider.capabilities.contextWindow,
        capabilities: provider.capabilities,
      };
      return { status: await getModelsStatus(deps) };
    },
  );
}

/**
 * Config-derived enrichment for the provider list: kind, chat model, and
 * whether an API key resolves (file or env). Uses the same resolution path as
 * the TUI Providers panel so the two never drift.
 */
function resolveConfigEntries(): ProviderConfigEntry[] {
  const config = getConfig();
  const resolved = resolveLlmConfig(config);
  return resolved.providers.map((p) => {
    const fileEntry = config.llm?.providers.find((e) => e.id === p.id);
    return {
      id: p.id,
      kind: p.kind,
      chatModel: fileEntry?.defaultChatModel ?? fileEntry?.model ?? null,
      hasApiKey: Boolean(
        resolveLlmProviderApiKey(p as unknown as UserLlmProviderEntry)?.length,
      ),
    };
  });
}

/**
 * Best-effort active model id. For a cloud provider it is the entry's
 * `defaultChatModel ?? model`; for the local llama-server it falls back to the
 * managed model id (external mode has no runtime-owned model id).
 */
function resolveActiveModelId(activeId: string): string | null {
  const config = getConfig();
  const fileEntry = config.llm?.providers.find((e) => e.id === activeId);
  const fromEntry = fileEntry?.defaultChatModel ?? fileEntry?.model ?? null;
  if (fromEntry) return fromEntry;
  return config.localModels.managed.modelId;
}
