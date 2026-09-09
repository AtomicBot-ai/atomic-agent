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
    expect(parseRunModeCommand("status")).toEqual({ openSwitch: false, status: true });
  });

  it("anything else is a usage line naming the input", () => {
    const out = parseRunModeCommand("hybrid");
    expect(out.openSwitch).toBe(false);
    expect(out.mode).toBeUndefined();
    expect(out.error).toContain('"hybrid"');
    expect(out.error).toContain(RUN_MODE_USAGE);
  });
});
