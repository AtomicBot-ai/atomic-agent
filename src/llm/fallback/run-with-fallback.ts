import type { ProviderFallbackChain } from "./provider-fallback-chain.js";

/**
 * Drive a unit of work through the fallback chain.
 *
 * `attempt(providerId)` runs the caller's real completion against one
 * provider id and resolves on success or throws on failure. This module
 * owns only the switching policy: pick the starting provider, and on a
 * fallover-worthy failure advance to the next chain link and retry the
 * SAME work. When the chain is exhausted (or the error is not
 * fallover-worthy), the last error is rethrown untouched so the existing
 * `loop_failed` classification and humanized messaging are preserved.
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

  for (;;) {
    try {
      const result = await attempt(currentId);
      chain.recordSuccess(currentId, wasProbe, partitionKey);
      return result;
    } catch (err) {
      const nextId = chain.advanceFrom(currentId, err, partitionKey);
      if (nextId === null) throw err;
      currentId = nextId;
      // Only the very first pick can be a probe; every advance is a real
      // fallover on the working path.
      wasProbe = false;
    }
  }
}
