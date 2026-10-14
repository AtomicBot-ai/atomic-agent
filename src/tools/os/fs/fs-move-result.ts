import { compressToolResult } from "../../../compressor/result-compressor.js";
import type { PlannedMove } from "./fs-move-plan.js";
import { listMoves } from "./fs-move-text.js";

const NAME = "os.fs.move";

/** One move that landed: by rename, or by copy-and-remove across volumes. */
export interface Moved {
  move: PlannedMove;
  method: "rename" | "copy";
  /** Set when a cross-device copy landed but the original could not be removed. */
  sourceKept?: string;
}

function undoArgs(done: readonly Moved[]): { moves: { from: string; to: string }[] } {
  return {
    moves: [...done].reverse().map(({ move }) => ({ from: move.dest, to: move.source })),
  };
}

/** Up to this many moves, the result spells out the exact undo call. */
const UNDO_CALL_MAX_MOVES = 3;

/**
 * The model reads the summary, never `details`, so the undo has to be
 * in the text: the exact call for a few moves, and for more, how to
 * build it from the `source → destination` lines (never from the
 * original call, whose `to` may name a folder rather than the file).
 */
function undoLine(done: readonly Moved[]): string {
  if (done.length === 0) return "";
  const { moves } = undoArgs(done);
  if (moves.length === 1) return `To undo: os.fs.move ${JSON.stringify(moves[0])}`;
  if (moves.length <= UNDO_CALL_MAX_MOVES) {
    return `To undo: os.fs.move ${JSON.stringify({ moves })}`;
  }
  return "To undo: os.fs.move with moves = each `source → destination` line above as { from: destination, to: source } (exact absolute paths, not the original `to`).";
}

export function okResult(done: readonly Moved[], notes: readonly string[]) {
  const copied = done.filter((d) => d.method === "copy").length;
  const kept = done.flatMap((d) => (d.sourceKept === undefined ? [] : [`⚠ ${d.sourceKept}`]));
  const head =
    done.length === 1
      ? `moved \`${done[0]!.move.from}\` to \`${done[0]!.move.dest}\``
      : `moved ${done.length} items`;
  const across = copied > 0 ? ` (${copied} copied across drives)` : "";
  // What matters comes last: a local model's summary keeps the tail
  // (`overflow: "tail"`), and a long list of moved paths must not push
  // the outcome and the undo call out of it.
  const output = [
    ...(done.length > 1 ? listMoves(done.map((d) => d.move)) : []),
    ...notes,
    ...kept,
    `${head}${across}`,
    undoLine(done),
  ].join("\n");
  return compressToolResult(
    {
      tool: NAME,
      status: "ok",
      output,
      details: {
        count: done.length,
        moves: done.map(({ move, method }) => ({ from: move.source, to: move.dest, method })),
        undo: undoArgs(done),
      },
    },
    { overflow: "tail" },
  );
}

export function partialResult(
  done: readonly Moved[],
  failed: PlannedMove,
  total: number,
  reason: string,
  notes: readonly string[],
) {
  const output = [
    ...(done.length > 0 ? ["Already moved:", ...listMoves(done.map((d) => d.move))] : []),
    ...notes,
    `moved ${done.length} of ${total}, then stopped at \`${failed.from}\` → \`${failed.dest}\`: ${reason}`,
    `Not moved: ${total - done.length} item(s), starting with \`${failed.from}\`.`,
    undoLine(done),
  ]
    .filter((line) => line.length > 0)
    .join("\n");
  return compressToolResult(
    {
      tool: NAME,
      status: "error",
      output,
      details: {
        count: done.length,
        total,
        failedAt: { from: failed.source, to: failed.dest, reason },
        moves: done.map(({ move, method }) => ({ from: move.source, to: move.dest, method })),
        undo: undoArgs(done),
      },
    },
    { overflow: "tail" },
  );
}
