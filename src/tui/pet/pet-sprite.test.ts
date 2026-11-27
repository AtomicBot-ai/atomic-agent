import { describe, expect, it } from "vitest";

import { PET_STATES } from "./pet-machine.js";
import { PET_CHIP_MAX_CELLS, PET_FRAMES, PET_SPRITE_CELLS, petAnimates, petChipText, petFrame } from "./pet-sprite.js";

describe("terminal pet sprite (ATO-2513)", () => {
  it("is plain ASCII, so every terminal and font draws it", () => {
    for (const state of PET_STATES) {
      for (const frame of PET_FRAMES[state]) expect(frame).toMatch(/^[\x20-\x7e]+$/);
    }
  });

  it("pads every frame to one width, so the bar never shifts while it moves", () => {
    for (const state of PET_STATES) {
      for (let tick = 0; tick < 8; tick++) expect(petFrame(state, tick)).toHaveLength(PET_SPRITE_CELLS);
    }
  });

  it("steps through the frames and wraps around", () => {
    expect(petFrame("working", 0).trim()).toBe("(o.o)/");
    expect(petFrame("working", 1).trim()).toBe("(o.o)-");
    expect(petFrame("working", 4).trim()).toBe("(o.o)/");
  });

  it("names the state after the face, within the cells the bar keeps for it", () => {
    expect(petChipText("waiting", 0)).toContain("needs you");
    expect(petChipText("sleeping", 0)).toContain("resting");
    for (const state of PET_STATES) expect(petChipText(state, 0).length + 2).toBeLessThanOrEqual(PET_CHIP_MAX_CELLS);
  });

  it("moves only while something happens: no timer at rest", () => {
    expect(petAnimates("idle")).toBe(false);
    expect(petAnimates("sleeping")).toBe(false);
    expect(petAnimates("error")).toBe(false);
    expect(petAnimates("thinking")).toBe(true);
    expect(petAnimates("working")).toBe(true);
  });
});
