import { ConfigValidationError } from "./config-validation-error.js";
import {
  parseBool,
  parsePositiveInt,
  parseBoundedPositiveInt,
  parseNonNegativeBoundedInt,
  parseNonEmptyString,
} from "./config-primitives.js";

export type WebSearchProviderName = "duckduckgo" | "searxng" | "exa" | "brave";

/**
 * Tunables for `os.web.fetch` (config v38). Before v38 the tool hard-coded a
 * 30s overall budget with no connect timeout and no retries, so a single
 * unreachable host burned 30s of the task budget and a transient 503 (the
 * bulk of them from `web.archive.org`, which serves the same URL seconds
 * later) ended the fetch outright.
 */
export interface WebFetchConfig {
  /**
   * Overall per-attempt budget in milliseconds, passed to curl `--max-time`.
   * Kept at the historical 30_000 so unconfigured installs behave exactly as
   * before. A per-call `timeoutMs` tool argument overrides it.
   */
  timeoutMs: number;
  /**
   * TCP/TLS connect budget in milliseconds, passed to curl `--connect-timeout`.
   * Much smaller than `timeoutMs` because a host that has not completed a
   * handshake in 10s is almost never merely slow — it is firewalled, dead, or
   * blackholing packets, and waiting the full overall budget for it is pure
   * loss. A slow but reachable server still gets the whole `timeoutMs` to
   * stream its body, since `--connect-timeout` only covers the handshake.
   */
  connectTimeoutMs: number;
  /**
   * Extra attempts after the first for retryable failures (429/502/503/504 and
   * curl exit 28 "operation timed out"). `0` disables retrying. Deliberately
   * small: `os.web.fetch` is GET-only, so retries are always safe, but each one
   * spends task budget.
   */
  maxRetries: number;
  /**
   * Base delay in milliseconds for exponential backoff between retries
   * (attempt N waits `retryBaseDelayMs * 2^(N-1)`). A server-sent `Retry-After`
   * header wins over the computed delay when it is shorter than the cap.
   */
  retryBaseDelayMs: number;
  /**
   * Upper bound in milliseconds on any single backoff wait, including one
   * derived from `Retry-After`. Stops a hostile or overloaded origin from
   * parking the agent for minutes on a header value.
   */
  retryMaxDelayMs: number;
}

export interface WebSearchConfig {
  enabled: boolean;
  provider: WebSearchProviderName;
  maxResults: number;
  timeoutMs: number;
  /**
   * Per-runtime result cache TTL in minutes. `0` disables caching. The cache
   * is the primary defence against provider rate-limiting on repeated queries.
   *
   * An hour, raised from fifteen minutes. An agent re-issues near-identical
   * queries across the steps of one task and across tasks in one run, and
   * every expiry inside that window spends quota to re-fetch a result it
   * already had (#179). Search results for the factual lookups this is
   * mostly used for do not turn over in an hour; a rate limit does.
   */
  cacheTtlMinutes: number;
  /**
   * Persist the result cache and the provider cooldown under `stateDir`
   * (v46, #256), so a campaign that runs one process per task inherits
   * both instead of starting cold and re-spending quota on queries the
   * last process already answered. Key/TTL/eviction semantics are
   * unchanged — only the storage moves. Default `true`; set `false` for
   * workloads that genuinely want a cold cache per run (reproducing a
   * benchmark, for one).
   */
  persistCache: boolean;
  /**
   * Ordered fallback providers tried (after the primary) when a search is
   * blocked / empty / throws. Default `["duckduckgo"]` — the keyless Exa
   * primary degrades to DuckDuckGo's keyless HTML endpoint. Both are
   * config-free; `searxng` (needs `instanceUrl`) and `brave` (needs an API
   * key) are skipped by the orchestrator until configured. Set to `[]` to
   * disable fallback entirely. The primary is always deduped out of this list.
   */
  fallback: WebSearchProviderName[];
  searxng: {
    instanceUrl: string | null;
  };
  exa: {
    endpoint: string;
    apiEndpoint: string;
    apiKeyEnv: string;
  };
  brave: {
    apiKeyEnv: string;
  };
}

export function createWebSearchDefaults(): WebSearchConfig {
  return {
    enabled: true,
    provider: "exa",
    maxResults: 8,
    timeoutMs: 15_000,
    cacheTtlMinutes: 60,
    persistCache: true,
    fallback: ["duckduckgo"],
    searxng: {
      instanceUrl: null,
    },
    exa: {
      endpoint: "https://mcp.exa.ai/mcp",
      apiEndpoint: "https://api.exa.ai/search",
      apiKeyEnv: "EXA_API_KEY",
    },
    brave: {
      apiKeyEnv: "BRAVE_SEARCH_API_KEY",
    },
  };
}

export function createWebFetchDefaults(): WebFetchConfig {
  return {
    timeoutMs: 30_000,
    connectTimeoutMs: 10_000,
    maxRetries: 2,
    retryBaseDelayMs: 500,
    retryMaxDelayMs: 5_000,
  };
}

export function parseWebSearchProviderName(
  raw: unknown,
  field: string,
): WebSearchProviderName {
  if (
    raw === "duckduckgo" ||
    raw === "searxng" ||
    raw === "exa" ||
    raw === "brave"
  ) {
    return raw;
  }
  throw new ConfigValidationError(
    field,
    `expected one of duckduckgo|searxng|exa|brave, got ${JSON.stringify(raw)}`,
  );
}

/**
 * Parse the opt-in fallback chain: each entry must be a valid provider name,
 * the list is deduped, and the primary provider is dropped (it always runs
 * first). A non-array value is rejected.
 */
export function parseWebSearchFallback(
  raw: unknown,
  primary: WebSearchProviderName,
  field: string,
): WebSearchProviderName[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigValidationError(
      field,
      `expected an array of provider names, got ${JSON.stringify(raw)}`,
    );
  }
  const seen = new Set<WebSearchProviderName>([primary]);
  const out: WebSearchProviderName[] = [];
  for (let i = 0; i < raw.length; i++) {
    const name = parseWebSearchProviderName(raw[i], `${field}[${i}]`);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export interface PreparedWebSearchInputs {
  raw: Record<string, unknown>;
  provider: WebSearchProviderName;
  searxng: Record<string, unknown>;
  exa: Record<string, unknown>;
  brave: Record<string, unknown>;
}

export function prepareWebSearchInputs(
  raw: Record<string, unknown>,
  readDefaults: () => WebSearchConfig,
): PreparedWebSearchInputs {
  const provider = parseWebSearchProviderName(
    raw.provider ?? readDefaults().provider,
    "web.search.provider",
  );
  const searxng =
    (raw.searxng as Record<string, unknown> | undefined) ?? {};
  const exa =
    (raw.exa as Record<string, unknown> | undefined) ?? {};
  const brave =
    (raw.brave as Record<string, unknown> | undefined) ?? {};
  return { raw, provider, searxng, exa, brave };
}

export function parseWebSearchConfig(
  prepared: PreparedWebSearchInputs,
  readDefaults: () => WebSearchConfig,
): WebSearchConfig {
  const { raw, provider, searxng, exa, brave } = prepared;
  return {
    enabled: parseBool(
      raw.enabled ?? readDefaults().enabled,
      "web.search.enabled",
    ),
    provider: provider,
    maxResults: parseBoundedPositiveInt(
      raw.maxResults ?? readDefaults().maxResults,
      "web.search.maxResults",
      1,
      20,
    ),
    timeoutMs: parsePositiveInt(
      raw.timeoutMs ?? readDefaults().timeoutMs,
      "web.search.timeoutMs",
    ),
    cacheTtlMinutes: parseNonNegativeBoundedInt(
      raw.cacheTtlMinutes ?? readDefaults().cacheTtlMinutes,
      "web.search.cacheTtlMinutes",
      0,
      1440,
    ),
    persistCache: parseBool(
      raw.persistCache ?? readDefaults().persistCache,
      "web.search.persistCache",
    ),
    fallback: parseWebSearchFallback(
      raw.fallback ?? readDefaults().fallback,
      provider,
      "web.search.fallback",
    ),
    searxng: {
      instanceUrl:
        searxng.instanceUrl === null ||
        searxng.instanceUrl === undefined
          ? null
          : parseNonEmptyString(
              searxng.instanceUrl,
              "web.search.searxng.instanceUrl",
            ),
    },
    exa: {
      endpoint: parseNonEmptyString(
        exa.endpoint ?? readDefaults().exa.endpoint,
        "web.search.exa.endpoint",
      ),
      apiEndpoint: parseNonEmptyString(
        exa.apiEndpoint ?? readDefaults().exa.apiEndpoint,
        "web.search.exa.apiEndpoint",
      ),
      apiKeyEnv: parseNonEmptyString(
        exa.apiKeyEnv ?? readDefaults().exa.apiKeyEnv,
        "web.search.exa.apiKeyEnv",
      ),
    },
    brave: {
      apiKeyEnv: parseNonEmptyString(
        brave.apiKeyEnv ?? readDefaults().brave.apiKeyEnv,
        "web.search.brave.apiKeyEnv",
      ),
    },
  };
}

export function parseWebFetchConfig(
  raw: Record<string, unknown>,
  readDefaults: () => WebFetchConfig,
): WebFetchConfig {
  return {
    timeoutMs: parsePositiveInt(
      raw.timeoutMs ?? readDefaults().timeoutMs,
      "web.fetch.timeoutMs",
    ),
    connectTimeoutMs: parsePositiveInt(
      raw.connectTimeoutMs ?? readDefaults().connectTimeoutMs,
      "web.fetch.connectTimeoutMs",
    ),
    maxRetries: parseNonNegativeBoundedInt(
      raw.maxRetries ?? readDefaults().maxRetries,
      "web.fetch.maxRetries",
      0,
      5,
    ),
    retryBaseDelayMs: parsePositiveInt(
      raw.retryBaseDelayMs ?? readDefaults().retryBaseDelayMs,
      "web.fetch.retryBaseDelayMs",
    ),
    retryMaxDelayMs: parsePositiveInt(
      raw.retryMaxDelayMs ?? readDefaults().retryMaxDelayMs,
      "web.fetch.retryMaxDelayMs",
    ),
  };
}
