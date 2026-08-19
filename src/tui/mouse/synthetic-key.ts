import type { Key } from "ink";

/**
 * Ink `Key` objects synthesised from mouse gestures.
 *
 * The wheel and "click the already-selected row" gestures mean exactly
 * what ↑/↓/Enter mean, and every panel already owns a key handler with
 * its own clamping, windowing and activation rules
 * (`*-key-bindings.ts`). Feeding those handlers a synthetic key reuses
 * that logic wholesale instead of duplicating a second, drifting copy
 * of "what does moving the cursor mean in the Skills panel".
 */

const NO_KEY: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};

/** A bare ↑ or ↓ press. */
export function arrowKey(direction: "up" | "down"): Key {
  return direction === "up"
    ? { ...NO_KEY, upArrow: true }
    : { ...NO_KEY, downArrow: true };
}

/** A bare Enter press — the "activate what is selected" gesture. */
export function returnKey(): Key {
  return { ...NO_KEY, return: true };
}
