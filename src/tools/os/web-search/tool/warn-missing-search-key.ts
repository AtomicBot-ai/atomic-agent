import type { AtomicAgentConfig } from "../../../../config/index.js";
import type { WebSearchProviderName } from "../web-search-provider.js";

/**
 * Startup diagnostic for a keyless primary search provider.
 *
 * `web.search.provider` defaults to `exa` with a `duckduckgo` fallback, and
 * Exa's keyless endpoint answers HTTP 429 under sustained agent load. The
 * fallback chain then works exactly as designed, so nothing hard-fails — the
 * run just quietly produces weaker groundings than the operator configured.
 * That silent degradation is the failure mode this warning exists to break:
 * it neither works well nor tells you why (#179).
 */

/** Providers whose configured `apiKeyEnv` materially changes their quota. */
const KEYED_PROVIDERS = new Set<WebSearchProviderName>(["exa", "brave"]);

export interface MissingSearchKeyWarning {
  provider: WebSearchProviderName;
  apiKeyEnv: string;
  /** Providers that will actually serve traffic once the primary is limited. */
  fallback: WebSearchProviderName[];
  message: string;
}

/**
 * Returns a warning when the configured primary provider reads an API key
 * from the environment and that variable resolves to nothing. Returns `null`
 * for a keyed primary, a keyless-by-design primary (`duckduckgo`, `searxng`),
 * or when search is disabled outright.
 */
export function checkMissingSearchKey(input: {
  config: Pick<AtomicAgentConfig, "web">;
  env: NodeJS.ProcessEnv;
}): MissingSearchKeyWarning | null {
  const search = input.config.web.search;
  if (!search.enabled) return null;

  const provider = search.provider;
  if (!KEYED_PROVIDERS.has(provider)) return null;

  const apiKeyEnv =
    provider === "exa" ? search.exa.apiKeyEnv : search.brave.apiKeyEnv;
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
  const consequence =
    fallback.length > 0
      ? `expect HTTP 429 and silent degradation to ${fallback.join(", ")}`
      : "expect HTTP 429 with no fallback configured";
  return (
    `web.search: provider "${provider}" is configured but ${apiKeyEnv} is not set; ` +
    `running on the keyless tier — ${consequence}. ` +
    `Set ${apiKeyEnv} for search-heavy autonomous work.`
  );
}
