import type { Key } from "ink";

import type { TuiAction } from "../tui-action.js";
import type { TuiState } from "../tui-state.js";

export interface SessionMoveKeyContext {
  state: TuiState;
  dispatch: (action: TuiAction) => void;
  callbacks: {
    onSessionMoveRequested?: (sessionId: string, toIndex: number) => void;
  };
}

/**
 * Shift+↑ / Shift+↓ with the rail's Sessions pane focused: move the
 * selected row one slot and keep the cursor on it. Meta+↑/↓ is accepted
 * as an alias for terminals that hand Shift+arrow to their own scroll
 * or selection.
 *
 * Returns `true` when the chord was consumed, `false` when it was not
 * a move chord at all — a plain arrow, or a chord on the Tasks pane —
 * so the caller's own ↑/↓ handling runs instead. A move that would
 * leave the list (Shift+↑ on the top row) is consumed and does nothing:
 * the operator was clearly talking to the rail, and letting the chord
 * fall through to a cursor move would be a surprise. The same goes for
 * a move that would cross the pinned block's edge: a keyboard move
 * never pins or unpins — that is what `p` is for — so the chord stops
 * at the boundary.
 *
 * Ink reports the chord as `upArrow: true, shift: true` — `\x1b[1;2A`
 * carries the xterm modifier 2, which `parse-keypress` maps to `shift`.
 */
export function handleSessionMoveKey(
  key: Key,
  ctx: SessionMoveKeyContext,
): boolean {
  if (!key.upArrow && !key.downArrow) return false;
  if (!key.shift && !key.meta) return false;
  if (key.ctrl) return false;
  const { state } = ctx;
  if (state.sidebarSection !== "sessions") return false;
  const from = state.sidebarCursor;
  const entry = state.recentSessions[from];
  if (!entry) return true;
  const to = from + (key.upArrow ? -1 : 1);
  const target = state.recentSessions[to];
  if (!target || target.pinned !== entry.pinned) return true;
  ctx.callbacks.onSessionMoveRequested?.(entry.sessionId, to);
  // After the callback: the orchestrator's refresh re-emits the list,
  // and the cursor must end on the moved row, not on where it was.
  ctx.dispatch({ type: "sidebar_cursor_set", row: to });
  return true;
}
