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

/**
 * Machine-readable "an Exa API key would fix this" signal, put in the
 * `os.web.search` tool result `details.keyRequired` (ATO-327). A host app
 * renders a key card from it; the model reads the same advice in the text.
 *
 * Present only while Exa is in the provider chain and `envVar` resolves to
 * no key, and only when the keyless Exa tier did not serve the search:
 * - `rate_limited`: keyless Exa answered HTTP 429 (or is still parked for
 *   one). The search may still have succeeded through a fallback.
 * - `unreachable`: keyless Exa could not be reached and no provider
 *   answered.
 * - `missing`: keyless Exa failed some other way (a 403, a bad answer)
 *   and no provider answered.
 *
 * Never present when a key is set: a keyed Exa failure is not fixed by a key.
 */
export interface WebSearchKeyRequired {
  provider: "exa";
  reason: "rate_limited" | "unreachable" | "missing";
  getKeyUrl: string;
  envVar: string;
}

/** Where a free Exa API key is issued. */
export const EXA_GET_KEY_URL = "https://dashboard.exa.ai/api-keys";

/**
 * Every provider in the chain failed. The message is the whole report the
 * model and the user read: one plain line per provider and one action.
 * `failures` repeats the per-provider lines for `details`.
 *
 * A subclass of {@link WebSearchBlockedError}, like the rate-limit error,
 * so code that treats a blocked search as a structured failure keeps doing
 * so. `provider` is the configured primary.
 */
export class WebSearchUnavailableError extends WebSearchBlockedError {
  readonly failures: readonly string[];
  readonly keyRequired: WebSearchKeyRequired | undefined;

  constructor(
    provider: WebSearchProviderName,
    message: string,
    failures: readonly string[],
    keyRequired?: WebSearchKeyRequired,
  ) {
    super(provider, message);
    this.name = "WebSearchUnavailableError";
    this.failures = failures;
    this.keyRequired = keyRequired;
  }
}
