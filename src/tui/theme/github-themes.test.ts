import { describe, expect, it } from "vitest";
import { THEMES, type TuiColors } from "./theme.js";

const COLOR_KEYS: (keyof TuiColors)[] = [
  "user",
  "assistant",
  "system",
  "reasoning",
  "tool",
  "toolOk",
  "toolError",
  "accent",
  "accentSoft",
  "border",
  "muted",
  "error",
  "warn",
  "warnStrong",
  "success",
  "info",
];

describe("github themes", () => {
  it("github-dark defines all 16 colour keys with the documented Primer hexes", () => {
    const c = THEMES["github-dark"].colors;
    for (const key of COLOR_KEYS) {
      expect(c[key]).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(c.accent).toBe("#4493f8");
    expect(c.user).toBe("#4493f8");
    expect(c.tool).toBe("#4493f8");
    expect(c.info).toBe("#4493f8");
    expect(c.assistant).toBe("#3fb950");
    expect(c.toolOk).toBe("#3fb950");
    expect(c.success).toBe("#3fb950");
    expect(c.reasoning).toBe("#ab7df8");
    expect(c.toolError).toBe("#f85149");
    expect(c.error).toBe("#f85149");
    expect(c.warn).toBe("#d29922");
    expect(c.warnStrong).toBe("#db6d28");
    expect(c.muted).toBe("#9198a1");
    expect(c.system).toBe("#9198a1");
    expect(c.border).toBe("#3d444d");
  });

  it("github-light defines all 16 colour keys with the documented Primer hexes", () => {
    const c = THEMES["github-light"].colors;
    for (const key of COLOR_KEYS) {
      expect(c[key]).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(c.accent).toBe("#0969da");
    expect(c.user).toBe("#0969da");
    expect(c.tool).toBe("#0969da");
    expect(c.info).toBe("#0969da");
    expect(c.assistant).toBe("#1a7f37");
    expect(c.toolOk).toBe("#1a7f37");
    expect(c.success).toBe("#1a7f37");
    expect(c.reasoning).toBe("#8250df");
    expect(c.toolError).toBe("#d1242f");
    expect(c.error).toBe("#d1242f");
    expect(c.warn).toBe("#9a6700");
    expect(c.warnStrong).toBe("#bc4c00");
    expect(c.muted).toBe("#59636e");
    expect(c.system).toBe("#59636e");
    expect(c.border).toBe("#d1d9e0");
  });
});
