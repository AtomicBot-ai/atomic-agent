import { describe, expect, it } from "vitest";
import type { TuiMouseEvent } from "../mouse/mouse-event.js";
import { mouseAdvancesIntro, pasteAdvancesIntro } from "./intro-input.js";

const event = (over: Partial<TuiMouseEvent>): TuiMouseEvent => ({
  kind: "press",
  button: "left",
  wheel: null,
  x: 10,
  y: 4,
  shift: false,
  alt: false,
  ctrl: false,
  ...over,
});

const MOUSE_CASES: readonly { name: string; event: TuiMouseEvent; advances: boolean }[] = [
  { name: "a left click", event: event({}), advances: true },
  { name: "a right click", event: event({ button: "right" }), advances: true },
  { name: "a middle click", event: event({ button: "middle" }), advances: true },
  // A modified click is still a click: there is nothing on the splash
  // to select, so shift does not mean "extend" here.
  { name: "a shift+click", event: event({ shift: true }), advances: true },
  {
    name: "a wheel notch up",
    event: event({ kind: "wheel", button: "none", wheel: "up" }),
    advances: true,
  },
  {
    name: "a wheel notch down",
    event: event({ kind: "wheel", button: "none", wheel: "down" }),
    advances: true,
  },
  {
    name: "the release that ends a click",
    event: event({ kind: "release", button: "none" }),
    advances: false,
  },
  { name: "a drag report", event: event({ kind: "motion" }), advances: false },
];

describe("mouseAdvancesIntro", () => {
  for (const testCase of MOUSE_CASES) {
    it(`${testCase.advances ? "counts" : "ignores"} ${testCase.name}`, () => {
      expect(mouseAdvancesIntro(testCase.event)).toBe(testCase.advances);
    });
  }
});

describe("pasteAdvancesIntro", () => {
  it("counts a paste that carries text", () => {
    expect(pasteAdvancesIntro("hello")).toBe(true);
    expect(pasteAdvancesIntro(" ")).toBe(true);
    expect(pasteAdvancesIntro("\n")).toBe(true);
  });

  it("ignores a paste of the empty string", () => {
    expect(pasteAdvancesIntro("")).toBe(false);
  });
});
