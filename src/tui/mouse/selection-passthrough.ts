/**
 * Giving the terminal its drag-to-select back, for one selection.
 *
 * ## Why this exists rather than in-app selection
 *
 * Selecting text inside the app — track the drag, paint an inverse-video
 * span, copy the range — was considered and rejected. It needs three
 * things this design does not have and would not cheaply gain:
 *
 *   1. Motion reports (1002/1003), so the highlight follows the drag.
 *      Those are off on purpose (see `mouse-tracking.ts`) and would have
 *      to come back on, at least for the duration of a drag.
 *   2. A readback of *what character is painted in each cell*. Ink has
 *      no framebuffer API — `measureElement` returns sizes, and
 *      `mouse-registry` deliberately reconstructs geometry from Yoga
 *      rather than from painted text. There is nothing to slice.
 *   3. Every component that could fall under the selection rectangle
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
 * On the terminals that matter most (iTerm2, kitty, WezTerm, Alacritty,
 * foot, Windows Terminal, VS Code) **Shift+drag already works**: the
 * terminal keeps the gesture for itself and never reports it, so native
 * selection is one modifier away and costs zero code. Apple Terminal has
 * no such bypass; there, a shift-modified press is *reported to the app*
 * instead.
 *
 * That asymmetry is the trigger. A shift-modified press arriving here is
 * positive evidence that this terminal did not bypass — i.e. exactly the
 * terminal that needs help — and that the operator was reaching for a
 * selection. So we hand reporting back for a short window and say so.
 * The gesture that produced the trigger is lost (the terminal has
 * already reported it rather than selected with it), so the operator
 * drags a second time; that is the price of not having a bypass, and it
 * is still cheaper than discovering `/mouse off`.
 *
 * On a terminal that *does* bypass, this code never fires. Being inert
 * where it is not needed is the point.
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

export interface SelectionPassthrough {
  /**
   * Offers a decoded mouse event. Returns `true` when the event was
   * consumed as a selection gesture and must **not** reach the hit-test
   * registry.
   */
  observe(event: TuiMouseEvent): boolean;
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

  return {
    observe(event: TuiMouseEvent): boolean {
      if (event.kind !== "press" || !event.shift) return false;
      const controller = tracking();
      if (!controller) return false;
      if (controller.isSuspended()) {
        // Cannot happen while reporting is off, but a report already in
        // flight when we suspended can still land here. Do not restart
        // the window on it — that would be the terminal extending its
        // own pause.
        return true;
      }
      controller.suspend();
      cancelTimer();
      timer = setTimer(() => {
        timer = null;
        resumeNow();
      }, windowMs);
      const seconds = Math.round(windowMs / 1000);
      notify?.(
        `text selection: mouse paused for ${seconds}s — drag to select, ` +
          "then copy the way you normally would in this terminal",
      );
      return true;
    },
    resumeNow,
    dispose: cancelTimer,
  };
}
