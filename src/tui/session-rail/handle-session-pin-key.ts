import type { Key } from "ink";

import type { TuiAction } from "../tui-action.js";
import type { TuiState } from "../tui-state.js";
import { pinnedBlockLength } from "./session-rail-pin.js";

export interface SessionPinKeyContext {
  state: TuiState;
  dispatch: (action: TuiAction) => void;
  callbacks: {
    onSessionPinToggled?: (sessionId: string) => void;
  };
}

/**
 * `p` with the rail's Sessions pane focused: pin the selected thread to
 * the top block, or release it.
 *
 * The keyboard twin of the row's `↑`. The mark is painted whether or
 * not mouse reporting is on, so leaving the toggle to the pointer would
 * strand `/mouse off`, terminals without reporting, and keyboard-first
 * operators in front of a control they can see and cannot reach — the
 * same reason `x` exists beside the close mark.
 *
 * The cursor follows the row, as it does for a move: pinning lifts the
 * thread to the end of the top block and unpinning drops it at the head
 * of the rest, and a cursor left on the old slot would put the next `p`
 * on a different thread — pressing it twice would pin two rows instead
 * of undoing the first.
 *
 * Returns `true` when the key was consumed. A `p` on the Tasks pane is
 * not consumed here; the caller's own letter-swallow deals with it.
 */
export function handleSessionPinKey(
  input: string,
  key: Key,
  ctx: SessionPinKeyContext,
): boolean {
  if (key.ctrl || key.meta) return false;
  if (input.toLowerCase() !== "p") return false;
  const { state } = ctx;
  if (state.sidebarSection !== "sessions") return false;
  const entry = state.recentSessions[state.sidebarCursor];
  if (!entry) return true;
  ctx.callbacks.onSessionPinToggled?.(entry.sessionId);
  // Where the row lands: the block grows by one and takes it last when
  // pinning, and the row leaves the block and heads the rest when it is
  // released — the two slots `togglePinned` moves it to.
  const block = pinnedBlockLength(
    state.recentSessions.map((row) => row.sessionId),
    state.recentSessions
      .filter((row) => row.pinned)
      .map((row) => row.sessionId),
  );
  ctx.dispatch({
    type: "sidebar_cursor_set",
    row: entry.pinned ? Math.max(0, block - 1) : block,
  });
  return true;
}
