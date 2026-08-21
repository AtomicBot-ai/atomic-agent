import { afterAll, describe, expect, it } from "vitest";
import { groundFor } from "../components/context-chip.js";
import type { ContextUsageView } from "../select-context-usage.js";
import { contrastRatio } from "./color-contrast.js";
import { readableOn } from "./readable-foreground.js";
import {
  getActiveTheme,
  setActiveTheme,
  THEMES,
  THEME_NAMES,
  theme,
} from "./theme.js";

const original = getActiveTheme();
afterAll(() => setActiveTheme(original));

function usage(percent: number, droppedTurns = 0): ContextUsageView {
  return {
    tokens: 1000,
    contextWindow: 10_000,
    percent,
    conversationTokens: percent * 10,
    conversationCap: 1000,
    conversationPercent: percent,
    capSource: "config",
    droppedTurns,
    sections: [],
  };
}

describe("readableOn", () => {
  /**
   * The load-bearing test for the context chip's colour ramp.
   *
   * The floor is 3.0 — WCAG AA for bold text, which is what the chip
   * paints. It cannot be 4.5 for every state: the `high` step *is* the
   * palette's `accent` and the `trimmed` step *is* its `accentAlt`, and
   * on `solarized-light` the accent bottoms out at 3.53:1 against either
   * ink. Repainting twelve palettes' accents to satisfy body-text AA is
   * not this chip's call to make.
   *
   * The two mixed steps are a different matter — those colours are ours,
   * derived by `FADE_LOW` / `FADE_MID` — so they are held to the full
   * 4.5, and that is what fixes those two constants.
   */
  it("keeps every chip state readable on every palette", () => {
    const states: readonly [string, ContextUsageView, number][] = [
      ["low", usage(10), 4.5],
      ["mid", usage(50), 4.5],
      ["high", usage(90), 3],
      ["trimmed", usage(100, 3), 3],
    ];
    for (const name of THEME_NAMES) {
      setActiveTheme(THEMES[name]);
      for (const [label, view, floor] of states) {
        const ground = groundFor(view);
        const ink = readableOn(ground);
        expect(
          contrastRatio(ground, ink),
          `${name}/${label} ${ground} on ${ink}`,
        ).toBeGreaterThanOrEqual(floor);
      }
    }
  });

  /**
   * The property the ramp leans on: whatever ground it produces,
   * `readableOn` returns whichever of the palette's two inks actually
   * reads better on it. A luminance threshold got this wrong in the
   * middle of the ramp, which is where the ramp lives.
   */
  it("always returns the higher-contrast ink of the pair", () => {
    for (const name of THEME_NAMES) {
      setActiveTheme(THEMES[name]);
      for (const view of [usage(10), usage(50), usage(90), usage(100, 3)]) {
        const ground = groundFor(view);
        const chosen = readableOn(ground);
        const other =
          chosen === theme.colors.chipBackground
            ? theme.colors.chipForeground
            : theme.colors.chipBackground;
        expect(
          contrastRatio(ground, chosen),
          `${name} ${ground}`,
        ).toBeGreaterThanOrEqual(contrastRatio(ground, other));
      }
    }
  });

  it("picks the light end of the pair for a dark ground, and vice versa", () => {
    setActiveTheme(THEMES["github-dark"]);
    const onDark = readableOn("#0d1117");
    const onLight = readableOn("#f6f8fa");
    expect(onDark).not.toBe(onLight);
    expect([theme.colors.chipBackground, theme.colors.chipForeground]).toContain(
      onDark,
    );
  });

  /**
   * Ink accepts named and ANSI-indexed colours too. We cannot weigh
   * those, and a render is the wrong place to throw, so the page's own
   * ink stands in.
   */
  it("falls back to the page ink for a colour it cannot weigh", () => {
    setActiveTheme(THEMES["github-dark"]);
    expect(readableOn("blue")).toBe(theme.colors.chipForeground);
  });
});
