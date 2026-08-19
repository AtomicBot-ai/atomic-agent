/**
 * React glue for the mouse layer.
 *
 * The TUI's panels are presentational: `DebugPane` hands each panel the
 * state slice it renders and nothing else, so wiring clicks by
 * prop-drilling `dispatch` and the orchestrator callbacks through ten
 * panels would be a far larger change than the feature warrants. A
 * context instead gives any component the three things a click handler
 * needs — `dispatch`, `callbacks`, and a *fresh* read of state — while
 * leaving every existing prop signature untouched.
 *
 * Outside the app (component tests, the wizard's separate Ink tree) the
 * context is absent and `useMouseTarget` degrades to a no-op ref, so a
 * clickable component still renders exactly as before.
 */
import { Box, type DOMElement } from "ink";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";
import {
  MOUSE_LAYER_BASE,
  MouseTargetRegistry,
  type MouseTargetHandler,
} from "./mouse-registry.js";

export interface MouseContextValue {
  readonly registry: MouseTargetRegistry;
  readonly dispatch: (action: TuiAction) => void;
  readonly callbacks: TuiAppCallbacks;
  /** Reads the live state — handlers fire outside React's render pass. */
  readonly getState: () => TuiState;
}

const MouseContext = createContext<MouseContextValue | null>(null);

export interface MouseProviderProps extends MouseContextValue {
  readonly children: ReactNode;
}

export function MouseProvider({
  children,
  ...value
}: MouseProviderProps): ReactElement {
  const memo = useMemo(
    () => value,
    [value.registry, value.dispatch, value.callbacks, value.getState],
  );
  return (
    <MouseContext.Provider value={memo}>{children}</MouseContext.Provider>
  );
}

/**
 * Access to `dispatch` / `callbacks` / `getState` for click handlers.
 * `null` when rendered outside `MouseProvider` (unit tests).
 */
export function useMouseCommands(): MouseContextValue | null {
  return useContext(MouseContext);
}

export interface UseMouseTargetOptions {
  readonly layer?: number;
  /** Set false to keep the element inert without changing the tree. */
  readonly enabled?: boolean;
}

/**
 * Registers the returned ref as a click target. Attach it to a `<Box>`;
 * the handler receives the click position relative to that box.
 */
export function useMouseTarget(
  handler: MouseTargetHandler,
  options: UseMouseTargetOptions = {},
): RefObject<DOMElement | null> {
  const { layer = MOUSE_LAYER_BASE, enabled = true } = options;
  const ref = useRef<DOMElement | null>(null);
  const context = useContext(MouseContext);
  // The handler is re-created on every render; keeping it in a ref means
  // registration survives without re-subscribing on each keystroke.
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    if (!context || !enabled) return;
    return context.registry.register({
      ref,
      layer,
      handler: (hit) => handlerRef.current(hit),
    });
  }, [context, enabled, layer]);
  return ref;
}

export interface MouseTargetProps extends UseMouseTargetOptions {
  readonly onMouse: MouseTargetHandler;
  /**
   * Pass `0` for inline markers on a text row: without it Yoga squeezes
   * the wrapper when the row overflows and the label loses characters.
   */
  readonly flexShrink?: number;
  readonly children: ReactNode;
}

/**
 * Layout-neutral clickable wrapper: an unstyled `<Box>` around
 * `children`. In a column it occupies the same single row its content
 * did; in a row it hugs its content.
 */
export function MouseTarget({
  onMouse,
  children,
  flexShrink,
  ...options
}: MouseTargetProps): ReactElement {
  const ref = useMouseTarget(onMouse, options);
  return (
    <Box ref={ref} {...(flexShrink === undefined ? {} : { flexShrink })}>
      {children}
    </Box>
  );
}
