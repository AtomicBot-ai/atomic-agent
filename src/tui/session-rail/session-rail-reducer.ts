import type { TuiState } from "../tui-state.js";
import type { SessionRailAction } from "./session-rail-actions.js";

const DRAG_ACTIONS = new Set<string>([
  "sidebar_drag_started",
  "sidebar_drag_moved",
  "sidebar_drag_ended",
]);

function isSessionRailAction(action: {
  type: string;
}): action is SessionRailAction {
  return DRAG_ACTIONS.has(action.type);
}

/**
 * Reducer slice for `state.sidebarDrag`. Returns the next state when
 * the action is one of the drag actions, `null` otherwise so the root
 * reducer falls through. The slice never touches the session list or
 * the cursor: while a row is dragged the list stays as it is and only
 * the paint changes, so an abandoned drag leaves nothing to undo.
 */
export function reduceSessionRailAction(
  state: TuiState,
  action: { type: string },
): TuiState | null {
  if (!isSessionRailAction(action)) return null;
  switch (action.type) {
    case "sidebar_drag_started": {
      const max = Math.max(0, state.recentSessions.length - 1);
      const row = Math.min(max, Math.max(0, action.row));
      return {
        ...state,
        sidebarDrag: { sessionId: action.sessionId, from: row, over: row },
      };
    }
    case "sidebar_drag_moved": {
      if (!state.sidebarDrag) return state;
      const max = Math.max(0, state.recentSessions.length - 1);
      const over = Math.min(max, Math.max(0, action.row));
      if (over === state.sidebarDrag.over) return state;
      return { ...state, sidebarDrag: { ...state.sidebarDrag, over } };
    }
    case "sidebar_drag_ended":
      return state.sidebarDrag ? { ...state, sidebarDrag: null } : state;
  }
}
