import type { VimState } from "./vim-types.js";
import { hasPending } from "./vim-types.js";

/**
 * Tells the app's key layer whether vim spends an Esc (ATO-662), so the
 * global Esc meanings (arm the abort, cancel context maintenance, answer
 * an approval with "abort") stand down for the Esc that only leaves
 * INSERT or drops a half-typed command.
 *
 * Ink hands a keypress to every `useInput` subscription and the order
 * between the editor's and the app's is not something to rely on, so
 * the claim answers both ways: `consumedEsc` covers "the editor already
 * ran on this key" (vim's state has moved on by then), the mode and
 * `pending` cover "the editor has not seen it yet". An Esc vim lets
 * through is only ever one in NORMAL with nothing pending, which leaves
 * both readings false.
 */
export interface VimEscClaim {
  /** The editor is live (focused, enabled) and vim is on. */
  active: boolean;
  insert: boolean;
  pending: boolean;
  /** Vim spent the Esc being dispatched right now. Reset after the tick. */
  consumedEsc: boolean;
}

export function createVimEscClaim(): VimEscClaim {
  return { active: false, insert: false, pending: false, consumedEsc: false };
}

/** Would vim spend (or did it just spend) the Esc being dispatched? */
export function vimClaimsEsc(claim: VimEscClaim | undefined): boolean {
  if (!claim?.active) return false;
  return claim.consumedEsc || claim.insert || claim.pending;
}

/** Record the outcome of one key in the claim. */
export function noteVimKey(
  claim: VimEscClaim,
  before: VimState,
  after: VimState,
  escape: boolean,
): void {
  claim.insert = after.mode === "insert";
  claim.pending = hasPending(after);
  if (!escape) {
    claim.consumedEsc = false;
    return;
  }
  // The same rule `routeVimKey` applies: Esc is vim's in INSERT and
  // while a command is half typed, and nowhere else.
  claim.consumedEsc = before.mode === "insert" || hasPending(before);
  if (claim.consumedEsc) {
    queueMicrotask(() => {
      claim.consumedEsc = false;
    });
  }
}
