/**
 * "Press any key" taken literally.
 *
 * The splash makes a promise the Ink key table can only half keep:
 * `useInput` sees keystrokes, and an operator who reaches for the mouse
 * instead has said exactly the same thing — "I am here, move on". These
 * two predicates cover the halves that arrive on other channels, the
 * decoded mouse reports from `src/tui/mouse/` and Ink's bracketed-paste
 * stream.
 *
 * A terminal resize needs no predicate here: Ink reads it off stdout's
 * `resize` event, so it reaches neither channel and can never be
 * mistaken for input.
 */
import type { TuiMouseEvent } from "../mouse/mouse-event.js";

/**
 * Whether a mouse report counts as a keypress on the splash.
 *
 * A press of any button counts, and so does a wheel notch — the two
 * gestures an operator uses to say "go on". A release does not: it is
 * the tail of a press that was already counted, and taking both would
 * spend the whole splash on one click. Neither does a motion report,
 * which DECSET 1002 sends once per cell crossed while a button is held.
 */
export function mouseAdvancesIntro(event: TuiMouseEvent): boolean {
  return event.kind === "press" || event.kind === "wheel";
}

/**
 * Whether a bracketed paste counts as input on the splash.
 *
 * Pasting nothing is not a keypress. It reaches the app as an empty
 * string, which after Ink's parsing is indistinguishable from a
 * function key — `nonAlphanumericKeys` blanks the input for F1–F12,
 * Insert and the rest — so the two can only be told apart on the paste
 * channel. That is the whole reason the splash subscribes to it.
 */
export function pasteAdvancesIntro(text: string): boolean {
  return text.length > 0;
}
