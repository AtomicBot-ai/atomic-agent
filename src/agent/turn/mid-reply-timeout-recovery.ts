import { TransportError } from "../../llm/index.js";
import { readMidReplyTimeout } from "../../llm/reliability/mid-reply-timeout.js";
import { WRITE_IN_PARTS } from "./truncation-recovery.js";

/**
 * How the agent loop recovers when a provider's time limit ends a long
 * reply (ATO-1398).
 *
 * Replaying the same request is pointless: a reply too long to finish
 * inside the limit is cut at the same place again, and each attempt runs
 * for minutes that `providerWait.maxWaitMs` does not count. So the retry
 * changes the request: a notice asking for a much shorter reply. After
 * the budget the turn ends, saying why.
 *
 * Only a request that ran for a while qualifies. A 504 reported seconds
 * into a stream is an ordinary outage and keeps the outage wait.
 */

/** A request that ran at least this long before the time limit ended it. */
export const MID_REPLY_TIMEOUT_MIN_ELAPSED_MS = 60_000;

/** Retries one step may take; the next timeout on that step ends the turn. */
export const MID_REPLY_TIMEOUT_STEP_BUDGET = 2;

const NOTICE =
  "Your previous reply to this step ran too long: the provider stopped it on a time limit before it finished, and none of it was kept. " +
  `Think less: keep your reasoning brief and make this reply much shorter. ${WRITE_IN_PARTS}`;

export type MidReplyTimeoutPlan =
  | { kind: "retry"; attempts: number }
  | { kind: "give_up"; error: TransportError };

export function planMidReplyTimeoutRetry(input: {
  error: unknown;
  /** How long the failed request ran; absent means it was not measured. */
  requestElapsedMs: number | undefined;
  /** Retries this step index already took. */
  stepAttempts: number;
}): MidReplyTimeoutPlan | null {
  if (
    input.requestElapsedMs === undefined ||
    input.requestElapsedMs < MID_REPLY_TIMEOUT_MIN_ELAPSED_MS
  ) {
    return null;
  }
  const timeout = readMidReplyTimeout(input.error);
  if (timeout === null) return null;
  if (input.stepAttempts < MID_REPLY_TIMEOUT_STEP_BUDGET) {
    return { kind: "retry", attempts: input.stepAttempts + 1 };
  }
  return {
    kind: "give_up",
    error: new TransportError(
      `"${timeout.provider}" stopped this step's reply on a time limit ${input.stepAttempts + 1} times, so the step was ended. ` +
        "Try a faster model, or ask for the work in smaller steps.",
      timeout.status,
      timeout.url,
      { cause: input.error },
    ),
  };
}

/** Fold the notice into the step's one-shot notice, once per retried step. */
export function composeMidReplyTimeoutNotice(existing: string | undefined): string {
  if (existing === undefined || existing.length === 0) return NOTICE;
  return existing.includes(NOTICE) ? existing : `${existing}\n\n${NOTICE}`;
}
