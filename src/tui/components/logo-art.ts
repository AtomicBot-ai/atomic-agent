/**
 * Brand-mark artwork: the Atomic cross at three scales, in two stroke
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
export type MarkScale = "lg" | "md" | "sm";

/**
 * Glyph system. `block` uses Unicode block elements; `ascii` stays in
 * plain ASCII so it survives `TERM=dumb`, CI log scrapes and non-UTF-8
 * locales.
 */
export type MarkStroke = "block" | "ascii";

export type MarkArt = Readonly<Record<MarkScale, readonly string[]>>;

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
  // 9 x 5
  sm: [
    "   ██░",
    "  ███░",
    "████████░",
    "   ███░",
    "   ██░",
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
  // 9 x 5
  sm: [
    "   ##.",
    "  ###.",
    "########.",
    "   ###.",
    "   ##.",
  ],
};

export const CROSS_MARKS: Readonly<Record<MarkStroke, MarkArt>> = {
  block: BLOCK,
  ascii: ASCII,
};

/**
 * The rail's mark — 9 x 4.
 *
 * Its own drawing rather than {@link CROSS_MARKS}.block.sm, which is
 * five rows tall. The rail's row budget (`SIDEBAR_CHROME_ROWS`) is built
 * around a four-row mark, and spending a rail row on branding costs a
 * session row on every short terminal. Drawing the face with half-blocks
 * fits the same shape — flare included — into four rows.
 */
export const RAIL_ART: readonly string[] = [
  "   ██░",
  "▄▄███▄▄▄░",
  "▀▀▀███▀▀░",
  "   ██░",
];
