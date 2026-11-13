import type { SessionState } from "./session-state.js";
import { LIVE_SESSION_STATUSES } from "./session-retention.js";
import { truncateSessionAt } from "./session-truncate.js";

/**
 * `/rewind` (ATO-1057): take a chat back to just before one of its
 * earlier questions.
 *
 * The cut itself is {@link truncateSessionAt}; this module decides which
 * rows are points a person can go back to, and refuses the cuts that
 * would leave the session lying about what it remembers. Unlike
 * `planLastTurnRollback` it does not refuse turns that ran tools: the
 * person picked an earlier point on purpose, and the caller says that
 * files the agent changed stay as they are (there are no file
 * checkpoints in the terminal yet).
 */

/** One question the chat can be taken back to. */
export interface RewindPoint {
  /** Index of the prompt row in `turns`; the rewind keeps `turns[0, turnIndex)`. */
  readonly turnIndex: number;
  /** What the person typed, put back in the composer. */
  readonly text: string;
  /** When it was sent (epoch ms). */
  readonly at: number;
  /** 1-based position among the chat's questions, oldest first. */
  readonly ordinal: number;
}

/** Why a rewind was refused. */
export type RewindRefusal =
  /** No question to go back to. */
  | "nothing_to_rewind"
  /** A turn is running on the chat. */
  | "turn_in_progress"
  /**
   * The point is inside the part a compaction checkpoint already
   * summarises: the summary would still speak for the rows removed.
   */
  | "point_compacted"
  /** The row at that index is not the question the caller picked. */
  | "point_mismatch";

export type RewindPlan =
  | { ok: true; text: string; state: SessionState }
  | { ok: false; code: RewindRefusal };

/**
 * The questions the chat can be taken back to, newest first. Steered
 * messages are left out (they joined a turn another question opened),
 * and so are questions a compaction checkpoint already covers.
 */
export function listRewindPoints(state: SessionState): RewindPoint[] {
  const covered = state.compaction?.coveredThrough ?? 0;
  const points: RewindPoint[] = [];
  let ordinal = 0;
  state.turns.forEach((turn, index) => {
    if (turn.kind !== "user" || turn.steered === true) return;
    ordinal += 1;
    if (index < covered) return;
    points.push({ turnIndex: index, text: turn.text, at: turn.at, ordinal });
  });
  return points.reverse();
}

/**
 * The session with the question at `turnIndex` and everything after it
 * removed. `expectText` is the question the caller showed: a different
 * row at that index (the session moved on since the list was built) is
 * refused, never cut.
 */
export function planRewind(
  state: SessionState,
  turnIndex: number,
  expectText?: string,
): RewindPlan {
  if (LIVE_SESSION_STATUSES.includes(state.status)) {
    return { ok: false, code: "turn_in_progress" };
  }
  const row = state.turns[turnIndex];
  if (row === undefined) {
    return {
      ok: false,
      code: state.turns.some((turn) => turn.kind === "user")
        ? "point_mismatch"
        : "nothing_to_rewind",
    };
  }
  if (row.kind !== "user" || row.steered === true) {
    return { ok: false, code: "point_mismatch" };
  }
  if (expectText !== undefined && expectText !== row.text) {
    return { ok: false, code: "point_mismatch" };
  }
  const { state: next, compactionCovered } = truncateSessionAt(state, turnIndex);
  if (compactionCovered) return { ok: false, code: "point_compacted" };
  return { ok: true, text: row.text, state: next };
}

/** The one-line preview a picker row shows for `text`. */
export function rewindPreview(text: string, max = 60): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, Math.max(1, max - 1))}…`;
}
