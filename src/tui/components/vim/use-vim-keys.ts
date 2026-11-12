import { useCallback, useEffect, useRef } from "react";
import { runVimKey, type VimKeyContext } from "./vim-keys.js";
import { createVimState, type VimMode, type VimState } from "./vim-types.js";

/**
 * The editor's vim layer (ATO-662) as a key hook: hand it every key
 * before the ordinary grammar; `true` means vim took it.
 *
 * The vim state lives in a ref, not React state: it changes on every
 * key and nothing renders from it except the mode, which is reported
 * through `onModeChange` so the composer can show NORMAL / INSERT.
 * Turning vim on (or mounting with it on) starts in INSERT.
 */
export function useVimKeys(
  enabled: boolean,
  onModeChange?: (mode: VimMode) => void,
): (ctx: VimKeyContext) => boolean {
  const stateRef = useRef<VimState>(createVimState());
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const onModeChangeRef = useRef(onModeChange);
  onModeChangeRef.current = onModeChange;

  useEffect(() => {
    stateRef.current = createVimState();
    if (enabled) onModeChangeRef.current?.("insert");
  }, [enabled]);

  return useCallback((ctx: VimKeyContext): boolean => {
    if (!enabledRef.current) return false;
    const before = stateRef.current;
    const { state, handled } = runVimKey(before, ctx);
    stateRef.current = state;
    if (state.mode !== before.mode) onModeChangeRef.current?.(state.mode);
    return handled;
  }, []);
}
