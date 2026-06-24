import type { WebSearchProviderName } from "./web-search-provider.js";

/**
 * Raised when a provider page is recognised as a bot-challenge / rate-limit
 * wall rather than a genuine zero-result page. Surfaced to the model as a
 * structured `status:"error"` so the weak model stops re-querying a blocked
 * endpoint, and consumed by the orchestrator to advance the fallback chain.
 */
export class WebSearchBlockedError extends Error {
  readonly provider: WebSearchProviderName;

  constructor(provider: WebSearchProviderName, message?: string) {
    super(message ?? `${provider} rate-limited or returned a bot challenge`);
    this.name = "WebSearchBlockedError";
    this.provider = provider;
  }
}
