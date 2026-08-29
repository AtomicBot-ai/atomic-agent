import { contrastRatio } from "./color-contrast.js";
import { parseHexColor } from "./parse-hex-color.js";
import { theme } from "./theme.js";

/**
 * The palette's readable ink for a *coloured* ground.
 *
 * A static token cannot do this job. `accent` is deep blue on the light
 * palettes and pale blue on the dark ones, and a chip that ramps through
 * three steps of it changes polarity somewhere in the middle — so the
 * ink has to be decided from the ground actually being painted, not from
 * the theme's light/dark mode.
 *
 * The two candidates are `chipForeground` / `chipBackground`, the pair
 * the palette already guarantees to be opposite each other and to sit at
 * the two ends of its range. Picking by measured contrast rather than by
 * a luminance threshold matters: a mid-ramp blue can land just the wrong
 * side of any fixed midpoint and take the ink that reads at 4.4:1 while
 * the other one was sitting at 5:1.
 */
export function readableOn(background: string): string {
  const heavy = theme.colors.chipForeground;
  const light = theme.colors.chipBackground;
  // Unparseable ground (a named colour, an ANSI index): the chip is not
  // painting a surface we can reason about, so use the ink meant for the
  // page rather than guessing.
  if (!parseHexColor(background)) return heavy;
  return contrastRatio(background, light) >= contrastRatio(background, heavy)
    ? light
    : heavy;
}
