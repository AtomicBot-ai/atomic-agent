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

export type MouseEventKind = "press" | "release" | "wheel";

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
    event.kind === "press" &&
    event.button === "left" &&
    !event.shift &&
    !event.alt &&
    !event.ctrl
  );
}
