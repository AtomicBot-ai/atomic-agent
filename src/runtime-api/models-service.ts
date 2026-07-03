import type {
  ProviderCapabilities,
  ProviderHealthResult,
} from "../llm/provider/llm-provider.js";

/**
 * Read-only status of the active LLM backend for the sidecar `models.status`
 * command. The runtime never starts a llama-server — this only probes the
 * active text provider's health and reports its resolved config + live
 * capabilities. Health probing is injected so the facade stays transport-free
 * and testable.
 */
export interface ModelsServiceDeps {
  /** Probe the active text provider (`providerRegistry.activeText.health()`). */
  health: () => Promise<ProviderHealthResult>;
  /** `config.localModels.url`. */
  url: string;
  /** `config.localModels.mode`. */
  mode: "external" | "managed";
  /** Active model id (config-derived / `ModelProfileManager.getModelId()`). */
  activeModelId: string | null;
  /** `ProviderCapabilities.contextWindow` of the active text provider. */
  contextWindow: number | null;
  /** Live capabilities of the active text provider. */
  capabilities: ProviderCapabilities;
}

export interface ModelsStatus {
  reachable: boolean;
  url: string;
  mode: "external" | "managed";
  latencyMs: number;
  error: string | null;
  activeModelId: string | null;
  contextWindow: number | null;
  capabilities: ProviderCapabilities;
}

export async function getModelsStatus(
  deps: ModelsServiceDeps,
): Promise<ModelsStatus> {
  const health = await deps.health();
  return {
    reachable: health.reachable,
    url: deps.url,
    mode: deps.mode,
    latencyMs: health.latencyMs,
    error: health.error,
    activeModelId: deps.activeModelId,
    contextWindow: deps.contextWindow,
    capabilities: deps.capabilities,
  };
}
