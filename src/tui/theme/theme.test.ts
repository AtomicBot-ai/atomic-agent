import { afterEach, describe, expect, it } from "vitest";
import {
  THEMES,
  THEME_NAMES,
  getActiveTheme,
  getActiveThemeName,
  isThemeName,
  setActiveTheme,
  theme,
  type TuiColors,
} from "./theme.js";

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

describe("theme proxy", () => {
  afterEach(() => {
    // Restore the module default so test order does not leak.
    setActiveTheme(THEMES["github-dark"]);
  });

  it("forwards reads to the active theme and updates after a swap", () => {
    setActiveTheme(THEMES["github-dark"]);
    expect(theme.colors.accent).toBe(THEMES["github-dark"].colors.accent);

    setActiveTheme(THEMES["github-light"]);
    expect(theme.colors.accent).toBe(THEMES["github-light"].colors.accent);
    expect(theme.colors.accent).toBe("#0969da");
  });

  it("reflects swaps for glyphs and spinner too (shared, but proxied)", () => {
    setActiveTheme(THEMES["github-light"]);
    expect(theme.glyphs.promptCaret).toBe("❯");
    expect(theme.spinnerFrames.length).toBeGreaterThan(0);
  });

  it("getActiveTheme returns the current backing object", () => {
    setActiveTheme(THEMES["github-dark"]);
    expect(getActiveTheme()).toBe(THEMES["github-dark"]);
  });

  it("every registered theme defines all 16 colour keys", () => {
    for (const named of Object.values(THEMES)) {
      for (const key of COLOR_KEYS) {
        expect(typeof named.colors[key]).toBe("string");
        expect(named.colors[key].length).toBeGreaterThan(0);
      }
    }
  });

  it("THEME_NAMES lists exactly the registered theme keys", () => {
    expect([...THEME_NAMES].sort()).toEqual(Object.keys(THEMES).sort());
  });

  it("isThemeName accepts registered names and rejects others", () => {
    expect(isThemeName("dracula")).toBe(true);
    expect(isThemeName("nord")).toBe(true);
    expect(isThemeName("not-a-theme")).toBe(false);
    expect(isThemeName("")).toBe(false);
  });

  it("getActiveThemeName reverse-maps the active backing object", () => {
    setActiveTheme(THEMES["tokyo-night"]);
    expect(getActiveThemeName()).toBe("tokyo-night");
    setActiveTheme(THEMES["solarized-light"]);
    expect(getActiveThemeName()).toBe("solarized-light");
  });
});
