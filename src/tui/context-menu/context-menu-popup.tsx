import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { fitToWidth } from "../components/fit-to-width.js";
import {
  MouseTarget,
  useMouseCommands,
  useMouseTarget,
} from "../mouse/mouse-context.js";
import { MOUSE_LAYER_CONTEXT_MENU } from "../mouse/mouse-registry.js";
import { chromeTheme } from "../theme/theme.js";
import { useContextMenuHandle } from "./context-menu-context.js";
import {
  contextMenuItems,
  type ContextMenuItemId,
  type ContextMenuState,
} from "./context-menu-state.js";

/** Border (2) + one gutter column each side around the longest label. */
const MENU_WIDTH = 11;

export interface ContextMenuPopupProps {
  readonly menu: ContextMenuState | null;
  /** Screen cell of the pane the popup is mounted in — subtracted from
   * the click cell because Ink margins offset from the parent box. */
  readonly paneLeft: number;
  readonly paneTop: number;
  /** Rows / columns of that pane, for the clamp. */
  readonly availableRows: number;
  readonly availableColumns: number;
}

/**
 * The right-click cut/copy/paste popup — drawn the way
 * `composer-switch-popup.tsx` is (absolute box, every interior line
 * padded to the exact inner width, chrome palette), but anchored at a
 * COORDINATE rather than an edge: the first popup in the TUI whose
 * position is the click cell itself, clamped so the frame never leaves
 * the pane. One click acts — this menu was opened to pick a verb.
 *
 * It lives on `MOUSE_LAYER_CONTEXT_MENU`, its own registry floor,
 * instead of joining `modalOwnsInput`: the modal predicate collapses
 * the composer viewport to one line, which would shift the very cell
 * the menu is anchored to (and the selection it acts on) out from
 * under it. The composer therefore keeps its size while this is open.
 */
export function ContextMenuPopup({
  menu,
  paneLeft,
  paneTop,
  availableRows,
  availableColumns,
}: ContextMenuPopupProps): ReactElement | null {
  // Hooks, not props: the popup always renders inside `MouseProvider`
  // and `ContextMenuProvider`, and TuiApp — which renders both — could
  // not call these hooks on its own behalf anyway.
  const mouse = useMouseCommands();
  const handle = useContextMenuHandle();
  if (!menu) return null;
  const items = contextMenuItems(menu.target);
  const width = Math.min(MENU_WIDTH, Math.max(6, availableColumns));
  const inner = width - 2;
  const height = items.length + 2;
  // Anchor at the click cell, pane-relative; clamp fully inside the
  // pane so a click near the right or bottom edge slides the frame in
  // rather than letting Ink overlap rows it should not.
  const left = Math.max(
    0,
    Math.min(menu.x - paneLeft, availableColumns - width),
  );
  const top = Math.max(0, Math.min(menu.y - paneTop, availableRows - height));

  const run = (id: ContextMenuItemId): void => {
    // Close first: an action may replace the buffer, and a menu that
    // outlives its target would offer verbs for text that is gone.
    mouse?.dispatch({ type: "context_menu_closed" });
    handle?.actionsRef.current?.[id]?.();
  };

  return (
    <PopupFrame offsetTop={top} offsetLeft={left} width={width}>
      {items.map((id) => (
        <MouseTarget
          key={id}
          layer={MOUSE_LAYER_CONTEXT_MENU}
          onMouse={(hit) => {
            // Any button acts: the menu was opened by the right button,
            // and a right-press on a row plainly means "this one".
            if (hit.event.kind !== "press") return false;
            run(id);
            return true;
          }}
        >
          <Text color={chromeTheme.colors.railForeground}>
            {fitToWidth(` ${id}`, inner)}
          </Text>
        </MouseTarget>
      ))}
    </PopupFrame>
  );
}

/**
 * The frame claims presses that land on its border so they cannot fall
 * through to the layer-3 backdrop, which closes the menu — same rule as
 * every other popup frame.
 */
function PopupFrame({
  offsetTop,
  offsetLeft,
  width,
  children,
}: {
  readonly offsetTop: number;
  readonly offsetLeft: number;
  readonly width: number;
  readonly children: ReactElement[];
}): ReactElement {
  const ref = useMouseTarget((hit) => hit.event.kind === "press", {
    layer: MOUSE_LAYER_CONTEXT_MENU,
  });
  return (
    <Box
      ref={ref}
      position="absolute"
      marginTop={offsetTop}
      marginLeft={offsetLeft}
      width={width}
      borderStyle="round"
      borderColor={chromeTheme.colors.railMuted}
      backgroundColor={chromeTheme.colors.railBackground}
      flexDirection="column"
    >
      {children}
    </Box>
  );
}
