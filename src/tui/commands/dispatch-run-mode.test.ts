import { describe, expect, it } from "vitest";

import { RUN_MODE_USAGE, parseRunModeCommand } from "./dispatch-run-mode.js";

describe("parseRunModeCommand", () => {
  it("bare opens the switch", () => {
    expect(parseRunModeCommand("")).toEqual({ openSwitch: true });
    expect(parseRunModeCommand("   ")).toEqual({ openSwitch: true });
  });

  it.each(["local", "cloud", "fusion", " Fusion "])("names mode %j", (raw) => {
    expect(parseRunModeCommand(raw)).toEqual({
      openSwitch: false,
      mode: raw.trim().toLowerCase(),
    });
  });

  it("status is its own verb", () => {
    expect(parseRunModeCommand("status")).toEqual({
      openSwitch: false,
      status: true,
    });
  });

  it("takes a worker count", () => {
    expect(parseRunModeCommand("workers 4")).toEqual({
      openSwitch: false,
      workers: 4,
    });
    expect(parseRunModeCommand("  WORKERS   1 ")).toEqual({
      openSwitch: false,
      workers: 1,
    });
  });

  it("bounds the worker count", () => {
    for (const raw of ["workers 0", "workers 9"]) {
      const out = parseRunModeCommand(raw);
      expect(out.workers).toBeUndefined();
      expect(out.error).toMatch(/workers must be 1-8/);
    }
    // Not a count at all: falls through to the unknown-mode line.
    expect(parseRunModeCommand("workers many").error).toMatch(
      /unknown run mode/,
    );
  });

  it("anything else is a usage line naming the input", () => {
    const out = parseRunModeCommand("hybrid");
    expect(out.openSwitch).toBe(false);
    expect(out.mode).toBeUndefined();
    expect(out.error).toContain('"hybrid"');
    expect(out.error).toContain(RUN_MODE_USAGE);
  });
});
