import type { AtomicAgentConfig } from "../../../../config/index.js";
import {
  buildSearchCacheKey,
  type SearchCache,
} from "../transport/search-cache.js";
import { WebSearchBlockedError } from "../web-search-errors.js";
import type {
  WebSearchHttpDeps,
  WebSearchProviderName,
  WebSearchProviderOptions,
  WebSearchResult,
} from "../web-search-provider.js";
import { resolveProviderByName } from "./provider-registry.js";

export interface WebSearchOrchestratorInput {
  config: Pick<AtomicAgentConfig, "web">;
  deps: WebSearchHttpDeps;
  options: WebSearchProviderOptions;
  cache?: SearchCache;
  /** Process env source for provider key checks; injectable for tests. */
  env?: NodeJS.ProcessEnv;
}

export interface WebSearchOrchestratorResult {
  results: WebSearchResult[];
  provider: WebSearchProviderName;
  fromCache: boolean;
}

/**
 * Run the configured primary provider, then each opt-in fallback provider in
 * order, until one returns usable (non-empty) results. Mirrors openclaw's DDG
 * engine resilience: a cache check short-circuits the HTTP round-trip, blocked
 * pages advance the chain instead of silently returning empty, and a structured
 * error is surfaced only when every provider fails.
 */
export async function runWebSearchWithFallback(
  input: WebSearchOrchestratorInput,
): Promise<WebSearchOrchestratorResult> {
  const search = input.config.web.search;
  const env = input.env ?? process.env;
  const chain = buildProviderChain(search.provider, search.fallback);

  let firstError: unknown;
  let lastEmpty: WebSearchOrchestratorResult | undefined;

  for (const name of chain) {
    if (!isProviderUsable(name, input.config, env)) continue;

    const cacheKey = buildSearchCacheKey(
      name,
      input.options.query,
      input.options.maxResults,
    );
    const cached = input.cache?.get(cacheKey);
    if (cached) {
      if (cached.length > 0) {
        return { results: cached, provider: name, fromCache: true };
      }
      lastEmpty = { results: cached, provider: name, fromCache: true };
      continue;
    }

    const provider = resolveProviderByName(name, input.config, input.deps);
    try {
      const results = await provider.search(input.options);
      input.cache?.set(cacheKey, results);
      if (results.length > 0) {
        return { results, provider: name, fromCache: false };
      }
      lastEmpty = { results, provider: name, fromCache: false };
    } catch (err) {
      if (firstError === undefined) firstError = err;
      // WebSearchBlockedError and transport throws both advance the chain.
    }
  }

  if (lastEmpty) return lastEmpty;
  if (firstError !== undefined) throw firstError;
  // No usable provider in this env and nothing cached: surface a blocked-style
  // error against the primary so the tool emits a structured failure.
  throw new WebSearchBlockedError(
    search.provider,
    `no usable web search provider (checked ${chain.join(", ")})`,
  );
}

/** Ordered, deduped chain: primary first, then each configured fallback. */
function buildProviderChain(
  primary: WebSearchProviderName,
  fallback: readonly WebSearchProviderName[],
): WebSearchProviderName[] {
  const seen = new Set<WebSearchProviderName>();
  const chain: WebSearchProviderName[] = [];
  for (const name of [primary, ...fallback]) {
    if (seen.has(name)) continue;
    seen.add(name);
    chain.push(name);
  }
  return chain;
}

/**
 * `searxng` needs an `instanceUrl`; `brave` needs its API key in the env.
 * `duckduckgo` and `exa` are always attempted (Exa has a keyless MCP path).
 */
function isProviderUsable(
  name: WebSearchProviderName,
  config: Pick<AtomicAgentConfig, "web">,
  env: NodeJS.ProcessEnv,
): boolean {
  const search = config.web.search;
  switch (name) {
    case "searxng":
      return Boolean(search.searxng.instanceUrl);
    case "brave": {
      const key = env[search.brave.apiKeyEnv];
      return typeof key === "string" && key.length > 0;
    }
    case "tavily": {
      const key = env[search.tavily.apiKeyEnv];
      return typeof key === "string" && key.length > 0;
    }
    case "duckduckgo":
    case "exa":
      return true;
  }
}
