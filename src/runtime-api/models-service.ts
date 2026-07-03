import type {
  ProviderCapabilities,
  ProviderHealthResult,
} from "../llm/provider/llm-provider.js";

/**
 * Read-only status of the active LLM backend for the sidecar `models.status`
 * command. The runtime never starts a llama-server — this only probes
 * reachability and reports the resolved config + live model profile.
 * Every source is injected so the facade stays transport-free and testable.
 */
export interface ModelsServiceDeps {
  /**
   * Reachability probe against the llama-server `/health` endpoint
   * (`checkLlamaServer()` per SIDECAR.md §290). Shares the
   * `{reachable, status, error, latencyMs}` shape with the provider
   * adapter's `ProviderHealthResult`.
   */
  health: () => Promise<ProviderHealthResult>;
  /** `config.localModels.url`. */
  url: string;
  /** `config.localModels.mode`. */
  mode: "external" | "managed";
  /**
   * Active model id — `ModelProfileManager.getModelId()` (the real loaded
   * model), with a config-derived fallback for external mode or a stubbed
   * profile manager.
   */
  activeModelId: string | null;
  /**
   * Context window — `ModelProfileManager.getProfile().contextWindow` (read
   * from `/props`), falling back to the active provider's capability value.
   */
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
