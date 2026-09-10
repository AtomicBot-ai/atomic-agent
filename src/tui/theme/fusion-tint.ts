import { mixColor } from "./mix-color.js";
import { readableOn } from "./readable-foreground.js";
import { theme, type TuiTheme } from "./theme.js";

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

/**
 * How far the fusion surfaces are pulled toward black.
 *
 * Fusion does not merely tint the composer, it re-skins it: black
 * ground, white text, orange accents. The blue the rest of the app runs
 * on is the *ordinary* state, and leaving it under an orange chip made
 * the mode look like a badge stuck on the normal composer rather than a
 * different mode. Two steps rather than one so the toolbar still reads
 * as a strip against the field above it — the same two-tone relationship
 * `railBackground` and `badgeBackground` have, rebuilt in black.
 *
 * A trace of the palette's orange is left in both (they are mixed from
 * `warnStrong`, not from a literal black) so the surface is warm rather
 * than dead, and so a palette with a different orange gets a surface
 * that belongs to it.
 */
export const FUSION_BAR_MIX = 0.78;
export const FUSION_PANEL_MIX = 0.94;

/** Ground of the composer's toolbar strip while fusion is the route. */
export function fusionBarGround(palette: TuiTheme = theme): string {
  return mixColor(palette.colors.warnStrong, "#000000", FUSION_BAR_MIX);
}

/** Ground of the composer's input panel while fusion is the route. */
export function fusionPanelGround(palette: TuiTheme = theme): string {
  return mixColor(palette.colors.warnStrong, "#000000", FUSION_PANEL_MIX);
}

/** Text on a fusion surface: measured, so it is the white end of the pair. */
export function fusionSurfaceInk(palette: TuiTheme = theme): string {
  return readableOn(fusionBarGround(palette));
}

/** The quiet ink on a fusion surface — separators, second-column detail. */
export function fusionSurfaceMuted(palette: TuiTheme = theme): string {
  return mixColor(fusionSurfaceInk(palette), fusionBarGround(palette), 0.45);
}

/**
 * The fusion chip: `warnStrong` as a ground with measured ink on top.
 *
 * `palette` is the theme to read it from, and inside a popup it MUST be
 * `chromeTheme`. The page proxy collapses every non-ground role to
 * `muted` while a backdrop is dimmed (`setBackdropDimmed`), and the
 * chip's orange is a foreground role — so read through the page proxy
 * the one control the mode exists to advertise turns grey exactly when
 * the operator has the switch open and is looking straight at it.
 * `chromeTheme` ignores dimming, which is why every other pixel of the
 * popup already reads from it.
 */
export function fusionChipColors(palette: TuiTheme = theme): {
  background: string;
  ink: string;
} {
  const background = palette.colors.warnStrong;
  return { background, ink: readableOn(background) };
}

/**
 * The composer's panel ground while fusion is the route.
 *
 * Kept as the name every consumer already imports; the recipe moved from
 * "badge ground tinted orange" to the black surface above, because half
 * the block turning warm-navy while the other half went black read as a
 * rendering fault rather than a theme.
 */
export function fusionComposerGround(): string {
  return fusionPanelGround();
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
