import type { AtomicAgentConfig } from "../../config/index.js";
import type { EmbeddingClient } from "./embedding-client.js";

export type EmbeddingProviderConfigEntry = {
  id: string;
  kind: string;
  baseUrl?: string;
  apiKey?: string;
  defaultEmbeddingModel?: string;
  requestTimeoutMs?: number;
};

export type ResolvedEmbeddingLlmConfig = {
  activeEmbeddingProvider: string;
  providers: EmbeddingProviderConfigEntry[];
};

const embeddingFactories = new Map<
  string,
  (ctx: {
    config: AtomicAgentConfig;
    entry: EmbeddingProviderConfigEntry;
  }) => EmbeddingClient | Promise<EmbeddingClient>
>();

export function registerEmbeddingProviderKind(
  kind: string,
  factory: (ctx: {
    config: AtomicAgentConfig;
    entry: EmbeddingProviderConfigEntry;
  }) => EmbeddingClient | Promise<EmbeddingClient>,
): void {
  embeddingFactories.set(kind, factory);
}

export function resolveEmbeddingLlmConfig(
  config: AtomicAgentConfig,
): ResolvedEmbeddingLlmConfig {
  const llm = config.llm;
  if (llm) {
    const providers = llm.providers
      .filter((p) => p.defaultEmbeddingModel || p.kind === "llama-server")
      .map((p) => ({
        id: p.id,
        kind: p.kind,
        baseUrl: p.baseUrl ?? p.url,
        apiKey: p.apiKey,
        defaultEmbeddingModel: p.defaultEmbeddingModel,
        requestTimeoutMs: p.requestTimeoutMs,
      }));
    return {
      activeEmbeddingProvider: llm.activeEmbeddingProvider,
      providers,
    };
  }
  return {
    activeEmbeddingProvider: "local-llama-embed",
    providers: [
      {
        id: "local-llama-embed",
        kind: "llama-server",
        baseUrl: config.localModels.embeddings.enabled
          ? config.localModels.embeddings.url
          : config.localModels.url,
      },
    ],
  };
}

export class EmbeddingProviderRegistry {
  private readonly providers: Map<string, EmbeddingClient>;
  private activeId: string;

  private constructor(activeId: string, providers: Map<string, EmbeddingClient>) {
    this.activeId = activeId;
    this.providers = providers;
  }

  static async fromConfig(
    config: AtomicAgentConfig,
  ): Promise<EmbeddingProviderRegistry> {
    const resolved = resolveEmbeddingLlmConfig(config);
    const built = new Map<string, EmbeddingClient>();
    for (const entry of resolved.providers) {
      const factory = embeddingFactories.get(entry.kind);
      if (!factory) continue;
      built.set(entry.id, await factory({ config, entry }));
    }
    if (!built.has(resolved.activeEmbeddingProvider) && built.size > 0) {
      const first = [...built.keys()][0]!;
      return new EmbeddingProviderRegistry(first, built);
    }
    return new EmbeddingProviderRegistry(resolved.activeEmbeddingProvider, built);
  }

  get active(): EmbeddingClient | undefined {
    return this.providers.get(this.activeId);
  }

  async swapActive(id: string): Promise<EmbeddingClient> {
    const next = this.providers.get(id);
    if (!next) {
      throw new Error(`embedding provider "${id}" is not configured`);
    }
    this.activeId = id;
    return next;
  }

  /** Alias for hot-swap callers (TUI orchestrator). */
  async setActive(id: string): Promise<EmbeddingClient> {
    return this.swapActive(id);
  }
}
