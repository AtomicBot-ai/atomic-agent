import type { SearchHttpResponse } from "../transport/index.js";
import { WebSearchRateLimitedError } from "../web-search-errors.js";
import type { WebSearchProviderName } from "../web-search-provider.js";

/**
 * The one place a provider turns an HTTP status into a throw.
 *
 * It exists to make 429 a *typed* outcome. Every provider used to raise
 * a bare `Error` with the status baked into the message — `Exa returned
 * HTTP 429` — which the orchestrator could only treat as "something
 * went wrong, try the next one". A quota and a broken endpoint are not
 * the same failure and do not want the same response: one should stop
 * being asked for a while, the other should be retried the moment the
 * next query arrives.
 *
 * `label` is the provider's display name (`Exa`, `DuckDuckGo`); `name`
 * is its registry key. Keeping both means the message an operator reads
 * stays the one they are used to while the value the orchestrator
 * matches on is the enum.
 */
export function assertProviderStatus(
  response: Pick<SearchHttpResponse, "status" | "retryAfterMs">,
  name: WebSearchProviderName,
  label: string,
): void {
  if (response.status === 429) {
    throw new WebSearchRateLimitedError(
      name,
      response.retryAfterMs,
      `${label} returned HTTP 429 (rate limited)`,
    );
  }
  if (response.status >= 400) {
    throw new Error(`${label} returned HTTP ${response.status}`);
  }
}
