import type { AtomicAgentConfig } from "../../../../config/index.js";
import {
  buildSearchCacheKey,
  type SearchCache,
} from "../transport/search-cache.js";
import {
  formatCooldown,
  type ProviderCooldown,
} from "../transport/provider-cooldown.js";
import {
  WebSearchBlockedError,
  WebSearchRateLimitedError,
} from "../web-search-errors.js";
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
  /**
   * Parked providers. Optional so existing callers and tests keep
   * working; without it the chain behaves exactly as it did, which is
   * to say it walks back into the same rate limit on every query.
   */
  cooldown?: ProviderCooldown;
  /** Injectable clock, so a cooldown test does not wait out a real minute. */
  now?: () => number;
}

export interface WebSearchOrchestratorResult {
  results: WebSearchResult[];
  provider: WebSearchProviderName;
  fromCache: boolean;
  /**
   * Providers that did not get to answer, and why — a rate limit they
   * had just hit, or one they are still parked for. Empty on the happy
   * path.
   *
   * This is the answer to the half of #179 that backoff does not touch:
   * the fallback chain worked exactly as designed, so nothing failed,
   * so nothing was reported — and a campaign spent 44% of its tool calls
   * being quietly served by the weaker provider. A degradation nobody
   * can see is not a degradation anybody fixes.
   */
  degraded: readonly string[];
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

  const now = input.now ?? Date.now;
  const cooldown = input.cooldown;
  let firstError: unknown;
  let lastEmpty: WebSearchOrchestratorResult | undefined;
  const degraded: string[] = [];

  for (const name of chain) {
    if (!isProviderUsable(name, input.config, env)) continue;

    // Parked for a rate limit it hit earlier. Skipping it here is the
    // whole point: against a standing quota the alternative is three
    // requests that cannot succeed and ~1.5s of backoff, on every
    // single query, before reaching the provider that was always going
    // to serve it.
    //
    // The cache is still consulted first — a parked provider's earlier
    // answers are not stale just because its quota ran out.
    const parkedFor = cooldown?.remainingMs(name, now()) ?? 0;

    const cacheKey = buildSearchCacheKey(
      name,
      input.options.query,
      input.options.maxResults,
    );
    const cached = input.cache?.get(cacheKey);
    if (cached) {
      if (cached.length > 0) {
        return { results: cached, provider: name, fromCache: true, degraded };
      }
      lastEmpty = { results: cached, provider: name, fromCache: true, degraded };
      continue;
    }

    if (parkedFor > 0) {
      degraded.push(
        `${name} skipped: rate limited, retrying in ${formatCooldown(parkedFor)}`,
      );
      continue;
    }

    const provider = resolveProviderByName(name, input.config, input.deps);
    try {
      const results = await provider.search(input.options);
      input.cache?.set(cacheKey, results);
      // It answered, so whatever it was parked for is over. Clearing
      // the strike count here is what keeps the escalation honest: the
      // ladder measures *consecutive* failures, not lifetime ones.
      cooldown?.clear(name);
      if (results.length > 0) {
        return { results, provider: name, fromCache: false, degraded };
      }
      lastEmpty = { results, provider: name, fromCache: false, degraded };
    } catch (err) {
      if (firstError === undefined) firstError = err;
      if (err instanceof WebSearchRateLimitedError && cooldown) {
        const parked = cooldown.park(name, now(), err.retryAfterMs);
        degraded.push(
          `${name} rate limited (HTTP 429), parked for ${formatCooldown(parked)}`,
        );
      }
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
