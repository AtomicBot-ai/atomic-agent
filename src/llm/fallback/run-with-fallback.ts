import {
  attachFailedAttempts,
  attachFailingLink,
  type FailedAttempt,
} from "./failed-attempts.js";
import { isBillingRefusal, isCredentialRejection } from "./link-failure-kind.js";
import type { ProviderFallbackChain } from "./provider-fallback-chain.js";
import { shouldAdvance } from "./should-advance.js";

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
 * **Except when the primary refused its key and nothing stood in for
 * it.** A refusal of the key by the primary in this very call
 * (`isCredentialRejection`: a wrong, dead or missing key, or one that
 * could not even be sent) outranks whatever the links after it said,
 * unless a fallback has served this partition since the chain left the
 * primary. The last link's error would otherwise decide the turn, and a
 * stopped local server's `fetch failed` parks it for the whole outage
 * wait, telling the user the model is not answering while the fix is the
 * key (item 29). The primary's own error classifies as a refusal, so the
 * turn ends at once with its sentence. Nothing failed before it, so
 * nothing is recorded beside it; each later link's failure is in the
 * advance log. A fallback that has been serving is the route the user
 * is actually on, so its outage still gets the outage wait, as before.
 *
 * **The same for an account that cannot pay** (`isBillingRefusal`: a
 * 402, AI/ML API's 403 "You've run out of funds", OpenAI's 429
 * `insufficient_quota`). The primary's billing refusal outranks the
 * links after it on the same terms as its refused key (item 40: the
 * turn parked on a stopped local server and the window named that
 * server). And a fallback that has been serving this partition and now
 * says the account is empty is the route the user is on saying no: when
 * the chain runs out after it, its refusal is thrown, with the links
 * that failed before it recorded beside it, rather than a later link's
 * outage. Every billing refusal ends the turn without the outage wait.
 *
 * Every thrown error also carries the id of the link that threw it
 * (`attachFailingLink`), for the hosts that say which link a parked turn
 * is waiting on.
 *
 * **A call its caller stopped never falls over.** Once `signal` has
 * aborted, whatever the attempt threw is the stop's doing — a stop that
 * lands as a stream ends can come back as `terminated` or `fetch failed`
 * — and says nothing about the link. Advancing on it armed that link's
 * breaker and flipped the sticky override, so the next turn ran on the
 * fallback for nothing; recording it beside the error made a cancelled
 * turn report the primary's transport failure. It is rethrown as it is.
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
  signal?: AbortSignal,
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
  /** The primary's own refusal of its key or its account, when this call asked it. */
  let primaryRefusal: { providerId: string; error: unknown } | null = null;
  /** The serving fallback's billing refusal, and the links that failed before it. */
  let routeRefusal: {
    providerId: string;
    error: unknown;
    before: FailedAttempt[];
  } | null = null;

  for (;;) {
    try {
      const result = await attempt(currentId);
      chain.recordSuccess(currentId, wasProbe, partitionKey);
      return result;
    } catch (err) {
      if (signal?.aborted) {
        attachFailingLink(err, currentId);
        throw err;
      }
      // Read before `advanceFrom` moves the override past this link.
      const serving = chain.isServingFallback(currentId, partitionKey);
      const nextId = chain.advanceFrom(currentId, err, partitionKey);
      if (nextId === null) {
        // `null` is also the answer for an error that must not fall over
        // (a cancellation, a request-shape error): that one is thrown as
        // is. Only a chain that ran out of links defers to the primary.
        if (
          primaryRefusal !== null &&
          shouldAdvance(err).advance &&
          !chain.hasFallbackServed(partitionKey)
        ) {
          attachFailingLink(primaryRefusal.error, primaryRefusal.providerId);
          throw primaryRefusal.error;
        }
        if (routeRefusal !== null && shouldAdvance(err).advance) {
          attachFailedAttempts(routeRefusal.error, routeRefusal.before);
          attachFailingLink(routeRefusal.error, routeRefusal.providerId);
          throw routeRefusal.error;
        }
        attachFailedAttempts(err, failed);
        attachFailingLink(err, currentId);
        throw err;
      }
      if (
        chain.isPrimary(currentId) &&
        (isCredentialRejection(err) || isBillingRefusal(err))
      ) {
        primaryRefusal = { providerId: currentId, error: err };
      } else if (routeRefusal === null && serving && isBillingRefusal(err)) {
        routeRefusal = { providerId: currentId, error: err, before: [...failed] };
      }
      failed.push({ providerId: currentId, error: err });
      currentId = nextId;
      // Only the very first pick can be a probe; every advance is a real
      // fallover on the working path.
      wasProbe = false;
    }
  }
}
