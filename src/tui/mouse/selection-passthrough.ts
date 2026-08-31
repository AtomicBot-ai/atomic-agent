/**
 * Giving the terminal its drag-to-select back, for one selection.
 *
 * ## Why this exists rather than in-app selection
 *
 * Selecting text inside the app — track the drag, paint an inverse-video
 * span, copy the range — was considered and rejected. Button-held motion
 * reports (1002, on for the composer's own drag — see
 * `mouse-tracking.ts`) would let it follow the gesture, but it needs two
 * more things this design does not have and would not cheaply gain:
 *
 *   1. A readback of *what character is painted in each cell*. Ink has
 *      no framebuffer API — `measureElement` returns sizes, and
 *      `mouse-registry` deliberately reconstructs geometry from Yoga
 *      rather than from painted text. There is nothing to slice.
 *   2. Every component that could fall under the selection rectangle
 *      would have to become selection-aware to paint the highlight.
 *
 * And the result would still be worse than what the terminal already
 * does: it could not select the scrollback above the alt screen, it
 * could not honour the terminal's own copy-on-select or ⌘C, and it would
 * copy the *rendered* text — borders, wrap points and all — where the
 * `[copy]` button copies the message source.
 *
 * ## What this does instead
 *
 * It suspends reporting for a short window with a chat notice, so the
 * terminal's own selection and copy work; the window closes on its own.
 * Two triggers feed it:
 *
 * **A plain drag on dead content.** A press that no mouse target claims
 * — message text, panel prose, empty rail space — followed by motion
 * with the button held cannot be anything but the operator dragging to
 * select: every gesture the app understands starts on a live target.
 * `drag-intent.ts` detects the pattern on the registry side and the
 * host calls {@link SelectionPassthrough.beginWindow} with the `"drag"`
 * trigger. The gesture that tripped the detector is already lost to
 * reporting, so the notice says to drag *again* — and the second drag
 * selects, in every terminal, with no modifier to remember. This is the
 * terminal-agnostic path; the modifier paths below are shortcuts.
 *
 * **A modified press.** On many terminals a modifier already bypasses
 * reporting natively — Shift on kitty, WezTerm, GNOME Terminal and
 * Windows Terminal, Option on iTerm2 — so native selection is one
 * modifier away and costs zero code. Apple Terminal has no such bypass
 * and *reports* the shifted (or alt-modified) press instead. That
 * asymmetry is the trigger: a modified press arriving here is positive
 * evidence that this terminal did not bypass — exactly the terminal
 * that needs help — and that the operator was reaching for a selection.
 * On a terminal that does bypass, this branch never fires; being inert
 * where it is not needed is the point. And on a terminal that swallows
 * modified clicks entirely, the plain-drag path above still works.
 *
 * Reporting always comes back on its own after `windowMs`. Resuming on
 * activity is not possible: while suspended the app receives no mouse
 * events at all, which is the whole idea.
 */
import type { TuiMouseEvent } from "./mouse-event.js";

/** The part of `MouseTrackingController` this needs. */
export interface SelectionSuspendable {
  suspend(): void;
  resume(): void;
  isSuspended(): boolean;
}

export interface SelectionPassthroughOptions {
  /**
   * Reads the live tracking controller. A getter rather than a value
   * because `/mouse on|off` replaces the controller underneath us, and a
   * captured one would resume a controller nobody is using any more.
   */
  readonly tracking: () => SelectionSuspendable | null;
  /** Surfaces the state change to the operator. */
  readonly notify?: (message: string) => void;
  readonly windowMs?: number;
  /** Injected for fake-timer tests. */
  readonly setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  readonly clearTimer?: (handle: NodeJS.Timeout) => void;
}

/**
 * What opened the window — it shapes the notice. A `"modifier"` window
 * opens on the press, before any drag happened, so the operator is told
 * to drag; a `"drag"` window opens mid-gesture, after the terminal has
 * already reported (and thereby eaten) a whole drag, so the operator is
 * told to drag *again*.
 */
export type SelectionTrigger = "modifier" | "drag";

export interface SelectionPassthrough {
  /**
   * Offers a decoded mouse event. Returns `true` when the event was
   * consumed as a selection gesture and must **not** reach the hit-test
   * registry.
   */
  observe(event: TuiMouseEvent): boolean;
  /**
   * Opens the window from outside the event stream — the drag-intent
   * detector lives past the hit test and cannot go through
   * {@link observe}. Same suspension, same timer, same auto-resume as
   * the modifier path; a no-op while a window is already open or when
   * mouse support is off.
   */
  beginWindow(trigger: SelectionTrigger): void;
  /** Ends the window early. */
  resumeNow(): void;
  /** Cancels any pending resume. Called during TUI teardown. */
  dispose(): void;
}

/**
 * Long enough to line up a drag on a long reply without rushing, short
 * enough that an operator who triggered it by accident does not conclude
 * the mouse broke.
 */
export const DEFAULT_SELECTION_WINDOW_MS = 10_000;

export function createSelectionPassthrough(
  options: SelectionPassthroughOptions,
): SelectionPassthrough {
  const {
    tracking,
    notify,
    windowMs = DEFAULT_SELECTION_WINDOW_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = options;
  let timer: NodeJS.Timeout | null = null;

  const cancelTimer = (): void => {
    if (!timer) return;
    clearTimer(timer);
    timer = null;
  };

  const resumeNow = (): void => {
    cancelTimer();
    const controller = tracking();
    // `/mouse off` during the window: reporting is already gone for good
    // and there is nothing to restore or announce.
    if (!controller || !controller.isSuspended()) return;
    controller.resume();
    notify?.("mouse back on — clicks and the wheel work again");
  };

  const beginWindow = (trigger: SelectionTrigger): void => {
    const controller = tracking();
    // Already suspended: the window is open and running; restarting the
    // timer here would let repeated triggers extend the pause forever.
    if (!controller || controller.isSuspended()) return;
    controller.suspend();
    cancelTimer();
    timer = setTimer(() => {
      timer = null;
      resumeNow();
    }, windowMs);
    const seconds = Math.round(windowMs / 1000);
    notify?.(
      trigger === "drag"
        ? `text selection: mouse paused for ${seconds}s — drag again to ` +
            "select, then copy the way you normally would"
        : `text selection: mouse paused for ${seconds}s — drag to select, ` +
            "then copy the way you normally would in this terminal",
    );
  };

  return {
    observe(event: TuiMouseEvent): boolean {
      if (event.kind !== "press" || (!event.shift && !event.alt)) return false;
      const controller = tracking();
      if (!controller) return false;
      if (controller.isSuspended()) {
        // Cannot happen while reporting is off, but a report already in
        // flight when we suspended can still land here. Do not restart
        // the window on it — that would be the terminal extending its
        // own pause.
        return true;
      }
      beginWindow("modifier");
      return true;
    },
    beginWindow,
    resumeNow,
    dispose: cancelTimer,
  };
}
