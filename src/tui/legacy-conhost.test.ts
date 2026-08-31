import { describe, expect, it } from "vitest";

import {
  clampRowsForLegacyConhost,
  isLegacyConhost,
  legacyConhostStartupHint,
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

describe("legacyConhostStartupHint", () => {
  it("recommends Windows Terminal on a legacy conhost", () => {
    const hint = legacyConhostStartupHint({ platform: "win32", env: {} });
    expect(hint).toContain("Windows Terminal");
    expect(hint).toContain("ATOMIC_AGENT_CONHOST_GUARD=0");
  });

  it("stays silent on a modern host", () => {
    expect(
      legacyConhostStartupHint({
        platform: "win32",
        env: { WT_SESSION: "a-guid" },
      }),
    ).toBeNull();
    expect(legacyConhostStartupHint({ platform: "darwin", env: {} })).toBeNull();
  });
});
