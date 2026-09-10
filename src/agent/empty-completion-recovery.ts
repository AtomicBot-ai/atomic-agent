/**
 * Recovery from a native-tools completion that came back wholly empty.
 *
 * On `native_tools` the step executor lets a completion through when
 * ANY channel carries something: `tool_calls` the parser can read, or
 * `reasoning_content` the parser gets a crack at (and, failing that,
 * the one-shot repair). A completion with nothing in any channel has
 * nothing to parse and nothing to repair, so it throws `ModelError`
 * with `reason: "empty"` and `stage: "initial"` and the turn ends —
 * the surfaces print `Turn failed [model]: …` and the operator has to
 * notice the silence and type "try again".
 *
 * That silence is the whole defect. It is the same UX failure the
 * unparseable-tool-call and length-truncated paths each already fixed,
 * and this module gives the third shape the same treatment: spend one
 * ordinary step on a fresh prompt carrying a `### notice` that says the
 * previous reply was empty and nothing ran.
 *
 * Why the retry is a different request, not a replay: the empty
 * completion consumed no budget and left no transcript row, so the only
 * thing that changes between the two inferences is the notice — which
 * is exactly the point. A wholly empty native-tools completion is
 * overwhelmingly a stop-token or chat-template misfire (the model
 * closed the turn before emitting anything), not a considered decision
 * about the prompt; naming it in the prompt is the one lever we have,
 * and there is no cap to raise the way `truncation-recovery` raises
 * one. If the second attempt is empty too the fault is in the link, not
 * in the wording, and the turn is owed the failure.
 */

import { ModelError } from "../llm/index.js";

/**
 * Recoveries allowed per turn.
 *
 * One, not the two `PARSE_RECOVERY_BUDGET` allows. An unparseable body
 * is a model that tried and slipped on serialization, and a second
 * nudge often lands; a body with nothing in any channel is a model that
 * emitted no tokens at all, which is a binary condition — the next
 * inference either produces something or the link is misconfigured.
 * Two nothings in a row is enough evidence, and a third empty
 * inference only delays the message the operator has to read anyway.
 *
 * Per turn rather than per step index, because the recovery step moves
 * forward instead of replaying the index: a turn whose link has stopped
 * answering would otherwise buy a fresh empty retry at every one of its
 * steps and burn the whole leg discovering the same thing.
 */
export const EMPTY_COMPLETION_RECOVERY_BUDGET = 1;

/**
 * Is this the wholly-empty native-tools completion described above?
 *
 * All three facts are load-bearing:
 *
 *  - `native_tools` — on a grammar link an empty body already routes
 *    into the in-step repair (`isGrammarEmptyCompletionWorthRepairing`),
 *    so a turn-level retry would stack a second recovery on top of one
 *    that already ran.
 *  - `stage: "initial"` — the same `reason`/`transport` pair is raised
 *    again after the one-shot repair, and that one HAS had its extra
 *    attempt: it is the reasoning-only completion the parser handles.
 *  - `reason: "empty"` — `truncated` and `no_stop` are excluded here for
 *    the same reason the repair path excludes them: the model spent its
 *    budget on this prefix and a second pass hits the same wall.
 */
export function isRecoverableEmptyCompletion(err: unknown): err is ModelError {
  return (
    err instanceof ModelError &&
    err.reason === "empty" &&
    err.transport === "native_tools" &&
    err.stage === "initial"
  );
}

/**
 * The `### notice` block for the step that follows an empty completion.
 *
 * Says what came back, that nothing ran, and what to do — the model has
 * no other way to learn any of it, because an empty completion leaves
 * no transcript row behind.
 */
export function formatEmptyCompletionNotice(): string {
  return [
    "Your previous reply to this step was completely empty — no text, no reasoning, no tool call.",
    "Nothing has happened yet: no file was written, no command ran, and the transcript above is unchanged.",
    "Answer this step now. Either call a tool or write your reply as text; do not end your turn without emitting one of them.",
  ].join("\n");
}

/**
 * Fold the notice into whatever one-shot notice the step already owed
 * the model (loop detector, steering, a trimmed batch). The empty reply
 * comes first: it explains why the step is being asked again at all,
 * which is context for the instruction that follows.
 */
export function composeEmptyCompletionNotice(
  existing: string | undefined,
): string {
  const block = formatEmptyCompletionNotice();
  if (existing === undefined || existing.length === 0) return block;
  return `${block}\n\n${existing}`;
}

/**
 * The failure the turn ends with when the retry came back empty too.
 *
 * `detectModelFailure`'s own message describes one empty completion, and
 * an operator reading it after a silent retry would reasonably conclude
 * the runtime never tried. Say the count instead, and keep every
 * diagnostic tag (`transport`, `stage`) so the Sentry cluster this fixes
 * stays distinguishable from a first-and-only empty.
 */
export function repeatedEmptyCompletionError(err: ModelError): ModelError {
  return new ModelError(
    err.reason,
    `the model returned an empty completion twice in a row (no text, no reasoning, no tool call); last attempt: ${err.message}`,
    {
      cause: err,
      ...(err.transport !== undefined ? { transport: err.transport } : {}),
      ...(err.stage !== undefined ? { stage: err.stage } : {}),
    },
  );
}
