import {
  classifyProviderWaitCause,
  type ProviderWaitFailure,
} from "../reliability/provider-wait-cause.js";
import { describeReason } from "./describe-reason.js";
import { readFailedAttempts } from "./failed-attempts.js";

/**
 * The links that failed before `err` (`readFailedAttempts`), each with
 * its own cause, in the order they were tried.
 *
 * What a host says first when a turn waits on, or fails at, a later
 * link: the provider the user picked is usually the first entry, and
 * why it failed (an account out of funds, a refused key) is not the last
 * link's `fetch failed`. Item 40: AI/ML API answered "You've run out of
 * funds", the chain fell over to a stopped local server, and the window
 * named only that server.
 */
export function describeFailedLinks(err: unknown): ProviderWaitFailure[] {
  return readFailedAttempts(err).map((a) => ({
    providerId: a.providerId,
    reason: describeReason(a.error),
    cause: classifyProviderWaitCause(a.error),
  }));
}
