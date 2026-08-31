/**
 * Detects the terminal-agnostic selection gesture: a plain drag that
 * starts on dead content.
 *
 * The modifier trigger in `selection-passthrough.ts` only works where
 * the terminal *reports* the modified press. Some terminals bypass
 * reporting natively on Shift (kitty, WezTerm, Windows Terminal —
 * great, no code needed), iTerm2 reserves Option for that instead, and
 * others swallow modified clicks entirely — the app never sees the
 * event and the trigger is dead. A modifier can therefore never be the
 * only path.
 *
 * The drag itself can be, because intent is legible from geometry
 * alone. Every gesture the app understands — placing the caret,
 * dragging a composer selection, activating a row, pressing a button —
 * starts with a press some mouse target claims. A press nobody claims
 * lands on inert content: message text, panel prose, empty rail space.
 * Motion with the button still held after such a press means the
 * operator is dragging across that text, and dragging across inert
 * text is selecting — there is nothing else it could be.
 *
 * The tracker arms on an unclaimed left press and fires exactly once,
 * on the first held-motion report; the press's release (or the next
 * press) resets it. Wheel reports never participate: the wheel scrolls,
 * it does not gesture, and a scroll mid-hold must not disturb an armed
 * press. The firing itself suspends mouse reporting (see
 * `selection-passthrough.beginWindow`), which starves this tracker of
 * the rest of the gesture — stale reports decoded mid-suspension are
 * swallowed upstream in `tui-command.ts` and never reach `observe`.
 */
import type { TuiMouseEvent } from "./mouse-event.js";

export interface DragIntentTracker {
  /**
   * Feeds one dispatched event and whether the hit-test registry
   * consumed it. Call for every event, in stream order, right after
   * `registry.dispatch` — consumed-ness of the *press* is what decides
   * whether the drag that follows is a selection.
   */
  observe(event: TuiMouseEvent, consumed: boolean): void;
}

/** `onIntent` fires at most once per unclaimed press, on its first held motion. */
export function createDragIntentTracker(onIntent: () => void): DragIntentTracker {
  // Whether the last press went unclaimed — the pending "this drag
  // would be a selection" state. Firing, releasing, or a claimed press
  // all disarm it.
  let armed = false;
  return {
    observe(event: TuiMouseEvent, consumed: boolean): void {
      if (event.kind === "wheel") return;
      if (event.kind === "press") {
        armed = event.button === "left" && !consumed;
        return;
      }
      if (event.kind === "release") {
        armed = false;
        return;
      }
      // kind === "motion": a report with a button held. Only the left
      // button drags a selection.
      if (!armed || event.button !== "left") return;
      armed = false;
      onIntent();
    },
  };
}
