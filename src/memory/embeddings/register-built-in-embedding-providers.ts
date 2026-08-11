import { LlamaEmbeddingClient } from "./embedding-client.js";
import {
  OpenAiEmbeddingProvider,
  OpenRouterEmbeddingProvider,
} from "./openai-embedding-provider.js";
import { registerEmbeddingProviderKind } from "./embedding-provider-registry.js";
import { getEmbeddingModelDef, isKnownEmbeddingModelId } from "../../local-llm/models-catalog.js";
import {
  OPENROUTER_APP_CATEGORIES,
  OPENROUTER_APP_REFERER,
  OPENROUTER_APP_TITLE,
} from "../../llm/provider/openrouter/openrouter-provider.js";

export function registerBuiltInEmbeddingProviderKinds(): void {
  registerEmbeddingProviderKind("llama-server", async ({ config, entry }) => {
    const modelId = config.localModels.embeddings.modelId;
    if (!modelId || !isKnownEmbeddingModelId(modelId)) {
      throw new Error("llama-server embedding provider requires a known modelId");
    }
    const def = getEmbeddingModelDef(modelId);
    const port = config.localModels.embeddings.port;
    return new LlamaEmbeddingClient({
      url: entry.baseUrl ?? `http://127.0.0.1:${port}`,
      dim: def.dim,
      model: def.id,
    });
  });

  registerEmbeddingProviderKind("openai-compatible", ({ entry }) => {
    if (!entry.baseUrl || !entry.defaultEmbeddingModel) {
      throw new Error(
        "openai-compatible embedding provider requires baseUrl and defaultEmbeddingModel",
      );
    }
    return new OpenAiEmbeddingProvider({
      baseUrl: entry.baseUrl,
      apiKey: entry.apiKey ?? "",
      model: entry.defaultEmbeddingModel,
      dim: 1536,
      requestTimeoutMs: entry.requestTimeoutMs,
    });
  });

  registerEmbeddingProviderKind("openrouter", ({ entry }) => {
    return new OpenRouterEmbeddingProvider({
      baseUrl: entry.baseUrl ?? "https://openrouter.ai/api",
      apiKey: entry.apiKey ?? "",
      model: entry.defaultEmbeddingModel ?? "openai/text-embedding-3-small",
      dim: 1536,
      requestTimeoutMs: entry.requestTimeoutMs,
      httpReferer: OPENROUTER_APP_REFERER,
      xTitle: OPENROUTER_APP_TITLE,
      categories: OPENROUTER_APP_CATEGORIES,
    });
  });
}
