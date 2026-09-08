import type { ProviderFallbackChain } from "./provider-fallback-chain.js";

/**
 * Drive a unit of work through the fallback chain.
 *
 * `attempt(providerId)` runs the caller's real completion against one
 * provider id and resolves on success or throws on failure. This module
 * owns only the switching policy: pick the starting provider, and on a
 * fallover-worthy failure advance to the next chain link and retry the
 * SAME work.
 *
 * When every link has failed, the error rethrown is the FIRST one — the
 * failure of the provider the operator actually chose, which is the id
 * the composer chip and Settings name. It is rethrown untouched, so the
 * existing `loop_failed` classification and humanized messaging are
 * preserved exactly as they were.
 *
 * It used to be the LAST error, and that is a much worse answer than it
 * sounds. `resolveFallbackChain` appends the configured `llama-server`
 * provider to the tail of every chain, whether or not a local model has
 * ever been downloaded, so the tail link on a cloud-only installation is
 * a daemon that is not running. A cloud provider that answers — say
 * OpenRouter refusing with `402 … requires more credits, or fewer
 * max_tokens` — was therefore reported to the operator as the tail
 * link's `fetch failed`: a socket error, from a backend they never
 * picked, naming nothing they could act on, while the provider's own
 * sentence (which said exactly what to do) was dropped on the floor.
 * The tail's failure is an accident of the chain; the head's is the
 * answer to "why did my message not go through".
 *
 * Nothing about the switching itself changes: every link is still tried
 * in order and every failure is still registered with the breaker, so
 * quarantine and probe behaviour are untouched.
 *
 * Shared by both the non-stream (`llmComplete`) and stream-opening
 * (`llmCompleteStream`) seams. For streaming, `attempt` must resolve only
 * once the stream has successfully OPENED — a stream already emitting
 * chunks is never restarted (mirrors the openai-http "stream is live"
 * contract), so failures after the first chunk propagate as-is.
 */
export async function runWithFallback<T>(
  chain: ProviderFallbackChain,
  attempt: (providerId: string) => Promise<T>,
  partitionKey?: string,
): Promise<T> {
  const pick = chain.pickProvider(partitionKey);
  let currentId = pick.providerId;
  let wasProbe = pick.isProbe;

  // Guard against a pathological empty chain: no provider to try.
  if (!currentId) {
    return attempt(currentId);
  }

  // The failure of the link the operator is on. Held from the first
  // catch so that an exhausted chain reports the provider they picked
  // rather than whatever the tail of the chain happened to be. When
  // nothing falls over this IS the only error, so the single-attempt
  // path is byte-for-byte what it always was.
  let primaryError: unknown;
  let havePrimaryError = false;

  for (;;) {
    try {
      const result = await attempt(currentId);
      chain.recordSuccess(currentId, wasProbe, partitionKey);
      return result;
    } catch (err) {
      if (!havePrimaryError) {
        primaryError = err;
        havePrimaryError = true;
      }
      const nextId = chain.advanceFrom(currentId, err, partitionKey);
      if (nextId === null) throw primaryError;
      currentId = nextId;
      // Only the very first pick can be a probe; every advance is a real
      // fallover on the working path.
      wasProbe = false;
    }
  }
}
