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
 * Recoveries allowed per RUN of consecutive empty completions.
 *
 * One, not the two `PARSE_RECOVERY_BUDGET` allows. An unparseable body
 * is a model that tried and slipped on serialization, and a second
 * nudge often lands; a body with nothing in any channel is a model that
 * emitted no tokens at all, which is a binary condition — the next
 * inference either produces something or the link is misconfigured.
 * Two nothings in a row is enough evidence, and a third empty
 * inference only delays the message the operator has to read anyway.
 *
 * "In a row" is the whole of the scoping, and the agent loop enforces
 * it: any completion that carried something — a step that ran, a body
 * that failed to parse, a reply the server cut short — resets the
 * count. Two consequences, both wanted:
 *
 *  - A link that has stopped answering still buys exactly ONE retry
 *    for the whole turn, because nothing ever resets the count: the
 *    turn does not get to burn a leg rediscovering the same silence,
 *    which is what a per-step budget would have cost.
 *  - A model that answered a step and then went quiet gets the same
 *    one nudge the first empty got. It has just proved the link works,
 *    so its silence is a fresh event, not the second half of an old
 *    one — and a per-turn budget would have denied it a retry on the
 *    strength of an empty completion twenty steps and a dozen working
 *    tool calls ago.
 *
 * It is also what makes {@link repeatedEmptyCompletionError}'s message
 * true: the turn only ever says "twice in a row" about two empties
 * with no completion of any kind between them.
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
 * the runtime never tried. Say the count instead — and only ever about
 * two empties with nothing between them, which is what the consecutive
 * budget above guarantees.
 *
 * Know before reading any Sentry volume off either side: wrapping puts
 * the doubled empty in its OWN issue. `buildEnvelope`'s fingerprint
 * discriminator is `causeType ?? tool ?? reason ?? transportHost`, and
 * the scrubber sets `causeType` whenever `err.cause instanceof Error` —
 * so the step executor's first-empty throw, which carries no cause,
 * discriminates on `reason` (`"empty"`), while the `{ cause: err }`
 * below discriminates on `causeType` (`"ModelError"`). The shared stack
 * does not pull them back together: `pickFrames` does prefer the cause's
 * frames, so both events point at the same step-executor throw, but
 * `topFrame` is the LAST fingerprint element and cannot merge two events
 * that already differ in the fourth. Pinned by
 * `empty-completion-recovery.test.ts`.
 *
 * What the split separates is narrower than it looks, and narrower than
 * the volume argument it replaces assumed. Three limits, in the order
 * they bite:
 *
 *  - **A turn this recovery SAVED is in no Sentry issue at all.** The
 *    loop clears `runError` and `continue`s, so the save emits no
 *    `loop_failed` — and `loop_failed` is the only agent event
 *    `bootstrap.ts` hands to `captureError`. Sentry sees losses and
 *    nothing else, whichever way the two are grouped, so no arrangement
 *    of these fingerprints can compare saves against losses.
 *  - **What the split does separate** is a turn that SPENT its retry and
 *    still lost (`cause_type=ModelError`) from one that never got a
 *    retry (`reason=empty`, no `cause_type`).
 *  - **The no-`cause_type` side is not one population.** `transport` and
 *    `stage` are Sentry *tags*, not fingerprint elements, so every
 *    `reason=empty` `ModelError` out of the step executor shares that
 *    one fingerprint: the `native_tools`/`initial` shape this recovery
 *    is eligible for, the grammar-link empty that has its own in-step
 *    repair, and the post-repair empty. Filter on `tool_transport` and
 *    `failure_stage` before that count means anything about this
 *    recovery.
 *
 * So: never quote either count as total empty volume, and never read
 * either as a save rate. The per-turn discriminator is in the trace, not
 * in Sentry — a turn that spent its retry carries an
 * `empty_completion_recovered` event and one that failed on the first
 * empty does not.
 *
 * The tags (`reason`, `transport`, `stage`) are kept regardless, because
 * they are all Sentry ever learns about the completion itself: the
 * scrubber never transmits a message (`STATIC_MESSAGE_ERRORS` is empty by
 * design), so the rewritten sentence above only ever reaches the
 * operator's terminal.
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
