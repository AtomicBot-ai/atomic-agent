import { attachFailedAttempts, type FailedAttempt } from "./failed-attempts.js";
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
 * Untouched, but not alone: the links that failed before it are recorded
 * beside the error (`attachFailedAttempts`), so a failure line can say
 * that the primary answered 404 before the local fallback turned out not
 * to be running. The last link still decides everything else — its error
 * is the one classified, and the link the turn waits on.
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

  // A call that starts on a sticky override never touches the primary.
  // Every retry of a parked turn is such a call, so without the cause the
  // turn ends on the fallback's `fetch failed` alone, five minutes after
  // the primary's real refusal was last mentioned anywhere.
  const cause = pick.isProbe ? null : chain.overrideCause(partitionKey);
  const failed: FailedAttempt[] = cause ? [cause] : [];

  for (;;) {
    try {
      const result = await attempt(currentId);
      chain.recordSuccess(currentId, wasProbe, partitionKey);
      return result;
    } catch (err) {
      const nextId = chain.advanceFrom(currentId, err, partitionKey);
      if (nextId === null) {
        attachFailedAttempts(err, failed);
        throw err;
      }
      failed.push({ providerId: currentId, error: err });
      currentId = nextId;
      // Only the very first pick can be a probe; every advance is a real
      // fallover on the working path.
      wasProbe = false;
    }
  }
}
