import { describe, expect, it } from "vitest";
import {
  isPrimaryPress,
  isSecondaryPress,
  type TuiMouseEvent,
} from "./mouse-event.js";

function event(overrides: Partial<TuiMouseEvent>): TuiMouseEvent {
  return {
    kind: "press",
    button: "left",
    wheel: null,
    x: 4,
    y: 2,
    shift: false,
    alt: false,
    ctrl: false,
    ...overrides,
  };
}

describe("isSecondaryPress", () => {
  it("accepts a plain right-button press", () => {
    expect(isSecondaryPress(event({ button: "right" }))).toBe(true);
  });

  it("is disjoint from the primary press on the same report", () => {
    const right = event({ button: "right" });
    expect(isPrimaryPress(right)).toBe(false);
    expect(isSecondaryPress(event({ button: "left" }))).toBe(false);
  });

  it("ignores releases, motion and modified presses", () => {
    // The release report never names the button that came up, so the
    // press is the only recognisable half of the gesture.
    expect(isSecondaryPress(event({ button: "none", kind: "release" }))).toBe(
      false,
    );
    expect(isSecondaryPress(event({ button: "right", kind: "motion" }))).toBe(
      false,
    );
    expect(isSecondaryPress(event({ button: "right", ctrl: true }))).toBe(false);
    expect(isSecondaryPress(event({ button: "right", shift: true }))).toBe(
      false,
    );
    expect(isSecondaryPress(event({ button: "right", alt: true }))).toBe(false);
  });
});
