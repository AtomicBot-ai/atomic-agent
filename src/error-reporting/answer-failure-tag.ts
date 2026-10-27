/**
 * The `answer_failure` and `truncation_cause` tags of an error report
 * (ATO-1031).
 *
 * "The person got no answer" arrives as one `ModelError` with two very
 * different stories behind it, and they get different fixes: a reply
 * cut at its length limit (continued once, cap lifted for thinking
 * models) and a reply that came back empty (nudged once). `reason`
 * alone says `truncated` for both a spent reply cap and a full context
 * window, which is a third story with its own recovery. These tags make
 * the split a filter:
 *
 *  - `answer_failure`: `cut_at_limit` (a reply cap or the provider's
 *    output limit), `context_full` (the server's context window),
 *    `empty_answer`, `no_stop`;
 *  - `truncation_cause`: the wall itself, verbatim from
 *    `TruncationDetail.cause`.
 *
 * Both are read off the error and its causes, restricted to fixed
 * enums — never the message, never the model's text.
 */

export type AnswerFailure =
  | "cut_at_limit"
  | "context_full"
  | "empty_answer"
  | "no_stop";

/** Mirror of `TruncationCause` in `src/llm/reliability/failure-category.ts`. */
const KNOWN_TRUNCATION_CAUSES: ReadonlySet<string> = new Set([
  "reply_cap",
  "context_window",
  "output_limit",
  "provider_limit",
  "unknown",
]);

/** Depth cap on the `cause` walk — longer is a cycle. */
const MAX_CAUSE_DEPTH = 5;

export interface AnswerFailureTags {
  answerFailure?: AnswerFailure;
  truncationCause?: string;
}

/**
 * The tags for an error, or `{}` when no `ModelError` is on its chain.
 * The outermost model failure wins: the turn-level wrapper of a second
 * empty completion keeps `reason` and points at the first as its cause.
 */
export function extractAnswerFailureTags(err: unknown): AnswerFailureTags {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) return {};
    const isModelError = (current as { name?: unknown }).name === "ModelError";
    const reason = isModelError
      ? (current as { reason?: unknown }).reason
      : undefined;
    if (reason === "empty") return { answerFailure: "empty_answer" };
    if (reason === "no_stop") return { answerFailure: "no_stop" };
    if (reason === "truncated") {
      const cause = (current as { truncation?: { cause?: unknown } })
        .truncation?.cause;
      const known =
        typeof cause === "string" && KNOWN_TRUNCATION_CAUSES.has(cause)
          ? cause
          : undefined;
      return {
        answerFailure:
          known === "context_window" ? "context_full" : "cut_at_limit",
        ...(known !== undefined ? { truncationCause: known } : {}),
      };
    }
    const next = (current as { cause?: unknown }).cause;
    if (next === current) return {};
    current = next;
  }
  return {};
}
