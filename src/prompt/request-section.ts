import {
  isStoppedTurnMarker,
  type ConversationTurn,
} from "../session/conversation-turn.js";

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
 * The lines a worker's brief quotes the operator's request between
 * (`worker-prompt.ts`). A worker's own pinned request is its whole brief
 * — the brief is the message that started its turn — so the block
 * between these is where the operator's words are in it.
 */
export const ORIGINAL_REQUEST_BEGIN_MARKER = "----- BEGIN ORIGINAL REQUEST -----";
export const ORIGINAL_REQUEST_END_MARKER = "----- END ORIGINAL REQUEST -----";

/**
 * The operator's words in a pinned request: the quoted block when the
 * text is a worker's brief, the text itself otherwise. What the input
 * guard (`fs-input-guard.ts`) reads, so a file a task's instructions
 * name as an output is not mistaken for one the operator provided.
 */
export function quotedRequestText(request: string): string {
  const begin = request.indexOf(ORIGINAL_REQUEST_BEGIN_MARKER);
  if (begin === -1) return request;
  const start = begin + ORIGINAL_REQUEST_BEGIN_MARKER.length;
  const end = request.indexOf(ORIGINAL_REQUEST_END_MARKER, start);
  return end === -1 ? request.slice(start) : request.slice(start, end);
}

/**
 * What a worker turn records as its request when its brief has no
 * ORIGINAL REQUEST block (a fan-out started with no operator message on
 * record). Without the block the brief is the orchestrator's words
 * only, so nothing in it may stand for the operator agreeing to a
 * replacement (ATO-860): the input guard still reads it for the files
 * it names, never for consent.
 */
export const NO_OPERATOR_WORDS_MARKER =
  "[a worker brief without an ORIGINAL REQUEST block: no operator words]";

/** The record `executeTurn` keeps for a worker turn, from its brief. */
export function workerRequestRecord(brief: string): string {
  return brief.includes(ORIGINAL_REQUEST_BEGIN_MARKER)
    ? brief
    : `${NO_OPERATOR_WORDS_MARKER}\n${brief}`;
}

/**
 * The two readings of a pinned request the input guard needs: `names`,
 * the text whose file names are inputs, and `consent`, the operator's
 * own words that may ask for one to be replaced. The same text, except
 * for a worker brief without a quoted request (`workerRequestRecord`):
 * its names still count, its words do not.
 */
export function requestWords(request: string): {
  names: string;
  consent: string;
} {
  if (request.startsWith(NO_OPERATOR_WORDS_MARKER)) {
    return { names: request.slice(NO_OPERATOR_WORDS_MARKER.length), consent: "" };
  }
  const quoted = quotedRequestText(request);
  return { names: quoted, consent: quoted };
}

/**
 * The agent's last reply before the user's message that starts this
 * turn, when that message answers it: the final `assistant_reply` of the
 * previous macro-turn, read back past its tool rows. Nothing when a user
 * row comes first (two user messages in a row), when the previous turn
 * was stopped, or for an interim progress note. The input guard reads
 * it to see which file the agent asked about replacing (ATO-860).
 */
export function previousReplyText(
  earlierTurns: readonly ConversationTurn[],
): string | undefined {
  for (let i = earlierTurns.length - 1; i >= 0; i -= 1) {
    const turn = earlierTurns[i]!;
    if (turn.kind === "user") return undefined;
    if (turn.kind !== "assistant_reply" || turn.progressNote === true) continue;
    if (isStoppedTurnMarker(turn)) return undefined;
    const text = turn.text.trim();
    return text.length === 0 ? undefined : text;
  }
  return undefined;
}

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
