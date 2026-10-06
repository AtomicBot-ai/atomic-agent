import { getConfig } from "../../config/index.js";
import { resolveEmbeddingApiKey } from "../../local-llm/server/managed-api-key.js";
import { LlamaEmbeddingClient } from "./embedding-client.js";

/**
 * The `LlamaEmbeddingClient` for a local embedding `llama-server`, with
 * the managed daemon's key wired in (#582). Every live embedding client
 * is built here — a bare `new LlamaEmbeddingClient` sends no key and gets
 * 401 on every `/embedding` from a managed daemon, which the writer turns
 * into a silent FTS5-only fallback while `/health` keeps reporting the
 * daemon up.
 *
 * The key is resolved per request from the live config: a mode switch or
 * a daemon launched after boot (which writes the key file) is picked up.
 * `fixedApiKey` (a provider entry's own key) wins when set.
 */
export function createLocalEmbeddingClient(opts: {
  url: string;
  dim: number;
  model: string;
  fixedApiKey?: string;
}): LlamaEmbeddingClient {
  return new LlamaEmbeddingClient({
    url: opts.url,
    dim: opts.dim,
    model: opts.model,
    getApiKey: () => {
      if (opts.fixedApiKey) return opts.fixedApiKey;
      const config = getConfig();
      return resolveEmbeddingApiKey({
        configuredKey: config.localModels.apiKey,
        embeddingsUrl: opts.url,
        managedPorts: [
          config.localModels.managed.port,
          config.localModels.embeddings.port,
        ],
        dataDir: config.paths.localModelsDataDir,
      });
    },
  });
}
