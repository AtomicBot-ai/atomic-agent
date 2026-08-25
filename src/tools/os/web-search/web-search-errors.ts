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

/**
 * A provider answered 429 after the transport had already spent its
 * retries on it.
 *
 * A subclass of {@link WebSearchBlockedError} rather than a sibling,
 * because everything that already treats a blocked provider as "advance
 * the chain" should keep doing exactly that. What the subclass adds is
 * the one fact the orchestrator needs to stop *re-asking*: this was a
 * quota, not a bad page, and asking again in two seconds will produce
 * the same answer.
 *
 * `retryAfterMs` carries the server's own `Retry-After` when it sent
 * one. It is the difference between guessing how long to wait and being
 * told.
 */
export class WebSearchRateLimitedError extends WebSearchBlockedError {
  /** Server-advertised wait, or `null` when it did not say. */
  readonly retryAfterMs: number | null;

  constructor(
    provider: WebSearchProviderName,
    retryAfterMs: number | null = null,
    message?: string,
  ) {
    super(provider, message ?? `${provider} returned HTTP 429 (rate limited)`);
    this.name = "WebSearchRateLimitedError";
    this.retryAfterMs = retryAfterMs;
  }
}
