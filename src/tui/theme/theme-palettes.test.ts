import { describe, expect, it } from "vitest";
import { THEMES, type ThemeName, type TuiColors } from "./theme.js";

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

// Signature hexes per theme, taken from each theme's canonical/official
// source. We assert the semantic anchors (accent / success / error / warn /
// warnStrong / reasoning) so a typo in the palette file is caught, and the
// uniform role->token mapping (info==accent, toolError==error, …) is pinned.
const SIGNATURES: Record<
  Exclude<ThemeName, "github-dark" | "github-light">,
  Pick<TuiColors, "accent" | "success" | "error" | "warn" | "warnStrong" | "reasoning">
> = {
  "catppuccin-mocha": {
    accent: "#89b4fa",
    success: "#a6e3a1",
    error: "#f38ba8",
    warn: "#f9e2af",
    warnStrong: "#fab387",
    reasoning: "#cba6f7",
  },
  "catppuccin-latte": {
    accent: "#1e66f5",
    success: "#40a02b",
    error: "#d20f39",
    warn: "#df8e1d",
    warnStrong: "#fe640b",
    reasoning: "#8839ef",
  },
  dracula: {
    accent: "#bd93f9",
    success: "#50fa7b",
    error: "#ff5555",
    warn: "#f1fa8c",
    warnStrong: "#ffb86c",
    reasoning: "#ff79c6",
  },
  nord: {
    accent: "#88c0d0",
    success: "#a3be8c",
    error: "#bf616a",
    warn: "#ebcb8b",
    warnStrong: "#d08770",
    reasoning: "#b48ead",
  },
  "tokyo-night": {
    accent: "#7aa2f7",
    success: "#9ece6a",
    error: "#f7768e",
    warn: "#e0af68",
    warnStrong: "#ff9e64",
    reasoning: "#bb9af7",
  },
  "gruvbox-dark": {
    accent: "#83a598",
    success: "#b8bb26",
    error: "#fb4934",
    warn: "#fabd2f",
    warnStrong: "#fe8019",
    reasoning: "#d3869b",
  },
  "gruvbox-light": {
    accent: "#076678",
    success: "#79740e",
    error: "#9d0006",
    warn: "#b57614",
    warnStrong: "#af3a03",
    reasoning: "#8f3f71",
  },
  "solarized-dark": {
    accent: "#268bd2",
    success: "#859900",
    error: "#dc322f",
    warn: "#b58900",
    warnStrong: "#cb4b16",
    reasoning: "#6c71c4",
  },
  "solarized-light": {
    accent: "#268bd2",
    success: "#859900",
    error: "#dc322f",
    warn: "#b58900",
    warnStrong: "#cb4b16",
    reasoning: "#6c71c4",
  },
};

describe("third-party theme palettes", () => {
  for (const [name, sig] of Object.entries(SIGNATURES) as [
    ThemeName,
    (typeof SIGNATURES)[keyof typeof SIGNATURES],
  ][]) {
    describe(name, () => {
      const c = THEMES[name].colors;

      it("uses valid 6-digit hex for every colour key", () => {
        for (const key of COLOR_KEYS) {
          expect(c[key]).toMatch(/^#[0-9a-f]{6}$/);
        }
      });

      it("matches the canonical signature hexes", () => {
        expect(c.accent).toBe(sig.accent);
        expect(c.success).toBe(sig.success);
        expect(c.error).toBe(sig.error);
        expect(c.warn).toBe(sig.warn);
        expect(c.warnStrong).toBe(sig.warnStrong);
        expect(c.reasoning).toBe(sig.reasoning);
      });

      it("applies the uniform role->token mapping", () => {
        expect(c.user).toBe(c.accent);
        expect(c.tool).toBe(c.accent);
        expect(c.accentSoft).toBe(c.accent);
        expect(c.info).toBe(c.accent);
        expect(c.toolOk).toBe(c.success);
        expect(c.assistant).toBe(c.success);
        expect(c.toolError).toBe(c.error);
        expect(c.muted).toBe(c.system);
      });
    });
  }
});
