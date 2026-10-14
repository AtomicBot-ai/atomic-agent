import { basename, dirname } from "node:path";
import type { PlannedMove } from "./fs-move-plan.js";

/** Lines of `from → to` the approval card shows before it says "+N more". */
export const PREVIEW_MAX_MOVES = 12;
/** Lines of `from → to` a result lists; the full list is in `details.moves`. */
export const LIST_MAX_MOVES = 40;

/**
 * The approval card's headline: what happens, in the operator's terms.
 *  - one item renamed in its folder: `rename a.txt to b.txt in /dir`
 *  - one item moved: `move /dir/a.txt to /other/a.txt`
 *  - several, one destination folder: `move 72 items to /dir/Sorted`
 *  - several, many folders: `move 72 items to 5 folders`
 */
export function describeMoves(plan: readonly PlannedMove[]): string {
  if (plan.length === 1) {
    const move = plan[0]!;
    const kind = move.folder ? "folder " : "";
    if (dirname(move.source) === dirname(move.dest)) {
      return `rename ${kind}${basename(move.source)} to ${basename(move.dest)} in ${dirname(move.dest)}${replacing(plan)}`;
    }
    return `move ${kind}${move.source} to ${move.dest}${replacing(plan)}`;
  }
  const folders = new Set(plan.map((m) => dirname(m.dest)));
  const where =
    folders.size === 1 ? [...folders][0]! : `${folders.size} folders`;
  return `move ${plan.length} items to ${where}${replacing(plan)}`;
}

function replacing(plan: readonly PlannedMove[]): string {
  const n = plan.filter((m) => m.replaces).length;
  if (n === 0) return "";
  return n === 1
    ? ", replacing 1 existing file"
    : `, replacing ${n} existing files`;
}

/** `from → to`, one per line; `(replaces existing file)` where it does. */
export function listMoves(
  plan: readonly PlannedMove[],
  max = LIST_MAX_MOVES,
): string[] {
  const lines = plan
    .slice(0, max)
    .map(
      (m) =>
        `${m.source} → ${m.dest}${m.replaces ? " (replaces existing file)" : ""}`,
    );
  if (plan.length > max) lines.push(`… +${plan.length - max} more`);
  return lines;
}

export function previewMoves(plan: readonly PlannedMove[]): string {
  return listMoves(plan, PREVIEW_MAX_MOVES).join("\n");
}
