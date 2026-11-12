import type { AtomicAgentConfig } from "../config/index.js";
import { resolveLlmConfig } from "../llm/provider/index.js";
import { createLlamaTokenizeCounter } from "../llm/llama-tokenize-counter.js";
import type { TokenCounter } from "../llm/token-counter.js";
import { apiKeyForUrl } from "../local-llm/server/managed-api-key.js";

export interface CompactionTokenCounterDependencies {
  config(): AtomicAgentConfig;
  /** The compaction route's provider and whether it is a llama-server. */
  route(sessionId: string, providerId?: string): { providerId: string; local?: boolean };
  /** Overrides `fetch` for the counters (tests). */
  fetch?: typeof fetch;
}

/**
 * The exact token counter for a compaction decision (ATO-656): a local
 * llama-server's `/tokenize`, one counter (and cache) per server URL.
 * A cloud route has none, so the heuristic keeps deciding there; a
 * `gpt-tokenizer` counter for OpenAI-like routes is an open decision
 * (dependency and binary size), not wired here.
 */
export function createCompactionTokenCounter(deps: CompactionTokenCounterDependencies): (sessionId: string, providerId?: string) => TokenCounter | undefined {
  const counters = new Map<string, TokenCounter>();
  return (sessionId, providerId) => {
    const route = deps.route(sessionId, providerId);
    if (!route.local) return undefined;
    const config = deps.config();
    const entry = resolveLlmConfig(config).providers.find((p) => p.id === route.providerId);
    const url = entry?.url ?? config.localModels.url;
    if (!url) return undefined;
    let counter = counters.get(url);
    if (!counter) {
      counter = createLlamaTokenizeCounter({
        baseUrl: () => url,
        // The same resolution the provider uses for a pinned base: the managed
        // daemons' key never goes to another host (#582).
        apiKey: () => {
          const live = deps.config();
          const liveEntry = resolveLlmConfig(live).providers.find((p) => p.id === route.providerId);
          return apiKeyForUrl(url, live) ?? liveEntry?.apiKey ?? null;
        },
        modelKey: () => deps.config().localModels.managed.modelId ?? "",
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      });
      counters.set(url, counter);
    }
    return counter;
  };
}
