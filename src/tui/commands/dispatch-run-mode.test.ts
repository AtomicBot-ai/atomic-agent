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
  it("reads `swap` as the leg trade, not as a mode name", () => {
    expect(parseRunModeCommand("swap")).toEqual({
      openSwitch: false,
      swap: true,
    });
    expect(parseRunModeCommand(" SWAP ")).toEqual({
      openSwitch: false,
      swap: true,
    });
  });
});

describe("parseRunModeCommand: fusion roles", () => {
  it("parses a role on a shared provider with its own model, keeping case", () => {
    expect(parseRunModeCommand("role review openrouter deepseek/DeepSeek-v4.1")).toEqual({
      openSwitch: false,
      role: { role: "review", pin: { providerId: "openrouter", model: "deepseek/DeepSeek-v4.1" } },
    });
    expect(parseRunModeCommand("ROLE Build or-coder")).toEqual({
      openSwitch: false,
      role: { role: "build", pin: { providerId: "or-coder" } },
    });
  });

  it("clears a role and lists the roles", () => {
    expect(parseRunModeCommand("role plan off")).toEqual({
      openSwitch: false,
      role: { role: "plan", pin: null },
    });
    expect(parseRunModeCommand("roles")).toEqual({ openSwitch: false, listRoles: true });
  });

  it("answers an unknown role or a missing provider with the role usage", () => {
    expect(parseRunModeCommand("role coder openrouter").error).toMatch(/^usage: \/runmode role/);
    expect(parseRunModeCommand("role review").error).toMatch(/^usage: \/runmode role/);
  });
});
