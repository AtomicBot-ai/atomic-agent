/**
 * `/queue next <n>` and `/queue move <n> <place>` (ATO-2476): change the
 * order of the parked messages. Numbers are the ones `/queue` lists,
 * counted from 1. Pure: the parse here, the move in `ChatOrchestrator`.
 *
 *   /queue next 3       message 3 runs right after the current turn
 *   /queue move 3 1     the same thing, spelled as a move
 *   /queue move 1 3     message 1 goes to place 3
 *
 * Only these exact shapes are verbs: `/queue next steps for the doc` is
 * still a message to park, as any other `/queue <msg>` is.
 */

/** A move in 0-based queue indexes. */
export interface QueueMove {
  readonly from: number;
  readonly to: number;
}

const NEXT = /^next\s+(\d{1,3})$/i;
const MOVE = /^move\s+(\d{1,3})\s+(?:to\s+)?(\d{1,3})$/i;

export function parseQueueMoveCommand(args: string): QueueMove | null {
  const raw = args.trim();
  const next = NEXT.exec(raw);
  if (next) return { from: Number(next[1]) - 1, to: 0 };
  const move = MOVE.exec(raw);
  if (move) return { from: Number(move[1]) - 1, to: Number(move[2]) - 1 };
  return null;
}

/**
 * Runs `move` against the queue as the TUI shows it and says what
 * happened, in one line for the transcript. `apply` is the
 * orchestrator's move; it answers false when its own queue disagrees.
 */
export function queueMoveLine(
  move: QueueMove,
  queued: readonly string[],
  apply: ((from: number, to: number) => boolean) | undefined,
): string {
  const n = queued.length;
  if (n === 0) return "queue: nothing is parked, so there is nothing to move";
  const range = `pick a number from 1 to ${n} (see /queue)`;
  if (move.from < 0 || move.from >= n) return `queue: there is no message ${move.from + 1}; ${range}`;
  if (move.to < 0 || move.to >= n) return `queue: there is no place ${move.to + 1}; ${range}`;
  if (move.from === move.to) {
    return move.to === 0
      ? `queue: message ${move.from + 1} already goes next`
      : `queue: message ${move.from + 1} is already at place ${move.to + 1}`;
  }
  if (!apply || !apply(move.from, move.to)) {
    return "queue: the queue changed meanwhile and nothing was moved; run /queue to see it";
  }
  return move.to === 0
    ? `queue: message ${move.from + 1} goes next`
    : `queue: message ${move.from + 1} moved to place ${move.to + 1}`;
}
