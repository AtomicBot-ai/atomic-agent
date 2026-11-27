/**
 * "The model answered nothing, twice, after the agent asked again"
 * (ATO-1676, Sentry CLI-R8).
 *
 * A native-tools completion with nothing in any channel already gets one
 * re-ask with a notice (`empty-completion-recovery.ts`); when that comes
 * back empty too, the turn ends with `repeatedEmptyCompletionError`: a
 * `ModelError` with `reason: "empty"` whose `cause` is the first empty
 * `ModelError`. The person is told in chat ("The model sent back an
 * empty answer", with Retry, or Try another model on a cloud link). Two
 * empty answers to two different, correctly built requests are the
 * model's or the server's behaviour, not a defect we can fix, and each
 * such turn was one more Sentry event. Same shape as Claude Code and
 * Codex: retry an empty completion once, then tell the person and stop.
 *
 * Only that doubled shape is dropped. A single empty answer (no re-ask
 * happened) and the grammar repair's empty (`stage: "repair"`, no
 * `ModelError` cause) still report: either can still be ours, as the
 * repair was until ATO-1676 (it re-sent the failed request unchanged on
 * the chat-template path).
 *
 * Matched by name and the fixed `reason` word anywhere in the `cause`
 * chain (the loop may hand the report a wrapper), so this module takes
 * no import from the LLM layer.
 */
const MODEL_ERROR_NAME = "ModelError";

/** Depth cap on the `cause` walk: a longer chain is a cycle. */
const MAX_CAUSE_DEPTH = 5;

function isEmptyModelError(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const { name, reason } = value as { name?: unknown; reason?: unknown };
  return name === MODEL_ERROR_NAME && reason === "empty";
}

/** True when `err` or its `cause` chain is an empty answer given again after the re-ask. */
export function isRepeatedEmptyAnswer(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    const next = (current as { cause?: unknown }).cause;
    if (isEmptyModelError(current) && isEmptyModelError(next)) return true;
    if (next === current) return false;
    current = next;
  }
  return false;
}
