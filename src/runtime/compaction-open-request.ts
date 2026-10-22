import { isFinalReplyTurn, type ConversationTurn } from "../session/conversation-turn.js";

/**
 * The newest user request in `[from, through)` whose answer is not in that
 * range while the transcript continues after it: a checkpoint cut inside a
 * turn (a long tool turn, or right after the request). Its work and answer
 * continue in the records kept after the checkpoint, so a summary must not
 * list it as unfinished or not started. Null when the newest covered request
 * was answered inside the range, or nothing follows the range.
 */
export function requestContinuingAfterCut(turns: readonly ConversationTurn[], from: number, through: number): number | null {
  if (through >= turns.length) return null;
  for (let index = Math.min(through, turns.length) - 1; index >= from; index--) {
    const turn = turns[index];
    if (isFinalReplyTurn(turn)) return null;
    if (turn?.kind === "user") return index;
  }
  return null;
}

/**
 * Whether the turn running at `through` ends later in the transcript (a final
 * reply or a stop marker before the next new user message). False while that
 * turn is still running, as in a compaction made under pressure mid-turn:
 * then the request really is unfinished and what remains must stay in the summary.
 */
export function turnEndsAfterCut(turns: readonly ConversationTurn[], through: number): boolean {
  for (let index = through; index < turns.length; index++) {
    const turn = turns[index];
    if (isFinalReplyTurn(turn)) return true;
    if (turn?.kind === "user" && turn.steered !== true) return false;
  }
  return false;
}

/** What a summary is told about {@link requestContinuingAfterCut}; null when there is no such request. */
export function requestContinuingNote(turns: readonly ConversationTurn[], from: number, through: number): string | null {
  const index = requestContinuingAfterCut(turns, from, through);
  if (index === null) return null;
  if (!turnEndsAfterCut(turns, through)) {
    return `Record ${index} is the user request still in progress after the covered records: its work continues in the records kept after them. Do not describe it as not started; record what was done for it within these records and what still remained to do.`;
  }
  return `Record ${index} is a user request that is still being handled after the covered records: its further steps and its answer come later in the conversation. Do not list it as unfinished, not started or a next action; record only what was done for it within these records.`;
}
