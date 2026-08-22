import chalk from "chalk";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ORBIT_GLYPH } from "../onboarding/intro-art.js";
import { computeOnboardingFit } from "../onboarding/onboarding-fit.js";
import { parseHexColor } from "../theme/parse-hex-color.js";
import {
  getActiveTheme,
  setActiveTheme,
  THEMES,
  type TuiTheme,
} from "../theme/theme.js";
import { OnboardingIntroStep } from "./onboarding-intro-step.js";

/** The truecolor SGR Ink emits for a hex foreground, e.g. `ESC[38;2;r;g;bm`. */
function foregroundSgr(hex: string): string {
  const rgb = parseHexColor(hex);
  if (!rgb) throw new Error(`unparseable palette colour: ${hex}`);
  return `\u001b[38;2;${rgb.r};${rgb.g};${rgb.b}m`;
}

/** Start of the wordmark's first row — enough to find its frame line. */
const WORDMARK_FRAGMENT = "▄▀█ ▀█▀";

/**
 * The intro's colour ramp, asserted on the house palette because it is
 * the only one of the twelve where `accent` and `accentSoft` differ.
 *
 * `ink-testing-library` renders at chalk level 0, which drops every SGR
 * sequence before `lastFrame()` sees it, so the level is raised for
 * this block and put back afterwards.
 */
describe("OnboardingIntroStep colours", () => {
  const house = THEMES["atomic-retro"].colors;
  let previousTheme: TuiTheme;
  let previousLevel: typeof chalk.level;

  beforeEach(() => {
    previousTheme = getActiveTheme();
    previousLevel = chalk.level;
    setActiveTheme(THEMES["atomic-retro"]);
    chalk.level = 3;
  });

  afterEach(() => {
    setActiveTheme(previousTheme);
    chalk.level = previousLevel;
  });

  function intro() {
    // 100×32 is the full tier: md mark, 14-cross ring, wordmark. The
    // wordmark paints on the first frame and `skipAnimation` finishes
    // the tagline instantly, so no waiting on frames is needed.
    return render(
      <OnboardingIntroStep
        columns={100}
        rows={32}
        fit={computeOnboardingFit({ columns: 100, rows: 32 })}
        skipAnimation
      />,
    );
  }

  function lineWith(frame: string, needle: string): string {
    const line = frame.split("\n").find((row) => row.includes(needle));
    if (line === undefined) throw new Error(`no frame line contains ${needle}`);
    return line;
  }

  it("paints the wordmark in the text-safe accent, not the fill", () => {
    // The wordmark is the product's name — text, so it must clear the
    // ramp text clears. `accentSoft` here was the unreadable ~2:1.
    const frame = intro().lastFrame() ?? "";
    const row = lineWith(frame, WORDMARK_FRAGMENT);
    expect(row).toContain(foregroundSgr(house.accent));
    expect(row).not.toContain(foregroundSgr(house.accentSoft));
  });

  it("keeps the ring's crosses on the dim fill, as decoration", () => {
    // Deliberate: the crosses are the mark shrunk past legibility, the
    // deepest layer of the composition. Lifted to `accent` they would
    // sit at the wordmark's own brightness and compete with real text.
    const frame = intro().lastFrame() ?? "";
    const ring = lineWith(frame, ORBIT_GLYPH);
    expect(ring).toContain(foregroundSgr(house.accentSoft));
  });
});
