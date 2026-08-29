/**
 * The bridge between the context-menu SLICE (where the menu is, what it
 * targets — reducer state) and its ACTIONS (what cut/copy/paste do —
 * closures over one component's private buffer).
 *
 * The reducer cannot hold the closures and the components cannot hold
 * the slice, so the provider owns a single mutable ref: whichever
 * surface opens the menu writes its actions into the ref in the same
 * breath as dispatching `context_menu_opened`, and the popup reads them
 * back when a row is clicked. Exactly one menu can be open, so one slot
 * is the honest capacity.
 */
import {
  createContext,
  useContext,
  useRef,
  type ReactElement,
  type ReactNode,
} from "react";
import type { MouseContextValue } from "../mouse/mouse-context.js";
import type { ContextMenuState } from "./context-menu-state.js";
import { contextMenuBlockedByOverlay } from "./context-menu-state.js";

export interface ContextMenuActions {
  /** Absent on paste-only targets (hand-rolled fields). */
  readonly cut?: () => void;
  readonly copy?: () => void;
  readonly paste: () => void;
}

export interface ContextMenuHandle {
  /** The open menu's actions; stale after close, replaced on open. */
  readonly actionsRef: { current: ContextMenuActions | null };
}

const ContextMenuContext = createContext<ContextMenuHandle | null>(null);

export function ContextMenuProvider({
  children,
}: {
  readonly children: ReactNode;
}): ReactElement {
  const actionsRef = useRef<ContextMenuActions | null>(null);
  // The handle object itself must be stable, or every consumer would
  // re-register its mouse target per render.
  const handle = useRef<ContextMenuHandle>({ actionsRef }).current;
  return (
    <ContextMenuContext.Provider value={handle}>
      {children}
    </ContextMenuContext.Provider>
  );
}

/** `null` outside the provider (component tests, the setup wizard). */
export function useContextMenuHandle(): ContextMenuHandle | null {
  return useContext(ContextMenuContext);
}

export interface OpenContextMenuRequest {
  readonly menu: ContextMenuState;
  readonly actions: ContextMenuActions;
  /**
   * Skip the floating-overlay guard. Only for fields that belong to an
   * overlay themselves (the operator menu's query, the composer
   * switch's filter) — see `contextMenuBlockedByOverlay`.
   */
  readonly insideOverlay?: boolean;
}

/**
 * The one way a menu opens: actions parked on the handle, slice
 * dispatched. Returns whether it opened, so mouse handlers can decline
 * the press honestly when it did not.
 */
export function openContextMenu(
  handle: ContextMenuHandle,
  mouse: MouseContextValue,
  request: OpenContextMenuRequest,
): boolean {
  if (!request.insideOverlay && contextMenuBlockedByOverlay(mouse.getState())) {
    return false;
  }
  handle.actionsRef.current = request.actions;
  mouse.dispatch({ type: "context_menu_opened", menu: request.menu });
  return true;
}
