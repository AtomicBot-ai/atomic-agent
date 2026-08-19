import type { Key } from "ink";
import type { ReactElement, ReactNode } from "react";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";
import { returnKey } from "./synthetic-key.js";
import {
  MouseTarget,
  useMouseCommands,
  type MouseContextValue,
} from "./mouse-context.js";
import { isPrimaryPress } from "./mouse-event.js";
import { MOUSE_LAYER_PANEL } from "./mouse-registry.js";

export interface MouseListRowProps {
  /** Whether this row currently holds the panel's cursor. */
  readonly selected: boolean;
  /** Move the cursor here. Called on a click on an unselected row. */
  readonly onSelect: (mouse: MouseContextValue) => void;
  /**
   * Open / run the row. Called on a click on the row that is already
   * selected. Omit for lists where selection is the whole interaction.
   */
  readonly onActivate?: (mouse: MouseContextValue) => void;
  readonly layer?: number;
  readonly children: ReactNode;
}

/**
 * Click behaviour for every cursor-driven list in the TUI: **the first
 * click selects, a second click on the selected row activates.**
 *
 * The two-step is deliberate. A double-click needs a timing window that
 * is unreliable over SSH and invisible to the user, and select-and-open
 * on a single click makes a mis-click destructive in lists where Enter
 * starts a download or opens a session. Two plain clicks mirror what
 * the keyboard already does — arrow to the row, then Enter — and reuse
 * each panel's own activation path rather than duplicating it.
 *
 * Without the mouse context (component tests, `--no-mouse`) this is a
 * transparent pass-through and the row renders exactly as before.
 */
export function MouseListRow({
  selected,
  onSelect,
  onActivate,
  layer = MOUSE_LAYER_PANEL,
  children,
}: MouseListRowProps): ReactElement {
  const mouse = useMouseCommands();
  if (!mouse) return <>{children}</>;
  return (
    <MouseTarget
      layer={layer}
      onMouse={(hit) => {
        if (!isPrimaryPress(hit.event)) return false;
        if (selected) {
          onActivate?.(mouse);
          return true;
        }
        onSelect(mouse);
        return true;
      }}
    >
      {children}
    </MouseTarget>
  );
}

/**
 * Adapter that turns "the operator clicked the selected row" into the
 * Enter keypress the owning panel already knows how to handle. Reusing
 * `*-key-bindings.ts` means the mouse cannot drift from the keyboard:
 * whatever Enter opens, downloads or confirms today, a second click
 * does too.
 */
export function pressEnter(
  handler: (
    input: string,
    key: Key,
    ctx: {
      state: TuiState;
      dispatch: (action: TuiAction) => void;
      callbacks: TuiAppCallbacks;
    },
  ) => boolean | null,
): (mouse: MouseContextValue) => void {
  return (mouse) => {
    handler("", returnKey(), {
      state: mouse.getState(),
      dispatch: mouse.dispatch,
      callbacks: mouse.callbacks,
    });
  };
}
