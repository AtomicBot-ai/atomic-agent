import type { AtomicAgentConfig } from "../../../../config/index.js";
import type { WebSearchProviderName } from "../web-search-provider.js";

/**
 * Startup diagnostic for a primary search provider that cannot run without
 * its API key.
 *
 * That is Brave: it has no keyless tier, so a keyless Brave primary is
 * skipped outright and every search goes to the fallback chain. The
 * operator configured one provider and is silently getting another, which
 * is the failure mode this warning exists to break (#179).
 *
 * Exa used to be reported here as well, as "running on the keyless tier —
 * expect HTTP 429". That line went to stderr on every start, which the
 * desktop logs as an error, and it described a request the agent no longer
 * makes: without a key Exa is skipped and the keyless chain (DuckDuckGo)
 * serves the search (ATO-120). That is the shipped default, not a
 * misconfiguration, so it says nothing.
 */

/** Providers that are skipped entirely when their `apiKeyEnv` is unset. */
const KEY_REQUIRED_PROVIDERS = new Set<WebSearchProviderName>(["brave"]);

export interface MissingSearchKeyWarning {
  provider: WebSearchProviderName;
  apiKeyEnv: string;
  /** Providers that will actually serve traffic instead of the primary. */
  fallback: WebSearchProviderName[];
  message: string;
}

/**
 * Returns a warning when the configured primary provider needs an API key
 * from the environment and that variable resolves to nothing. Returns `null`
 * for a keyed primary, a primary that runs without a key (`duckduckgo`,
 * `searxng`) or is skipped in favour of one (`exa`), or when search is
 * disabled outright.
 */
export function checkMissingSearchKey(input: {
  config: Pick<AtomicAgentConfig, "web">;
  env: NodeJS.ProcessEnv;
}): MissingSearchKeyWarning | null {
  const search = input.config.web.search;
  if (!search.enabled) return null;

  const provider = search.provider;
  if (!KEY_REQUIRED_PROVIDERS.has(provider)) return null;

  const apiKeyEnv = search.brave.apiKeyEnv;
  const key = input.env[apiKeyEnv]?.trim();
  if (typeof key === "string" && key.length > 0) return null;

  // Dedupe the primary out of the chain the same way the orchestrator does.
  const fallback = search.fallback.filter((name) => name !== provider);

  return {
    provider,
    apiKeyEnv,
    fallback,
    message: buildMessage(provider, apiKeyEnv, fallback),
  };
}

function buildMessage(
  provider: WebSearchProviderName,
  apiKeyEnv: string,
  fallback: WebSearchProviderName[],
): string {
  const destination =
    fallback.length > 0 ? fallback.join(", ") : "no other provider";
  return (
    `web.search: provider "${provider}" is configured but ${apiKeyEnv} is not set, ` +
    `so it is skipped entirely — every search goes to ${destination}. ` +
    `Set ${apiKeyEnv} to use it.`
  );
}
