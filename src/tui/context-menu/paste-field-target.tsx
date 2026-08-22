import type { ReactElement, ReactNode } from "react";
import { useClipboardReader } from "../clipboard/clipboard-context.js";
import {
  MouseTarget,
  useMouseCommands,
  type MouseContextValue,
} from "../mouse/mouse-context.js";
import { isSecondaryPress } from "../mouse/mouse-event.js";
import { MOUSE_LAYER_MODAL } from "../mouse/mouse-registry.js";
import {
  openContextMenu,
  useContextMenuHandle,
} from "./context-menu-context.js";
import { stripFieldPasteControls } from "./context-menu-state.js";

export interface PasteFieldTargetProps {
  /**
   * Feed pasted text into the field. Sites route this through their own
   * key handler as a `(text, plainKey())` burst — the exact path a
   * terminal paste takes — so paste can never become a second
   * implementation of "type into this buffer".
   */
  readonly onPasteText: (text: string, mouse: MouseContextValue) => void;
  /**
   * Defaults to MODAL: most of these fields live in wizards, modals and
   * popups whose open state raises the registry floor there. Fields on
   * plain panel surfaces pass their own layer.
   */
  readonly layer?: number;
  /**
   * Set for fields that belong to a floating overlay themselves (the
   * menu's query, the composer switch's filter) — their right-click
   * must work while that overlay is up, which is exactly when the
   * shared overlay guard would refuse it.
   */
  readonly insideOverlay?: boolean;
  readonly children: ReactNode;
}

/**
 * The paste-only right-click for every hand-rolled typed field. These
 * buffers are append-only — no caret, no selection — so cut/copy do not
 * exist and the menu is a single `paste` row. Without the mouse or
 * context-menu providers (component tests) it is a transparent
 * pass-through, like `MouseListRow`.
 */
export function PasteFieldTarget({
  onPasteText,
  layer = MOUSE_LAYER_MODAL,
  insideOverlay,
  children,
}: PasteFieldTargetProps): ReactElement {
  const mouse = useMouseCommands();
  const handle = useContextMenuHandle();
  const reader = useClipboardReader();
  if (!mouse || !handle) return <>{children}</>;
  return (
    <MouseTarget
      layer={layer}
      onMouse={(hit) => {
        if (!isSecondaryPress(hit.event)) return false;
        return openContextMenu(handle, mouse, {
          menu: {
            // The absolute click cell: rect.left + localX is the same
            // column the event reported, reconstructed from the hit so
            // the anchor stays honest if hit-testing ever offsets it.
            x: hit.rect.left + hit.localX,
            y: hit.rect.top + hit.localY,
            target: { kind: "field" },
          },
          actions: {
            paste: () => {
              void reader.read().then((text) => {
                const clean = stripFieldPasteControls(text);
                if (clean.length === 0) return;
                onPasteText(clean, mouse);
              });
            },
          },
          ...(insideOverlay === undefined ? {} : { insideOverlay }),
        });
      }}
    >
      {children}
    </MouseTarget>
  );
}
