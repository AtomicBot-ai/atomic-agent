import { describe, expect, it } from "vitest";

import {
  clampRowsForLegacyConhost,
  isLegacyConhost,
  legacyConhostStartupHint,
  mouseDefaultForHost,
} from "./legacy-conhost.js";

describe("isLegacyConhost", () => {
  it("detects a bare conhost environment on Windows", () => {
    expect(isLegacyConhost({ platform: "win32", env: {} })).toBe(true);
  });

  it("is false under Windows Terminal (WT_SESSION)", () => {
    expect(
      isLegacyConhost({
        platform: "win32",
        env: { WT_SESSION: "a-guid" },
      }),
    ).toBe(false);
  });

  it("is false under hosts that set TERM_PROGRAM (VS Code, mintty)", () => {
    expect(
      isLegacyConhost({
        platform: "win32",
        env: { TERM_PROGRAM: "vscode" },
      }),
    ).toBe(false);
  });

  it("is false everywhere that is not Windows", () => {
    expect(isLegacyConhost({ platform: "darwin", env: {} })).toBe(false);
    expect(isLegacyConhost({ platform: "linux", env: {} })).toBe(false);
  });

  it("treats empty marker variables as absent", () => {
    expect(
      isLegacyConhost({
        platform: "win32",
        env: { WT_SESSION: "", TERM_PROGRAM: "" },
      }),
    ).toBe(true);
  });

  it("ATOMIC_AGENT_CONHOST_GUARD=1 forces the guard on anywhere", () => {
    expect(
      isLegacyConhost({
        platform: "darwin",
        env: { ATOMIC_AGENT_CONHOST_GUARD: "1" },
      }),
    ).toBe(true);
  });

  it("ATOMIC_AGENT_CONHOST_GUARD=0 forces the guard off on a conhost", () => {
    expect(
      isLegacyConhost({
        platform: "win32",
        env: { ATOMIC_AGENT_CONHOST_GUARD: "0" },
      }),
    ).toBe(false);
  });
});

describe("clampRowsForLegacyConhost", () => {
  it("reserves exactly one row on a legacy conhost", () => {
    expect(clampRowsForLegacyConhost(24, true)).toBe(23);
    expect(clampRowsForLegacyConhost(50, true)).toBe(49);
  });

  it("keeps the full height everywhere else", () => {
    expect(clampRowsForLegacyConhost(24, false)).toBe(24);
  });

  it("never reports less than one row", () => {
    expect(clampRowsForLegacyConhost(1, true)).toBe(1);
    expect(clampRowsForLegacyConhost(0, true)).toBe(1);
  });
});

describe("mouseDefaultForHost", () => {
  it("starts mouse reporting off on the classic Windows console", () => {
    expect(mouseDefaultForHost(true, { platform: "win32", env: {} })).toBe(false);
  });

  it("keeps the configured value under Windows Terminal, VS Code and off Windows", () => {
    expect(mouseDefaultForHost(true, { platform: "win32", env: { WT_SESSION: "a-guid" } })).toBe(true);
    expect(mouseDefaultForHost(true, { platform: "win32", env: { TERM_PROGRAM: "vscode" } })).toBe(true);
    expect(mouseDefaultForHost(true, { platform: "darwin", env: {} })).toBe(true);
    expect(mouseDefaultForHost(false, { platform: "linux", env: {} })).toBe(false);
  });

  it("follows ATOMIC_AGENT_CONHOST_GUARD=0 back to the configured value", () => {
    expect(mouseDefaultForHost(true, { platform: "win32", env: { ATOMIC_AGENT_CONHOST_GUARD: "0" } })).toBe(true);
  });
});

describe("legacyConhostStartupHint", () => {
  it("recommends Windows Terminal on a legacy conhost", () => {
    const hint = legacyConhostStartupHint({ platform: "win32", env: {} });
    expect(hint).toBe(
      "Tip: this is the classic Windows console. The UI works here, but " +
        "looks better in Windows Terminal (run `wt`). The mouse is off here " +
        "and works in Windows Terminal; `/mouse on` tries it anyway.",
    );
    expect(hint).not.toContain("ATOMIC_AGENT_CONHOST_GUARD");
    expect(hint).not.toContain("\u2014");
  });

  it("stays silent on a modern host", () => {
    expect(
      legacyConhostStartupHint({
        platform: "win32",
        env: { WT_SESSION: "a-guid" },
      }),
    ).toBeNull();
    expect(
      legacyConhostStartupHint({ platform: "darwin", env: {} }),
    ).toBeNull();
  });
});
