/**
 * The TUI's words for a chat turn a restart cut off (ATO-448). The
 * offer is shown, never acted on: only the person's `/resume` continues
 * the turn (`AgentRuntime.interruptedTurns`).
 */

/** The one-line offer shown when a session with such a turn is opened. */
export const INTERRUPTED_TURN_NOTICE =
  "The last reply was interrupted by a restart. /resume to continue it.";

/** What `/resume` says when there is nothing to continue. */
export const NOTHING_TO_RESUME =
  "nothing to resume: the last reply in this session was not cut off by a restart";
