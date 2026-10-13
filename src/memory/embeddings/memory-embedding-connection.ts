import type { AtomicAgentConfig } from "../../config/config-schema.js";
import { checkLlamaServer } from "../../llm/llama-server-health.js";
import { getEmbeddingModelDef, isKnownEmbeddingModelId } from "../../local-llm/catalog/models-catalog.js";
import { coreEmbeddingStatus, createCoreEmbeddingClient } from "../../local-llm/core/core-embedding.js";

import type { EmbeddingClient } from "./embedding-client.js";
import { createLocalEmbeddingClient } from "./local-embedding-client.js";

/**
 * Where the configured memory embedding model stands. `reachable`
 * carries a factory rather than a client so the runtime keeps building
 * it inside its own degrade-on-error block.
 */
export type MemoryEmbeddingConnection =
  | { state: "disabled" }
  | { state: "unreachable"; modelId: string; why: string }
  | { state: "reachable"; modelId: string; createClient: () => EmbeddingClient };

/**
 * The one way to reach the memory embedding model: the runtime's boot and
 * `memory reindex` both come through here, so they embed with the same
 * client (same model id, dimension, task prompts and key).
 *
 * Conditions, in order: both feature flags on (`memory.embeddings.enabled`
 * and `localModels.embeddings.enabled`), a known catalog model, and the
 * model answering. The probe is short and never starts anything: a stuck
 * daemon cannot wedge a boot. Never throws.
 */
export async function connectMemoryEmbeddings(
  config: Pick<AtomicAgentConfig, "paths" | "memory" | "localModels">,
): Promise<MemoryEmbeddingConnection> {
  const modelId = config.localModels.embeddings.modelId;
  if (
    !config.memory.embeddings.enabled ||
    !config.localModels.embeddings.enabled ||
    modelId === null ||
    !isKnownEmbeddingModelId(modelId)
  ) {
    return { state: "disabled" };
  }
  const def = getEmbeddingModelDef(modelId);
  const url = config.localModels.embeddings.url;
  // A model that runs in Atomic Core's embedding module has no URL of
  // its own: ask Core (never starting it) instead of probing `/health`.
  const viaCore = def.requiresCoreEmbeddingModule === true;
  const probe: { reachable: boolean; why?: string } = viaCore
    ? await probeCoreEmbedding(config.paths.localModelsDataDir, def).catch(() => ({ reachable: false }))
    : await checkLlamaServer({ url, retries: 0, backoffMs: 0, timeoutMs: 2000 }).catch(() => ({ reachable: false }));
  if (!probe.reachable) {
    return { state: "unreachable", modelId: def.id, why: probe.why ?? `embedding daemon at ${url} is unreachable` };
  }
  return {
    state: "reachable",
    modelId: def.id,
    // Not a bare `LlamaEmbeddingClient`: a managed embedding daemon
    // requires the key (#582), and `/health` above is exempt from it, so
    // a keyless client would pass the probe and then get 401 on every
    // `/embedding`.
    createClient: () =>
      viaCore
        ? createCoreEmbeddingClient({
            dataDir: config.paths.localModelsDataDir,
            dim: def.dim,
            model: def.id,
            ...(def.prompts ? { prompts: def.prompts } : {}),
          })
        : createLocalEmbeddingClient({
            url,
            dim: def.dim,
            model: def.id,
            ...(def.prompts ? { prompts: def.prompts } : {}),
          }),
  };
}

/**
 * Whether Atomic Core's embedding module can serve `def` now: Core runs,
 * the module is on for this model and has not failed. An idle module is
 * fine (the first request starts it). A running module whose vectors do
 * not have the catalog's length is never attached: one memory store must
 * not mix dimensions.
 */
export async function probeCoreEmbedding(
  dataDir: string,
  def: { id: string; name: string; dim: number },
  status: (dataDir: string) => ReturnType<typeof coreEmbeddingStatus> = coreEmbeddingStatus,
): Promise<{ reachable: boolean; why?: string }> {
  const st = await status(dataDir);
  if (!st) return { reachable: false, why: `${def.name} is not running in Atomic Core` };
  if (!st.enabled || st.model_id !== def.id) {
    return { reachable: false, why: `Atomic Core's embedding module is not serving ${def.name}` };
  }
  if (st.state === "failed" || st.state === "unsupported" || st.state === "disabled") {
    return { reachable: false, why: `Atomic Core's embedding module is ${st.state}${st.error ? ` (${st.error.message})` : ""}` };
  }
  if (st.state === "ready" && st.dims !== def.dim) {
    return { reachable: false, why: `${def.name} answers ${st.dims}-dim vectors, expected ${def.dim}` };
  }
  return { reachable: true };
}
