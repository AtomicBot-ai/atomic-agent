import type { ConversationTurn } from "./conversation-turn.js";

/**
 * Boundaries a pairs-capped prompt can only ever need the tail of, so the
 * list is bounded. 200 is well past `agent.conversationMaxPairs`'s
 * ceiling of 100 and keeps a session that runs for days from carrying an
 * ever-growing array of integers it will never read.
 */
export const MACRO_TURN_START_CAP = 200;

/**
 * Record that a macro-turn opens at `index`, keeping the list bounded.
 * The runtime calls this from `incrementTurnCount` at every termination.
 */
export function appendMacroTurnStart(
  starts: number[] | undefined,
  index: number,
): number[] {
  const prev = starts ?? [];
  // A termination that recorded no turns (an empty steer, a cancel
  // before the first step) would otherwise push the same index twice and
  // read as a pair with nothing in it.
  if (prev[prev.length - 1] === index) return prev;
  const next = [...prev, index];
  return next.length > MACRO_TURN_START_CAP
    ? next.slice(next.length - MACRO_TURN_START_CAP)
    : next;
}

/**
 * Boundaries for a transcript that was not recorded by this runtime — an
 * import from another agent's store. There every `user` row is a task
 * of its own (other agents have no steer), so a macro-turn opens at
 * each one after the first. Deriving them at load time would guess
 * wrong instead: `macroTurnBoundaries` only opens a task at a user row
 * that follows an `assistant_reply`, and Claude Code emits its reply
 * *before* the tool calls of the same message, so an import's tasks
 * fuse together and the pairs cap sees one task where there were many.
 *
 * Same cap and same dedupe as the live path, so a loaded import looks
 * exactly like a session that ran here.
 */
export function macroTurnStartsFromTurns(
  turns: readonly ConversationTurn[],
): number[] {
  let starts: number[] = [];
  for (let i = 1; i < turns.length; i += 1) {
    if (turns[i]?.kind === "user") starts = appendMacroTurnStart(starts, i);
  }
  return starts;
}
