import { describe, expect, it } from "vitest";

import { parseSurface, resolveSurface } from "./resolve-surface.js";

describe("resolveSurface", () => {
  it("prefers the explicit entry-point value", () => {
    expect(resolveSurface("tui", { ATOMIC_AGENT_SURFACE: "desktop" })).toBe(
      "tui",
    );
  });

  it("falls back to ATOMIC_AGENT_SURFACE from the environment", () => {
    expect(resolveSurface(undefined, { ATOMIC_AGENT_SURFACE: "desktop" })).toBe(
      "desktop",
    );
    expect(resolveSurface(undefined, { ATOMIC_AGENT_SURFACE: " TUI " })).toBe(
      "tui",
    );
  });

  it("defaults to cli and ignores unknown values", () => {
    expect(resolveSurface(undefined, {})).toBe("cli");
    expect(resolveSurface(undefined, { ATOMIC_AGENT_SURFACE: "/home/me" })).toBe(
      "cli",
    );
  });

  it("parseSurface narrows to the enum only", () => {
    expect(parseSurface("desktop")).toBe("desktop");
    expect(parseSurface("web")).toBeUndefined();
    expect(parseSurface(42)).toBeUndefined();
  });
});
