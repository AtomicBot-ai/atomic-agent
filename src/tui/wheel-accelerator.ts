/**
 * Accumulates rapid wheel events into an accelerated scroll delta. Each
 * notch is `baseDelta`; if a follow-up notch in the same direction
 * arrives within `accelWindowMs`, the multiplier ratchets up by
 * `accelStep` (capped at `maxMultiplier`) so a fast scroll covers more
 * ground than a slow one. A direction flip or a long pause resets the
 * multiplier to `1`.
 *
 * State lives outside React: the accelerator is constructed once at
 * runtime startup and threaded into the mouse-input handler. The
 * reducer never sees the multiplier — it just receives the final delta
 * via a `chat_scrolled` action.
 */
export interface WheelAcceleratorOptions {
  /** Base delta (in messages) per single wheel notch. Default `1`. */
  baseDelta?: number;
  /**
   * If the next notch arrives within this many ms of the previous one
   * **in the same direction**, the multiplier increases. Default `120`.
   */
  accelWindowMs?: number;
  /** Multiplier increment per consecutive in-window notch. Default `1.5`. */
  accelStep?: number;
  /** Hard cap on the multiplier. Default `6` ⇒ max delta = baseDelta × 6. */
  maxMultiplier?: number;
  /** Injected for tests; defaults to `Date.now`. */
  now?: () => number;
}

export type WheelDirection = 1 | -1;

export interface WheelAccelerator {
  /**
   * Records a notch and returns the accelerated delta. Direction is
   * `+1` for "scroll up / older messages" and `-1` for "scroll down /
   * newer messages" — match the convention used by `chat_scrolled`.
   */
  next(direction: WheelDirection): number;
  /** Forces the multiplier back to `1` (used on Esc / scroll-reset). */
  reset(): void;
}

export function createWheelAccelerator(
  opts: WheelAcceleratorOptions = {},
): WheelAccelerator {
  const baseDelta = opts.baseDelta ?? 1;
  const accelWindowMs = opts.accelWindowMs ?? 120;
  const accelStep = opts.accelStep ?? 1.5;
  const maxMultiplier = opts.maxMultiplier ?? 6;
  const now = opts.now ?? Date.now;

  let lastDirection: WheelDirection | null = null;
  let lastAt = 0;
  let multiplier = 1;

  return {
    next(direction) {
      const t = now();
      const sameDirection = lastDirection === direction;
      const inWindow = t - lastAt <= accelWindowMs;
      multiplier =
        sameDirection && inWindow
          ? Math.min(maxMultiplier, multiplier * accelStep)
          : 1;
      lastDirection = direction;
      lastAt = t;
      const magnitude = Math.max(1, Math.round(baseDelta * multiplier));
      return direction * magnitude;
    },
    reset() {
      lastDirection = null;
      lastAt = 0;
      multiplier = 1;
    },
  };
}
