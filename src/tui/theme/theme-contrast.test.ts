import { describe, expect, it } from "vitest";
import { contrastRatio } from "./color-contrast.js";
import { mixColor } from "./mix-color.js";
import { parseHexColor } from "./parse-hex-color.js";
import { CANONICAL_PAGE } from "./theme-palettes.js";
import { THEMES, THEME_NAMES, type ThemeName, type TuiColors } from "./theme.js";

/**
 * The contrast gate.
 *
 * Every palette is walked against every ground the UI actually paints it
 * on, and a pair that cannot be read fails the build. This exists
 * because the registry it replaced could not have passed it: 154 of its
 * 396 pairs were below the line, including `assistant` on the rail at
 * **1.09:1** on `github-dark` and `warn` on the rail at **1.12:1** on
 * `catppuccin-mocha` — light text on a light ground, in the composer's
 * status bar, on two of the most-used themes.
 *
 * The old theme tests could not catch that. They checked `accent`
 * against the page and the chip ramp against the chip's own ink, which
 * is two pairs out of thirty-three, and they checked the *hex values*
 * of eleven upstream palettes against their upstream sources — pinning
 * that the transcription was faithful, which was never the question.
 * The question is whether the app can be read.
 *
 * ## Thresholds
 *
 * - **4.5:1** for anything read as text. WCAG 2.x AA for body copy, and
 *   a terminal draws everything at body size.
 * - **1.5:1** for chrome that is looked at rather than read: `border`
 *   and `accentSoft`, which draw hairlines and fills. Holding a
 *   one-cell rule to AA would make it a wall. The floor is not zero,
 *   though — a border indistinguishable from the page is not a border.
 */

/** WCAG AA for body text. */
const AA = 4.5;
/** Chrome only has to be *visible*, not readable. */
const VISIBLE = 1.5;

/** Roles painted as text on the terminal's own background. */
const INK_ON_PAGE: readonly (keyof TuiColors)[] = [
  "user",
  "assistant",
  "system",
  "reasoning",
  "tool",
  "toolOk",
  "toolError",
  "accent",
  "accentAlt",
  "muted",
  "error",
  "warn",
  "warnStrong",
  "success",
  "info",
  "brandMark",
  "brandFace",
];

/** Roles that draw a line or a fill on the page rather than words. */
const CHROME_ON_PAGE: readonly (keyof TuiColors)[] = ["border", "accentSoft"];

/** Roles painted as text on the rail ground (`railBackground`). */
const INK_ON_RAIL: readonly (keyof TuiColors)[] = [
  "railForeground",
  "railMuted",
  "railAccent",
  "railSuccess",
  "railWarn",
  "railError",
];

/**
 * `readableOn`'s rule, inlined rather than imported: the real one reads
 * the *active* theme through the proxy, and this walks all six without
 * mounting any of them.
 */
function inkFor(colors: TuiColors, ground: string): string {
  return contrastRatio(ground, colors.chipBackground) >=
    contrastRatio(ground, colors.chipForeground)
    ? colors.chipBackground
    : colors.chipForeground;
}

/** Luminance side of the line, for the "rail is not an inversion" check. */
function isDark(hex: string): boolean {
  const rgb = parseHexColor(hex);
  if (!rgb) return false;
  return (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255 < 0.5;
}

function expectContrast(fg: string, bg: string, floor: number): void {
  const ratio = contrastRatio(fg, bg);
  // The message carries both hexes: a failure here is read by whoever is
  // editing the palette, and "2.48:1" alone does not say which two
  // colours to move.
  expect(
    ratio,
    `${fg} on ${bg} is ${ratio.toFixed(2)}:1, needs ${floor}:1`,
  ).toBeGreaterThanOrEqual(floor);
}

describe("theme contrast", () => {
  it("registers exactly the six designed palettes", () => {
    expect([...THEME_NAMES]).toEqual([
      "classic-dark",
      "classic-light",
      "toxic-green",
      "khorne-red",
      "darky-dark",
      "moon-yellow",
    ]);
    expect(Object.keys(THEMES).sort()).toEqual([...THEME_NAMES].sort());
  });

  for (const name of THEME_NAMES) {
    describe(name, () => {
      const c = THEMES[name].colors;
      const page = CANONICAL_PAGE[name] as string;

      it("declares the page it is designed against", () => {
        expect(page).toMatch(/^#[0-9a-f]{6}$/);
      });

      it("uses valid 6-digit lowercase hex for every token", () => {
        for (const [key, value] of Object.entries(c)) {
          expect(value, `${key} is not a hex colour`).toMatch(
            /^#[0-9a-f]{6}$/,
          );
        }
      });

      it("every text role is readable on the page", () => {
        for (const key of INK_ON_PAGE) expectContrast(c[key], page, AA);
      });

      it("chrome is visible on the page without shouting", () => {
        for (const key of CHROME_ON_PAGE) expectContrast(c[key], page, VISIBLE);
      });

      it("every rail role is readable on the rail ground", () => {
        for (const key of INK_ON_RAIL) {
          expectContrast(c[key], c.railBackground, AA);
        }
      });

      it("the rail is a surface, not an inversion", () => {
        // The bug this replaces: the rail flipped polarity, so a
        // component that reached for a page token — and several did —
        // painted light on light. Keeping the rail on the page's own
        // side of the line means the worst such a mistake can now
        // produce is *low* contrast, never *inverted* contrast.
        expect(
          isDark(c.railBackground),
          `rail ${c.railBackground} is on the opposite side of the line from page ${page}`,
        ).toBe(isDark(page));
        // …but it still has to be a distinguishable surface, or there
        // is no sidebar, only a wider document.
        expect(c.railBackground).not.toBe(page);
        expectContrast(c.railBackground, page, 1.05);
      });

      it("badge and chip grounds carry their own ink", () => {
        expectContrast(c.chipForeground, c.chipBackground, AA);
        expectContrast(c.accent, c.badgeBackground, AA);
        expectContrast(c.muted, c.badgeBackground, AA);
      });

      it("every step of the context chip's ramp keeps its ink", () => {
        // `context-chip.tsx` mixes `accent` toward the rail ground at
        // 0.6 / 0.3 / 0 and picks ink with `readableOn`. All three
        // steps, plus the violet trimmed state, are grounds this app
        // paints — so all four are pairs this gate owns.
        const grounds = [
          mixColor(c.accent, c.railBackground, 0.6),
          mixColor(c.accent, c.railBackground, 0.3),
          c.accent,
          c.accentAlt,
        ];
        for (const ground of grounds) {
          expectContrast(inkFor(c, ground), ground, AA);
        }
      });
    });
  }
});
