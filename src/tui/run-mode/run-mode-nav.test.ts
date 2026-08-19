import { describe, expect, it } from "vitest";

import { clampCloudShare, cycleRunMode, RUN_MODES } from "./run-mode-nav.js";

describe("cycleRunMode", () => {
  it("cycles forward and wraps", () => {
    expect(cycleRunMode("local", 1)).toBe("cloud");
    expect(cycleRunMode("cloud", 1)).toBe("fusion");
    expect(cycleRunMode("fusion", 1)).toBe("local");
  });

  it("cycles backward and wraps", () => {
    expect(cycleRunMode("local", -1)).toBe("fusion");
    expect(cycleRunMode("fusion", -1)).toBe("cloud");
  });

  it("returns to the start after a full lap", () => {
    let mode = RUN_MODES[0]!;
    for (let i = 0; i < RUN_MODES.length; i += 1) mode = cycleRunMode(mode, 1);
    expect(mode).toBe(RUN_MODES[0]);
  });
});

describe("clampCloudShare", () => {
  it("clamps to the inclusive 0-100 range", () => {
    expect(clampCloudShare(-10)).toBe(0);
    expect(clampCloudShare(140)).toBe(100);
    expect(clampCloudShare(40)).toBe(40);
  });

  it("rounds fractional input", () => {
    expect(clampCloudShare(42.6)).toBe(43);
  });

  it("treats non-finite input as zero rather than NaN", () => {
    expect(clampCloudShare(Number.NaN)).toBe(0);
  });
});
