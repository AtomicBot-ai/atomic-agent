/**
 * Brand-mark artwork: the Atomic cross at four scales, in two stroke
 * systems, plus a dedicated rail mark.
 *
 * GENERATED FROM `assets/logo.svg` by `scripts/generate-logo-art.mjs`.
 * Do not hand-edit — redraw the SVG and regenerate.
 * `logo-art.generated.test.ts` fails if this file drifts from the source.
 *
 * **Why separate drawings instead of one scaled at runtime.** These
 * marks carry depth in up to three tones — face, extruded wall, cast
 * shadow. The rasteriser this replaced scaled one drawing by first
 * flattening it to a boolean ink mask, in which every non-space glyph
 * counts as ink; run these through it and `#`, `+` and `.` collapse
 * into one solid blob with the depth gone. Tone has to be re-decided per
 * size, not resampled.
 *
 * The ladder is quantized rather than continuous anyway: the arm is
 * exactly a quarter of the bounding box and must be a whole number of
 * cells, so the usable sizes are fixed points with nothing to
 * interpolate between.
 *
 * Geometry rules the artwork obeys, should the SVG ever be redrawn:
 *
 * - The concave fillet is in the **top-left** and **bottom-right**
 *   quadrants only. Top-right and bottom-left are straight segments
 *   meeting at a hard 90°. The mark is 180°-symmetric, not 4-fold, so
 *   mirroring or v-flipping it yields a *different* logo.
 * - The fillets leave each arm edge tangentially: the arms stay
 *   parallel-sided near the tips and flare only toward the centre.
 * - Depth sweeps bottom-right (observer there, light from the top-left)
 *   at a true 45° *on screen* — which at a ~2.2:1 cell aspect means
 *   ~2.2 columns per row, not one.
 */

/** Which drawing to use. A bigger scale is not a scaled-up smaller one. */
export type MarkScale = "lg" | "md" | "sm" | "xs";

/**
 * Glyph system. `block` uses Unicode block elements; `ascii` stays in
 * plain ASCII so it survives `TERM=dumb`, CI log scrapes and non-UTF-8
 * locales.
 */
export type MarkStroke = "block" | "ascii";

export type MarkArt = Readonly<Record<MarkScale, readonly string[]>>;

/**
 * Glyphs that draw a mark's front plane, sub-cell face ink included —
 * SM's fillets, XS's half-cell bar. Everything else in the art is
 * depth (extruded wall, cast shadow) or blank. Exported from here so
 * every renderer colours the same glyphs as face instead of keeping a
 * private copy that drifts when the art gains a glyph.
 */
export const FACE_GLYPHS: ReadonlySet<string> = new Set([
  "#",
  "\u2588", // █ full block
  "\u2597", // ▗ SM/XS concave fillet, top-left
  "\u2598", // ▘ SM/XS concave fillet, bottom-right
  "\u2584", // ▄ lower half block — XS bar, top row
  "\u2580", // ▀ upper half block — XS bar, bottom row
]);

/** `█` face, `▓` wall, `░` shadow. */
const BLOCK: MarkArt = {
  // 51 x 24
  lg: [
    "                 ███████████▓",
    "                 ███████████▓▓▓",
    "                ████████████▓▓▓▓",
    "               █████████████▓▓▓▓░░",
    "              ██████████████▓▓▓▓░░",
    "            ████████████████▓▓▓▓░░",
    "          ██████████████████▓▓▓▓░░",
    "      ██████████████████████▓▓▓▓░░",
    "█████████████████████████████████████████████▓",
    "█████████████████████████████████████████████▓▓▓",
    "█████████████████████████████████████████████▓▓▓▓",
    "█████████████████████████████████████████████▓▓▓▓░░",
    "█████████████████████████████████████████████▓▓▓▓░░",
    "  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓██████████████████████▓▓▓▓▓▓▓▓▓▓░░",
    "    ▓▓▓▓▓▓▓▓▓▓▓▓▓██████████████████▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░",
    "      ░░░░░░░░░░░████████████████▓▓▓▓▓▓▓▓▓▓░░░░░░░░",
    "                 ██████████████▓▓▓▓▓▓▓▓░░░░░░",
    "                 █████████████▓▓▓▓▓▓▓░░░░",
    "                 ████████████▓▓▓▓▓▓░░░░",
    "                 ███████████▓▓▓▓▓▓░░░",
    "                 ███████████▓▓▓▓▓░░░",
    "                   ▓▓▓▓▓▓▓▓▓▓▓▓▓░░░",
    "                     ▓▓▓▓▓▓▓▓▓▓▓░░",
    "                       ░░░░░░░░░░░",
  ],
  // 31 x 14
  md: [
    "           ███████░",
    "          ████████░░",
    "         █████████░░",
    "        ██████████░░",
    "     █████████████░░",
    "█████████████████████████████░",
    "█████████████████████████████░░",
    "█████████████████████████████░░",
    "  ░░░░░░░░░█████████████░░░░░░░",
    "           ██████████░░░░░",
    "           █████████░░░",
    "           ████████░░░",
    "           ███████░░░",
    "             ░░░░░░░",
  ],
  // 6 x 3
  sm: [
    " ▗█░",
    "█████░",
    "  █▘░",
  ],
  // 4 x 2
  xs: [
    "▗█▄░",
    "▀█▘░",
  ],
};

/** `#` face, `+` wall, `.` shadow. */
const ASCII: MarkArt = {
  // 51 x 24
  lg: [
    "                 ###########+",
    "                 ###########+++",
    "                ############++++",
    "               #############++++..",
    "              ##############++++..",
    "            ################++++..",
    "          ##################++++..",
    "      ######################++++..",
    "#############################################+",
    "#############################################+++",
    "#############################################++++",
    "#############################################++++..",
    "#############################################++++..",
    "  +++++++++++++++######################++++++++++..",
    "    +++++++++++++##################++++++++++++++..",
    "      ...........################++++++++++........",
    "                 ##############++++++++......",
    "                 #############+++++++....",
    "                 ############++++++....",
    "                 ###########++++++...",
    "                 ###########+++++...",
    "                   +++++++++++++...",
    "                     +++++++++++..",
    "                       ...........",
  ],
  // 31 x 14
  md: [
    "           #######+",
    "          ########++",
    "         #########++",
    "        ##########++",
    "     #############++",
    "#############################+",
    "#############################++",
    "#############################++",
    "  +++++++++#############+++++++",
    "           ##########+++++",
    "           #########+++",
    "           ########+++",
    "           #######+++",
    "             +++++++",
  ],
  // 6 x 3
  sm: [
    "  #.",
    "#####.",
    "  #.",
  ],
  // 4 x 2
  xs: [
    " #.",
    "###.",
  ],
};

export const CROSS_MARKS: Readonly<Record<MarkStroke, MarkArt>> = {
  block: BLOCK,
  ascii: ASCII,
};
