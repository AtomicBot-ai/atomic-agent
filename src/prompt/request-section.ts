import type { ConversationTurn } from "../session/conversation-turn.js";

/**
 * The operator's request stays in view across repairs.
 *
 * The packer keeps the last user turn and the current task's opening
 * turn; an earlier task's request can be dropped. During a repair that
 * is exactly the turn that carried the spec — "four older turns were
 * dropped, including the user message" — and the model then repaired
 * against a summary line. The runtime already records the request per
 * turn for the workers' briefs (`pickOriginalRequest`); this renders
 * the same record as `### request`, immediately before
 * `### conversation`, only when the packer has dropped the user turn
 * that carried it. While the carrier is in view it costs nothing.
 */

/** Same 16,000-char clip as the workers' quoted request. */
export const REQUEST_SECTION_CHAR_BUDGET = 16_000;

/**
 * The line `pickOriginalRequest` puts between the previous user message
 * and a short follow-up that started the turn. Split on it to find the
 * turn that actually carried the request.
 */
export const REQUEST_FOLLOW_UP_MARKER =
  "[the operator's latest message, which started this turn]";

/**
 * The user-turn text the request was taken from: the message before a
 * short follow-up when the record combines two, else the record itself.
 */
export function requestCarrierText(request: string): string {
  const marker = `\n\n${REQUEST_FOLLOW_UP_MARKER}\n`;
  const at = request.indexOf(marker);
  return (at === -1 ? request : request.slice(0, at)).trim();
}

/** Whether the turn that carried `request` is among `visibleTurns`. */
export function requestInView(
  request: string,
  visibleTurns: readonly ConversationTurn[],
): boolean {
  const carrier = requestCarrierText(request);
  if (carrier.length === 0) return true;
  return visibleTurns.some(
    (turn) => turn.kind === "user" && turn.text.trim() === carrier,
  );
}

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** The `### request` body: the record, clipped, with a one-line frame. */
export function renderRequestSection(request: string): string {
  const text = request.trim();
  const clipped =
    text.length > REQUEST_SECTION_CHAR_BUDGET
      ? text.slice(0, REQUEST_SECTION_CHAR_BUDGET)
      : text;
  const lines = [
    "The operator's request that started this task. The turn that carried it has been dropped from the conversation below; this is what the work must still satisfy.",
    clipped,
  ];
  if (clipped.length < text.length) {
    lines.push(
      `(truncated: the request is ${formatCount(text.length)} chars; only the first ${formatCount(REQUEST_SECTION_CHAR_BUDGET)} are shown.)`,
    );
  }
  return lines.join("\n");
}
