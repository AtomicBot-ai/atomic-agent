import { Box } from "ink";
import type { ReactElement, ReactNode } from "react";

import { MouseTarget, useMouseCommands } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { MOUSE_LAYER_PANEL } from "../mouse/mouse-registry.js";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";

/**
 * Click targets for the Import tab.
 *
 * The tab was keyboard-only while every label on it — the four source
 * names, the checkboxes, `Run preview`, the apply/cancel line — reads
 * like something you click. `ImportClick` wraps a row in a target that
 * dispatches exactly what the keyboard dispatches for the same gesture,
 * so the two can never drift: focus moves with `import_focus_set`, a
 * checkbox flips with `import_toggled`, the source switches with
 * `import_source_set`, and running goes through the same
 * `onImportPreview` / `onImportExecute` callbacks the Enter key uses.
 *
 * Targets sit on `MOUSE_LAYER_PANEL`, above the base layer the rail
 * owns and below a modal, and the whole thing degrades to plain
 * rendering when no mouse provider is mounted (component tests,
 * `/mouse off`).
 */
export interface ImportClickProps {
  /** What the click means, in the actions the keyboard already emits. */
  onClick: (ctx: ImportClickContext) => void;
  children: ReactNode;
}

export interface ImportClickContext {
  dispatch: (action: TuiAction) => void;
  callbacks: TuiAppCallbacks;
}

export function ImportClick({ onClick, children }: ImportClickProps): ReactElement {
  const mouse = useMouseCommands();
  if (!mouse) return <>{children}</>;
  return (
    <MouseTarget
      layer={MOUSE_LAYER_PANEL}
      flexShrink={0}
      onMouse={(hit) => {
        if (!isPrimaryPress(hit.event)) return false;
        onClick({ dispatch: mouse.dispatch, callbacks: mouse.callbacks });
        return true;
      }}
    >
      {children}
    </MouseTarget>
  );
}

/**
 * A whole form row: the click focuses it, and `also` carries whatever
 * the row does besides taking focus (flip the checkbox, run the
 * import). Focusing first means a click leaves the keyboard exactly
 * where the operator can see it, which is what makes the two input
 * methods agree about "where am I".
 */
export function importRowClick(
  focus: Parameters<typeof focusAction>[0],
  also?: (ctx: ImportClickContext) => void,
): (ctx: ImportClickContext) => void {
  return (ctx) => {
    ctx.dispatch(focusAction(focus));
    also?.(ctx);
  };
}

function focusAction(focus: Extract<TuiAction, { type: "import_focus_set" }>["focus"]): TuiAction {
  return { type: "import_focus_set", focus };
}

/** Row wrapper that only moves focus — the text and limit fields. */
export function ImportFocusRow({
  focus,
  children,
}: {
  focus: Parameters<typeof focusAction>[0];
  children: ReactNode;
}): ReactElement {
  return (
    <Box>
      <ImportClick onClick={importRowClick(focus)}>{children}</ImportClick>
    </Box>
  );
}
