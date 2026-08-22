/**
 * Terminal mouse event model.
 *
 * The TUI decodes xterm mouse reports itself (see
 * `parse-mouse-events.ts`) instead of leaning on a library, because Ink
 * has no mouse layer at all: it parses stdin as keystrokes only. Keeping
 * the event shape terminal-agnostic here means the hit-testing and the
 * per-component handlers never touch escape sequences.
 *
 * Coordinates are **0-based** and measured in terminal cells from the
 * top-left of the screen — the same space Yoga computes the Ink layout
 * in, so a hit test is a plain rectangle containment check.
 */

export type MouseButton = "left" | "middle" | "right" | "none";

/**
 * `motion` is a report sent while a button is held (DECSET 1002). It is
 * a separate kind on purpose: the terminal encodes it as a press with
 * bit 5 set, and folding it into `press` would make a drag across the
 * UI fire a click per cell it crossed.
 */
export type MouseEventKind = "press" | "release" | "wheel" | "motion";

export type WheelDirection = "up" | "down";

export interface TuiMouseEvent {
  readonly kind: MouseEventKind;
  /** Which button changed state. `"none"` for wheel and for release-without-button reports. */
  readonly button: MouseButton;
  /** Set only when `kind === "wheel"`. */
  readonly wheel: WheelDirection | null;
  /** 0-based terminal column. */
  readonly x: number;
  /** 0-based terminal row. */
  readonly y: number;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly ctrl: boolean;
}

/** True for a plain (unmodified) left-button press — the "click" gesture. */
export function isPrimaryPress(event: TuiMouseEvent): boolean {
  return (
    // `motion` is excluded by construction: it is its own kind, so every
    // existing handler that gates on this keeps ignoring drags.
    event.kind === "press" &&
    event.button === "left" &&
    !event.shift &&
    !event.alt &&
    !event.ctrl
  );
}

/**
 * True for a plain right-button press — the "context menu" gesture.
 * Recognised on the press, like the primary click: the release report
 * does not name the button that came up (SGR encodes it, the legacy
 * encoding does not), so the press is the only cross-terminal signal.
 */
export function isSecondaryPress(event: TuiMouseEvent): boolean {
  return (
    event.kind === "press" &&
    event.button === "right" &&
    !event.shift &&
    !event.alt &&
    !event.ctrl
  );
}
