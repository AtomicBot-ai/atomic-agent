import { describe, expect, it } from "vitest";
import {
  CODING_MODES,
  codingModeLook,
  cycleCodingMode,
  resolveCodingMode,
} from "./coding-mode.js";

/** How many presses apart two modes are, going the short way round. */
function ringDistance(a: string, b: string): number {
  const raw = Math.abs(CODING_MODES.indexOf(a as never) - CODING_MODES.indexOf(b as never));
  return Math.min(raw, CODING_MODES.length - raw);
}

describe("the coding-mode ring", () => {
  it("puts plan next to default, and bypass as far from plan as the ring allows", () => {
    expect([...CODING_MODES]).toEqual([
      "default",
      "plan",
      "auto",
      "bypass",
    ]);
    // The ring *wraps*, which is what makes severity order wrong: it
    // would leave `bypass` one backward press from `plan`, and `plan`
    // is exactly where a careful operator parks. Measured the way the
    // ring is actually walked.
    expect(ringDistance("plan", "bypass")).toBe(2);
    expect(ringDistance("default", "plan")).toBe(1);
    // Two is the maximum separation available on a four-mode ring.
    expect(ringDistance("plan", "bypass")).toBe(
      Math.floor(CODING_MODES.length / 2),
    );
  });

  it("cycles both ways and wraps", () => {
    expect(cycleCodingMode("default")).toBe("plan");
    expect(cycleCodingMode("bypass")).toBe("default");
    expect(cycleCodingMode("default", true)).toBe("bypass");
    expect(cycleCodingMode("plan", true)).toBe("default");
  });

  it("never lands on bypass by one press from plan, in either direction", () => {
    // The property the order exists for, stated directly.
    expect(cycleCodingMode("plan")).not.toBe("bypass");
    expect(cycleCodingMode("plan", true)).not.toBe("bypass");
  });

  it("recovers from a mode that is not in the ring", () => {
    expect(cycleCodingMode("nonsense" as never)).toBe("plan");
  });

  it("gives every mode a label and a tone", () => {
    for (const mode of CODING_MODES) {
      const look = codingModeLook(mode);
      expect(look.label.length).toBeGreaterThan(0);
      expect(look.summary.length).toBeGreaterThan(0);
    }
    // Plan is the *safest* mode; painting the careful choice in a
    // hazard colour would be backwards.
    expect(codingModeLook("plan").tone).toBe("accent");
    expect(codingModeLook("bypass").tone).toBe("error");
  });
});

describe("what a mode means to the runtime", () => {
  it("restores the configured level on the way back to default", () => {
    // The reason `baseLevel` is a parameter rather than a constant: an
    // operator who configured level 3, visited bypass and came back
    // must land on 3, not on a hardcoded 1.
    for (const base of [1, 2, 3, 4, 5] as const) {
      expect(resolveCodingMode("default", base)).toEqual({
        approvalLevel: base,
        planMode: false,
      });
    }
  });

  it("raises to workspace writes for auto, and never lowers", () => {
    expect(resolveCodingMode("auto", 1).approvalLevel).toBe(2);
    expect(resolveCodingMode("auto", 2).approvalLevel).toBe(2);
    // Someone already at 4 asking for auto is asking for at
    // least that. Clamping them down to 2 would surprise them in the
    // direction that costs prompts.
    expect(resolveCodingMode("auto", 4).approvalLevel).toBe(4);
    expect(resolveCodingMode("auto", 5).approvalLevel).toBe(5);
  });

  it("opens the ladder all the way for bypass", () => {
    expect(resolveCodingMode("bypass", 1)).toEqual({
      approvalLevel: 5,
      planMode: false,
    });
  });

  it("leaves the ladder exactly where it was for plan", () => {
    // Plan mode refuses mutations outright, so the level it would have
    // asked at is moot — and not touching it is what lets `default`
    // restore without remembering anything extra.
    for (const base of [1, 3, 5] as const) {
      expect(resolveCodingMode("plan", base)).toEqual({
        approvalLevel: base,
        planMode: true,
      });
    }
  });

  it("turns plan mode off for every other mode", () => {
    for (const mode of CODING_MODES) {
      expect(resolveCodingMode(mode, 1).planMode).toBe(mode === "plan");
    }
  });
});
