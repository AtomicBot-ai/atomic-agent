import { mixColor } from "./mix-color.js";
import { readableOn } from "./readable-foreground.js";
import { theme } from "./theme.js";

/**
 * The orange the Fusion run mode is painted in.
 *
 * Derived, not a seventh palette token: `warnStrong` already IS each
 * palette's orange — picked to be read on the page and AA-gated as such
 * in `theme-contrast.test.ts` — and six hand-tuned hexes for a second
 * orange would be twelve more pairs to gate for no new information. A
 * palette whose `warnStrong` leans tan (darky-dark) gets a tan fusion
 * tint, which is that palette's orange and consistent with its own
 * warn badges.
 *
 * Everything here reads through the `theme` proxy at call time, so a
 * `/theme` swap and the menu's backdrop dimming both take effect on the
 * next render without any consumer holding a stale colour.
 */

/**
 * Share of `badgeBackground` mixed into `warnStrong` for the composer's
 * fusion ground. Picked by the contrast gate, not by eye: high enough
 * that `readableOn` still finds AA ink on the result, low enough that
 * the tint reads against the plain `badgeBackground` next to it.
 */
export const FUSION_GROUND_FADE = 0.65;

/** The fusion chip: `warnStrong` as a ground with measured ink on top. */
export function fusionChipColors(): { background: string; ink: string } {
  const background = theme.colors.warnStrong;
  return { background, ink: readableOn(background) };
}

/**
 * The composer's panel ground while fusion is the route — the plain
 * `badgeBackground` pulled toward the palette's orange.
 */
export function fusionComposerGround(): string {
  return mixColor(theme.colors.warnStrong, theme.colors.badgeBackground, FUSION_GROUND_FADE);
}

/**
 * Ink for fusion-tinted text and borders drawn on the page: bubble
 * borders and the `AGENT` label. Page ink only — never paint this on the
 * rail ground (`composer-meta-controls.tsx` documents that trap; the
 * chip form above is how the word reaches the rail).
 */
export function fusionInk(): string {
  return theme.colors.warnStrong;
}
