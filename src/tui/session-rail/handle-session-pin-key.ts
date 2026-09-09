import type { Key } from "ink";

import type { TuiState } from "../tui-state.js";

export interface SessionPinKeyContext {
  state: TuiState;
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
  if (entry) ctx.callbacks.onSessionPinToggled?.(entry.sessionId);
  return true;
}
