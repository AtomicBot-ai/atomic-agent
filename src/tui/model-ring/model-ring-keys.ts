import type { Key } from "ink";

import type { ModelRingDirection } from "./model-ring.js";

/**
 * Which way a key walks the favourite ring (ATO-2169, ATO-2500), or null
 * when it is not a ring key. ctrl+p is the next favourite (pi's
 * `app.model.cycleForward`). The previous one answers to ctrl+shift+p,
 * pi's `cycleBackward`, which only a terminal speaking the kitty keyboard
 * protocol can tell from ctrl+p, and to alt+p. alt+p needs a terminal
 * that sends Alt as Meta (Esc then p): Linux and Windows terminals do by
 * default, but macOS Terminal.app and iTerm2 type a character ("π") for
 * Option+P until "Use Option as Meta key" (Terminal.app) or "Option key:
 * Esc+" (iTerm2) is on. That character is never mapped here, so typing it
 * still works. With vim on, an Esc-prefixed `p` is the Esc vim
 * takes to leave INSERT followed by a paste, so alt+p stands down then
 * (the abort chord's rule, ATO-662).
 */
export function modelRingKeyDirection(
  input: string,
  key: Pick<Key, "ctrl" | "shift" | "meta">,
  vimClaimsEsc = false,
): ModelRingDirection | null {
  if (input.toLowerCase() !== "p") return null;
  if (key.ctrl && !key.meta) return key.shift ? -1 : 1;
  if (key.meta && !key.ctrl && !key.shift && !vimClaimsEsc) return -1;
  return null;
}
