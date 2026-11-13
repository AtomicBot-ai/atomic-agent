import { useCallback, useEffect, useRef } from "react";
import { runVimKey, type VimKeyContext } from "./vim-keys.js";
import { noteVimKey, type VimEscClaim } from "./vim-esc-claim.js";
import { createVimState, type VimMode, type VimState } from "./vim-types.js";

/**
 * The editor's vim layer (ATO-662) as a key hook: hand it every key
 * before the ordinary grammar; `true` means vim took it.
 *
 * The vim state lives in a ref, not React state: it changes on every
 * key and nothing renders from it except the mode, which is reported
 * through `onModeChange` so the composer can show NORMAL / INSERT.
 * Turning vim on (or mounting with it on) starts in INSERT.
 *
 * `escClaim`, when given, is kept in step so the app's key layer can
 * tell an Esc vim spends from one it lets through (`vim-esc-claim.ts`).
 * `live` is whether the editor receives keys at all (focused, enabled).
 */
export function useVimKeys(
  enabled: boolean,
  onModeChange?: (mode: VimMode) => void,
  escClaim?: VimEscClaim,
  live = true,
): (ctx: VimKeyContext) => boolean {
  const stateRef = useRef<VimState>(createVimState());
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const onModeChangeRef = useRef(onModeChange);
  onModeChangeRef.current = onModeChange;
  const escClaimRef = useRef(escClaim);
  escClaimRef.current = escClaim;
  // Render-phase write to a mutable claim the app reads per keystroke.
  if (escClaim) escClaim.active = enabled && live;

  useEffect(() => {
    stateRef.current = createVimState();
    const claim = escClaimRef.current;
    if (claim) {
      claim.insert = true;
      claim.pending = false;
      claim.consumedEsc = false;
    }
    if (enabled) onModeChangeRef.current?.("insert");
  }, [enabled]);

  return useCallback((ctx: VimKeyContext): boolean => {
    if (!enabledRef.current) return false;
    const before = stateRef.current;
    const { state, handled } = runVimKey(before, ctx);
    stateRef.current = state;
    if (escClaimRef.current) {
      noteVimKey(escClaimRef.current, before, state, ctx.key.escape);
    }
    if (state.mode !== before.mode) onModeChangeRef.current?.(state.mode);
    return handled;
  }, []);
}
