/**
 * Reducer actions for the rail's row-drag feedback. The mouse layer
 * emits them while a session row is being dragged; the reducer folds
 * them into `state.sidebarDrag` so `SessionRow` can paint the dragged
 * row and the slot it is over. The actual reorder is NOT an action —
 * it goes through `onSessionMoveRequested` to the orchestrator, which
 * persists the order and re-emits the list.
 */
export type SessionRailAction =
  /** The pointer left the row it pressed on: the drag is now real. */
  | { type: "sidebar_drag_started"; sessionId: string; row: number }
  /** The pointer is over another row (absolute index into the list). */
  | { type: "sidebar_drag_moved"; row: number }
  /** Button up, or the gesture was abandoned. */
  | { type: "sidebar_drag_ended" };

/**
 * A row drag in flight. `from` is where the row sat when the drag began,
 * `over` the slot under the pointer right now — both absolute indices
 * into `recentSessions`, not into the rendered window.
 */
export interface SidebarDragState {
  sessionId: string;
  from: number;
  over: number;
}
