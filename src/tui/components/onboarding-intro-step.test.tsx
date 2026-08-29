import chalk from "chalk";
import { render } from "ink-testing-library";
import React from "react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { computeOnboardingFit } from "../onboarding/onboarding-fit.js";
import { parseHexColor } from "../theme/parse-hex-color.js";
import { theme } from "../theme/theme.js";
import { STAR_GLYPHS, starTierOfGlyph } from "../onboarding/star-tiers.js";
import { OnboardingIntroStep } from "./onboarding-intro-step.js";

/** One token of a frame: an SGR sequence, or a single character. */
const TOKEN = /\u001B\[[0-9;]*m|[^]/gu;
const SGR = /^\u001B\[[0-9;]*m$/u;
/** Sets a foreground colour, as opposed to bold, dim or a background. */
const FOREGROUND = /^\u001B\[(?:38;[25];[\d;]+|3[0-7]|9[0-7])m$/u;
const FOREGROUND_OFF = /^\u001B\[(?:0|39)m$/u;

const strip = (frame: string): string => frame.replace(/\u001B\[[0-9;]*m/gu, "");

/** The truecolor SGR Ink emits for a hex foreground, e.g. `ESC[38;2;r;g;bm`. */
function foregroundSgr(hex: string): string {
  const rgb = parseHexColor(hex);
  if (!rgb) throw new Error(`unparseable palette colour: ${hex}`);
  return `\u001b[38;2;${rgb.r};${rgb.g};${rgb.b}m`;
}

/** Rendering an Ink tree is slow enough that sizes are worth reusing. */
const frames = new Map<string, string>();

function frameAt(columns: number, rows: number): string {
  const key = `${columns}x${rows}`;
  const cached = frames.get(key);
  if (cached !== undefined) return cached;
  const view = render(
    <OnboardingIntroStep
      columns={columns - 4}
      // The screen hands the step its viewport, not the terminal: the
      // surface's top padding and the pinned footer are already gone.
      rows={rows - 2}
      fit={computeOnboardingFit({ columns, rows })}
      skipAnimation
    />,
  );
  const frame = view.lastFrame() ?? "";
  view.unmount();
  frames.set(key, frame);
  return frame;
}

/** The foreground each star glyph is actually painted in. */
function starColours(frame: string): Set<string> {
  const colours = new Set<string>();
  let current = "";
  for (const [token] of frame.matchAll(TOKEN)) {
    if (SGR.test(token)) {
      if (FOREGROUND.test(token)) current = token;
      else if (FOREGROUND_OFF.test(token)) current = "";
      continue;
    }
    if (starTierOfGlyph(token)) colours.add(current);
  }
  return colours;
}

describe("OnboardingIntroStep", () => {
  let level: typeof chalk.level;

  beforeAll(() => {
    // ink-testing-library renders at chalk level 0, which drops every SGR
    // sequence before `lastFrame()` sees it. What this file is for is
    // that brightness reaches the operator as colour, so it has to ask
    // for a terminal that has some.
    level = chalk.level;
    chalk.level = 3;
    frames.clear();
  });

  afterAll(() => {
    chalk.level = level;
  });

  it("paints a sky of several brightnesses, in a colour each", () => {
    const frame = frameAt(100, 30);
    for (const glyph of Object.values(STAR_GLYPHS)) {
      expect(strip(frame)).toContain(glyph);
    }
    const colours = starColours(frame);
    // Four tiers, four foregrounds, and none of them left in the
    // terminal's default — a sky in one colour is the diagram this
    // screen is getting away from.
    expect(colours.size).toBe(Object.keys(STAR_GLYPHS).length);
    expect(colours.has("")).toBe(false);
  });

  it("paints the wordmark in the text-safe accent, not the fill", () => {
    // The wordmark is the product's name — text, so it must clear the
    // ramp text clears. `accentSoft` here was the unreadable ~2:1.
    const frame = frameAt(100, 30);
    const row = frame
      .split("\n")
      .find((line) => strip(line).includes("\u2584\u2580\u2588 \u2580\u2588\u2580"));
    if (row === undefined) throw new Error("no frame line carries the wordmark");
    expect(row).toContain(foregroundSgr(theme.colors.accent));
    expect(row).not.toContain(foregroundSgr(theme.colors.accentSoft));
  });

  it("still draws the mark, the wordmark and the invitation", () => {
    const plain = strip(frameAt(100, 30));
    expect(plain).toContain("█");
    expect(plain).toContain("[ press any key to continue ]");
    expect(plain).toContain("Local AI-First Agent");
  });

  /**
   * Two rows belong to the screen around this block — its own top
   * padding and the pinned footer — and `frameAt` already keeps them
   * back, so the step must fit inside the viewport it was handed.
   * Anything past that paints over the rows above it, because Ink 7
   * overlaps rather than clips — and what it paints over first is the
   * footer.
   */
  const fitsIn = (columns: number, rows: number): void => {
    const lines = strip(frameAt(columns, rows)).split("\n");
    const overflow = Math.max(0, lines.length - (rows - 2));
    expect({ columns, rows, overflow }).toEqual({ columns, rows, overflow: 0 });
  };

  it("fits its rows, mark and all, at the sizes the flow opens at", () => {
    fitsIn(120, 40);
    fitsIn(100, 30);
    fitsIn(80, 24);
  });

  it("fits them on a terminal too small for the full treatment", () => {
    fitsIn(72, 18);
    fitsIn(64, 16);
  });

  it("thins the sky rather than dropping it on a small terminal", () => {
    const count = (frame: string): number =>
      [...strip(frame)].filter((glyph) => starTierOfGlyph(glyph)).length;
    expect(count(frameAt(72, 18))).toBeGreaterThan(0);
    expect(count(frameAt(120, 40))).toBeGreaterThan(count(frameAt(72, 18)) * 2);
  });
});
