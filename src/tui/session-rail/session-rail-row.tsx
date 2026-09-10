import { Box } from "ink";
import { useRef, type ReactElement, type ReactNode } from "react";

import { useMouseCommands, useMouseTarget } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";

export interface SessionRailRowProps {
  sessionId: string;
  /** Absolute index into the session list, not the visible window. */
  row: number;
  selected: boolean;
  /** First and last absolute rows currently painted — a drag cannot leave them. */
  windowStart: number;
  windowEnd: number;
  children: ReactNode;
}

interface Gesture {
  /** Whether the row was already the selected one when the press landed. */
  selectedAtPress: boolean;
  /** The pointer has left the pressed row at least once. */
  moved: boolean;
  /** The slot under the pointer, absolute. */
  over: number;
}

/**
 * A session row that can be clicked and dragged.
 *
 * The click contract of every rail row is "first click selects, the
 * second activates". A drag has to start from the same press, so the
 * gesture is arbitrated on release rather than on press: the press
 * selects (if the row was not selected) and captures the pointer; held
 * motion onto another row turns the press into a drag and paints the
 * feedback; the release either drops the row (`onSessionMoveRequested`)
 * or — if the pointer never left the row AND the row was already
 * selected before the press — activates it. A press on an unselected
 * row therefore still selects it, and an already-selected row still
 * opens on the next click, exactly once.
 *
 * Rows are one line tall, so the row under the pointer is this row's
 * index plus the hit's local Y — the registry keeps routing to the
 * captured target with out-of-range local coordinates while the
 * pointer wanders. The result is clamped to the painted window: rows
 * above or below it are not on screen, and a drop there would land on
 * a slot the operator cannot see.
 */
export function SessionRailRow({
  sessionId,
  row,
  selected,
  windowStart,
  windowEnd,
  children,
}: SessionRailRowProps): ReactElement {
  const mouse = useMouseCommands();
  const gesture = useRef<Gesture | null>(null);
  const ref = useMouseTarget(
    (hit) => {
      if (!mouse) return false;
      if (isPrimaryPress(hit.event)) {
        gesture.current = {
          selectedAtPress: selected,
          moved: false,
          over: row,
        };
        if (!selected) {
          mouse.dispatch({ type: "chat_focus_set", focus: "sidebar" });
          mouse.dispatch({
            type: "sidebar_section_focused",
            section: "sessions",
          });
          mouse.dispatch({ type: "sidebar_cursor_set", row });
        }
        mouse.registry.capturePointer(ref);
        return true;
      }
      const current = gesture.current;
      if (!current) return false;
      if (hit.event.kind === "motion" && hit.event.button === "left") {
        const over = Math.min(
          windowEnd,
          Math.max(windowStart, row + hit.localY),
        );
        if (over === current.over) return true;
        if (!current.moved) {
          current.moved = true;
          mouse.dispatch({ type: "sidebar_drag_started", sessionId, row });
        }
        current.over = over;
        mouse.dispatch({ type: "sidebar_drag_moved", row: over });
        return true;
      }
      if (hit.event.kind === "release") {
        gesture.current = null;
        mouse.registry.releasePointer();
        if (current.moved) {
          mouse.dispatch({ type: "sidebar_drag_ended" });
          mouse.dispatch({ type: "sidebar_cursor_set", row: current.over });
          if (current.over !== row) {
            mouse.callbacks.onSessionMoveRequested?.(sessionId, current.over);
          }
        } else if (current.selectedAtPress) {
          mouse.callbacks.onSessionSwitchRequested?.(sessionId);
        }
        return true;
      }
      return false;
    },
    { enabled: mouse !== null },
  );
  if (!mouse) return <>{children}</>;
  return <Box ref={ref}>{children}</Box>;
}
