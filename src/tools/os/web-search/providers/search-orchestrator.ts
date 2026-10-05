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
   * had just hit, one they are still parked for, or a failure a later
   * provider covered for. Empty on the happy path.
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
  const chain = buildProviderChain(search, env);

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
      lastEmpty = {
        results: cached,
        provider: name,
        fromCache: true,
        degraded,
      };
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
      } else {
        // Recorded, not raised: if a later provider answers, this search
        // succeeded and the tool reports ok. The failure stays readable
        // in the notes instead of becoming the tool's error (ATO-120).
        degraded.push(`${name} failed: ${describeError(err)}`);
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

/**
 * Ordered, deduped chain: primary first, then each configured fallback.
 *
 * Exa without a key is not in it (`isProviderUsable` skips it), and a
 * chain that loses Exa that way gains DuckDuckGo at the end when it does
 * not already have it. Without that, `provider: "exa"` with
 * `fallback: []` would go from "searches through keyless Exa" to "cannot
 * search at all" the moment the keyless tier is skipped.
 */
function buildProviderChain(
  search: AtomicAgentConfig["web"]["search"],
  env: NodeJS.ProcessEnv,
): WebSearchProviderName[] {
  const seen = new Set<WebSearchProviderName>();
  const chain: WebSearchProviderName[] = [];
  for (const name of [search.provider, ...search.fallback]) {
    if (seen.has(name)) continue;
    seen.add(name);
    chain.push(name);
  }
  if (
    seen.has("exa") &&
    !hasEnvKey(env, search.exa.apiKeyEnv) &&
    !seen.has("duckduckgo")
  ) {
    chain.push("duckduckgo");
  }
  return chain;
}

/**
 * `searxng` needs an `instanceUrl`; `brave` and `exa` need their API key
 * in the env. `duckduckgo` is always attempted.
 *
 * Exa used to be attempted keyless too, through its public MCP endpoint.
 * That tier answered 429 under any real load and has since been seen
 * answering 403 outright, so every search paid a doomed request before
 * reaching the provider that would serve it, and a run where DuckDuckGo
 * was also blocked surfaced Exa's error instead of the real one
 * (ATO-120). Without a key Exa is now skipped like Brave is.
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
    case "exa":
      return hasEnvKey(env, search.exa.apiKeyEnv);
    case "duckduckgo":
      return true;
  }
}

/** Same reading the Exa provider applies: a whitespace-only key is no key. */
function hasEnvKey(env: NodeJS.ProcessEnv, name: string): boolean {
  const key = env[name]?.trim();
  return typeof key === "string" && key.length > 0;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
