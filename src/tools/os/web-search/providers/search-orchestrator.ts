import type { AtomicAgentConfig } from "../../../../config/index.js";
import {
  buildSearchCacheKey,
  type SearchCache,
} from "../transport/search-cache.js";
import {
  formatCooldown,
  type CooldownTag,
  type ProviderCooldown,
} from "../transport/provider-cooldown.js";
import {
  EXA_GET_KEY_URL,
  WebSearchBlockedError,
  WebSearchRateLimitedError,
  WebSearchUnavailableError,
  type WebSearchKeyHelp,
  type WebSearchKeyRequired,
} from "../web-search-errors.js";
import type {
  WebSearchHttpDeps,
  WebSearchProviderName,
  WebSearchProviderOptions,
  WebSearchResult,
} from "../web-search-provider.js";
import { resolveProviderByName } from "./provider-registry.js";
import {
  buildUnavailableMessage,
  describeFailure,
  isConnectFailure,
} from "./search-failure-report.js";

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
  /** Which "add a key" advice the error gives (ATO-345). Default `env-file`. */
  keyHelp?: WebSearchKeyHelp;
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
  /**
   * Set when Exa is running keyless and hit its free limit on the way to
   * this answer (ATO-327). See {@link WebSearchKeyRequired}.
   */
  keyRequired?: WebSearchKeyRequired;
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
  let lastEmpty: WebSearchOrchestratorResult | undefined;
  const degraded: string[] = [];
  // Plain-words line per provider that did not answer, for the error the
  // tool returns when none did (ATO-325).
  const failures: string[] = [];
  let connectFailures = 0;
  // Exa without a key goes through its free tier, which runs out fast.
  // What happened to it decides whether a key is worth asking for.
  const keylessExa =
    chain.includes("exa") && !hasEnvKey(env, search.exa.apiKeyEnv);
  let exaOutcome: WebSearchKeyRequired["reason"] | undefined;
  const keyRequired = (
    reason: WebSearchKeyRequired["reason"],
  ): WebSearchKeyRequired => ({
    provider: "exa",
    reason,
    getKeyUrl: EXA_GET_KEY_URL,
    envVar: search.exa.apiKeyEnv,
  });
  // A result can be built before Exa's outcome is known (an empty answer
  // kept while the chain goes on), so the signal is attached on return.
  const finish = (
    result: WebSearchOrchestratorResult,
  ): WebSearchOrchestratorResult =>
    keylessExa && exaOutcome === "rate_limited"
      ? { ...result, keyRequired: keyRequired("rate_limited") }
      : result;

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
    //
    // Exa's keyless and keyed tiers have separate quotas. A park from the
    // free tier must not hold back a key the user has just added (and was
    // told to restart for, which the persisted cooldown survives), so a
    // park tagged with the other tier is dropped here (ATO-327).
    const tier: CooldownTag | undefined =
      name === "exa" ? (keylessExa ? "keyless" : "keyed") : undefined;
    const parkedTier = tier !== undefined ? cooldown?.tagOf(name) : undefined;
    if (parkedTier !== undefined && parkedTier !== tier) cooldown?.clear(name);
    const parkedFor = cooldown?.remainingMs(name, now()) ?? 0;

    const cacheKey = buildSearchCacheKey(
      name,
      input.options.query,
      input.options.maxResults,
    );
    const cached = input.cache?.get(cacheKey);
    if (cached) {
      if (cached.length > 0) {
        return finish({
          results: cached,
          provider: name,
          fromCache: true,
          degraded,
        });
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
      const freeTier = keylessExa && name === "exa";
      degraded.push(
        freeTier
          ? `${name} skipped: free limit reached, retrying in ${formatCooldown(parkedFor)}`
          : `${name} skipped: rate limited, retrying in ${formatCooldown(parkedFor)}`,
      );
      failures.push(
        freeTier
          ? `${name}: free limit reached, next try in ${formatCooldown(parkedFor)}`
          : `${name}: rate limited, next try in ${formatCooldown(parkedFor)}`,
      );
      if (freeTier) exaOutcome = "rate_limited";
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
        return finish({ results, provider: name, fromCache: false, degraded });
      }
      lastEmpty = { results, provider: name, fromCache: false, degraded };
    } catch (err) {
      // A Stop fails whatever provider was running. That is not a search
      // failure: no report, no key card, the abort goes up as it did.
      if (input.options.signal.aborted) throw err;
      const freeTier = keylessExa && name === "exa";
      failures.push(describeFailure(name, err, freeTier));
      if (isConnectFailure(err)) connectFailures++;
      if (freeTier) {
        exaOutcome =
          err instanceof WebSearchRateLimitedError
            ? "rate_limited"
            : isConnectFailure(err)
              ? "unreachable"
              : "missing";
      }
      if (err instanceof WebSearchRateLimitedError && cooldown) {
        const parked = cooldown.park(name, now(), err.retryAfterMs, tier);
        degraded.push(
          freeTier
            ? `${name} free limit reached (HTTP 429, no ${search.exa.apiKeyEnv}), parked for ${formatCooldown(parked)}`
            : `${name} rate limited (HTTP 429), parked for ${formatCooldown(parked)}`,
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

  if (lastEmpty) return finish(lastEmpty);
  if (failures.length > 0) {
    // Nothing answered while Exa ran keyless: a key is the one change that
    // gives the chain a provider with its own quota, whatever Exa's
    // failure was (`missing` when it was not a 429 or a connect failure).
    const signal = keylessExa ? keyRequired(exaOutcome ?? "missing") : undefined;
    throw new WebSearchUnavailableError(
      search.provider,
      buildUnavailableMessage({
        failures,
        keyRequired: signal,
        allUnreachable: connectFailures > 0 && connectFailures === failures.length,
        keyHelp: input.keyHelp,
      }),
      failures,
      signal,
    );
  }
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
 * Exa without a key stays where it is configured and runs on its keyless
 * tier (ATO-327). That tier runs out of free quota quickly, so a chain
 * with keyless Exa gains DuckDuckGo at the end when it does not already
 * have it: `provider: "exa"` with `fallback: []` still has somewhere to
 * go once the free limit is reached.
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
 * `searxng` needs an `instanceUrl`; `brave` needs its API key in the env.
 * `duckduckgo` and `exa` are always attempted.
 *
 * Exa without a key goes through its public MCP endpoint. ATO-120 (#609)
 * skipped it, because that tier answers 429 under load; but that left
 * DuckDuckGo as the only keyless provider, and where DuckDuckGo is blocked
 * search did not work at all (ATO-315). It is attempted again (ATO-327):
 * a 429 parks it through the cooldown, the notes say the free limit is
 * reached, and the result carries `keyRequired` so the user is asked for
 * a key instead of paying the 429 on every query.
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
