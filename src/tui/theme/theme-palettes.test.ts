import { describe, expect, it } from "vitest";
import { contrastRatio } from "./color-contrast.js";
import { THEMES, THEME_NAMES, type ThemeName, type TuiColors } from "./theme.js";

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

/**
 * `accentSoft` is a ground and `accent` is the ink read on top of it.
 * A component that reaches for `accentSoft` to paint text inherits
 * whatever contrast the palette picked for a fill — on the house
 * palette that put whole screens near 2:1. These pin the property call
 * sites rely on, measured against the ground the text actually lands
 * on: the canonical page of the terminal theme each palette was mapped
 * from. The TUI never paints the page — the terminal owns it — so the
 * theme has no token for it and the table lives here, in the one place
 * that needs a number for "the background this palette was designed
 * against". A new palette adds one row (the compiler asks for it);
 * nothing below pins how many palettes exist or how they relate.
 */
const CANONICAL_GROUND: Record<ThemeName, string> = {
  // The design's dark page — the tone the "lands around 2:1" figure in
  // theme-palettes.ts is measured against.
  "atomic-retro": "#0b0e14",
  // Primer bgColor-default, dark and light.
  "github-dark": "#0d1117",
  "github-light": "#ffffff",
  // Catppuccin `base`.
  "catppuccin-mocha": "#1e1e2e",
  "catppuccin-latte": "#eff1f5",
  // Dracula `Background`.
  dracula: "#282a36",
  // Nord `nord0` (Polar Night).
  nord: "#2e3440",
  // Tokyo Night `bg`.
  "tokyo-night": "#1a1b26",
  // Gruvbox `bg0`.
  "gruvbox-dark": "#282828",
  "gruvbox-light": "#fbf1c7",
  // Solarized `base03` / `base3`.
  "solarized-dark": "#002b36",
  "solarized-light": "#fdf6e3",
};

describe("accent is ink, accentSoft is a fill", () => {
  for (const name of THEME_NAMES) {
    const c = THEMES[name].colors;
    const ground = CANONICAL_GROUND[name];

    it(`${name}: moving text from accentSoft to accent never loses contrast`, () => {
      // The invariant every call site leans on: painting text with
      // `accent` reads at least as well as the fill would have. It
      // fails in the regression's direction — an `accent` that is the
      // dimmer of the pair — and cannot fail merely because a new
      // palette gives its fill a value of its own.
      expect(contrastRatio(c.accent, ground)).toBeGreaterThanOrEqual(
        contrastRatio(c.accentSoft, ground),
      );
    });

    it(`${name}: accent is readable on the palette's own page`, () => {
      // 3:1 is WCAG's floor for large/bold text and UI glyphs, and the
      // wizard titles are bold. Not 4.5: three upstream palettes ship
      // accents below AA on their own canonical page (solarized-light
      // is 3.4:1) — the source theme's choice, not our regression. A
      // fill-dark accent, the bug this guards, lands nearer 2.
      expect(contrastRatio(c.accent, ground)).toBeGreaterThanOrEqual(3);
    });
  }

  it("the house palette's ink clears AA where its fill does not", () => {
    // The regression that actually shipped: cloud setup screens painted
    // text in the `#294793` fill, at 2.2:1 on the page. Pinned on the
    // house palette by name, so a legitimate new palette cannot trip it.
    const c = THEMES["atomic-retro"].colors;
    const ground = CANONICAL_GROUND["atomic-retro"];
    expect(contrastRatio(c.accent, ground)).toBeGreaterThan(4.5);
    expect(contrastRatio(c.accentSoft, ground)).toBeLessThan(3);
  });
});
