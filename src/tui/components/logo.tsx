import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import { CROSS_MARKS } from "./logo-art.js";
import type { LogoVariant, WordmarkPlacement } from "./splash-fit.js";

/**
 * Atomic cross + `ATOMIC AGENT` wordmark, rendered side-by-side and
 * vertically centred. Extracted from `SplashBanner` so the same artwork
 * can be reused in any centered "home" layout (e.g. the empty-chat
 * landing surface) without copying the row data.
 *
 * Rendered as plain Ink primitives — no animations, no alpha. The mark
 * comes in three sizes so the same component can serve a 200-column
 * desktop terminal and a 40-column SSH window: `full` (51×24), `small`
 * (31×14) and `mini` (9×5). `SplashBanner` picks one via
 * `computeSplashFit`.
 *
 * **Every size is its own drawing** — see `logo-art.ts`. They used to be
 * measured off one source at load time, which cannot work now that the
 * marks carry depth: the scaler flattens its input to a boolean ink
 * mask, so the three tones would collapse into one solid silhouette.
 *
 * The home surface draws the **ascii** stroke and the rail draws
 * **block**. That split is deliberate: the splash is the one screen a
 * first run is guaranteed to hit, including over a serial console or a
 * CI log scrape where block elements arrive as mojibake, whereas the
 * rail only exists in a session already rendering box-drawing chrome.
 */
export interface LogoProps {
  /** Which mark to draw. Defaults to the full 34×20 artwork. */
  variant?: LogoVariant;
  /**
   * Legacy switch for "mark only, no wordmark". Still honoured so
   * existing callers keep working; prefer `wordmark={false}`.
   */
  compact?: boolean;
  /** Draw the `ATOMIC AGENT` wordmark beside the mark. */
  wordmark?: boolean;
  /** Draw the "Local AI-First Agent" tagline under the wordmark. */
  tagline?: boolean;
  /**
   * Where the wordmark sits. `"below"` stacks it under the mark, which
   * is what lets the 51-column `full` mark keep its name on a terminal
   * too narrow to park them side by side.
   */
  placement?: WordmarkPlacement;
}

/**
 * Splash artwork, one purpose-drawn asset per scale. `splash-fit.ts`
 * mirrors these dimensions in `LOGO_METRICS`; `logo-fit.test.ts`
 * re-measures the rows and fails if the two ever drift apart.
 */
export const LOGO_ART: Readonly<Record<LogoVariant, readonly string[]>> = {
  full: CROSS_MARKS.ascii.lg,
  small: CROSS_MARKS.ascii.md,
  mini: CROSS_MARKS.ascii.sm,
};

/**
 * The rail's brand mark: the guideline's SM glyph, block stroke, 9x5.
 * `sidebar.tsx` keeps {@link MARK_COLUMNS} in step with its width, and
 * `SIDEBAR_CHROME_ROWS` counts its five rows.
 */
export const RAIL_MARK: readonly string[] = CROSS_MARKS.block.sm;

/**
 * `ATOMIC AGENT`, drawn with full blocks only.
 *
 * It used to be a two-row half-block lockup (`▄▀█ ▀█▀ █▀█ …`), which
 * breaks up on terminals whose line height does not split a cell at an
 * integer pixel row: `▀` and `▄` are exactly the glyphs that need that
 * split, so the renderer rounds and drops a scanline, and the wordmark
 * loses half of every letter. It survives at large font sizes and falls
 * apart at small ones, which is why it looked fine for so long.
 *
 * `█` has no such requirement — it fills the cell — so the letterforms
 * are built from it and spaces alone. Five rows instead of two is the
 * price; `WORDMARK_STACK_ROWS` in `splash-fit.ts` accounts for it.
 */
export const WORDMARK_ROWS: readonly string[] = [
  "\u2588\u2588\u2588 \u2588\u2588\u2588 \u2588\u2588\u2588 \u2588   \u2588 \u2588 \u2588\u2588\u2588   \u2588\u2588\u2588 \u2588\u2588\u2588\u2588 \u2588\u2588\u2588 \u2588   \u2588 \u2588\u2588\u2588",
  "\u2588 \u2588  \u2588  \u2588 \u2588 \u2588\u2588 \u2588\u2588 \u2588 \u2588     \u2588 \u2588 \u2588    \u2588   \u2588\u2588  \u2588  \u2588 ",
  "\u2588\u2588\u2588  \u2588  \u2588 \u2588 \u2588 \u2588 \u2588 \u2588 \u2588     \u2588\u2588\u2588 \u2588 \u2588\u2588 \u2588\u2588\u2588 \u2588 \u2588 \u2588  \u2588 ",
  "\u2588 \u2588  \u2588  \u2588 \u2588 \u2588   \u2588 \u2588 \u2588     \u2588 \u2588 \u2588  \u2588 \u2588   \u2588  \u2588\u2588  \u2588 ",
  "\u2588 \u2588  \u2588  \u2588\u2588\u2588 \u2588   \u2588 \u2588 \u2588\u2588\u2588   \u2588 \u2588 \u2588\u2588\u2588\u2588 \u2588\u2588\u2588 \u2588   \u2588  \u2588 ",
];

export const TAGLINE = "Local AI-First Agent";

export function Logo({
  variant = "full",
  compact = false,
  wordmark,
  tagline,
  placement = "beside",
}: LogoProps): ReactElement {
  const showWordmark = wordmark ?? !compact;
  const showTagline = tagline ?? showWordmark;
  if (placement === "below" && (showWordmark || showTagline)) {
    return (
      <Box flexDirection="column" alignItems="center">
        <LogoMark variant={variant} />
        {showWordmark ? (
          <Box marginTop={1}>
            <WordMark />
          </Box>
        ) : null}
        {showTagline ? (
          <Text color={theme.colors.muted} wrap="truncate">
            {TAGLINE}
          </Text>
        ) : null}
      </Box>
    );
  }
  return (
    <Box flexDirection="row" alignItems="center">
      <LogoMark variant={variant} />
      {showWordmark || showTagline ? (
        <Box flexDirection="column" marginLeft={3}>
          {showWordmark ? <WordMark /> : null}
          {showTagline ? (
            <Box marginTop={showWordmark ? 1 : 0}>
              <Text color={theme.colors.muted} wrap="truncate">
                {TAGLINE}
              </Text>
            </Box>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * Glyphs that draw the mark's front plane. Everything else in the art is
 * depth — extruded wall or cast shadow — and stays in `brandMark`.
 */
const FACE_GLYPHS = new Set(["#", "\u2588"]);

function LogoMark({ variant }: { variant: LogoVariant }): ReactElement {
  return (
    <Box flexDirection="column">
      {LOGO_ART[variant].map((row, idx) => (
        <MarkRow key={idx} row={row} />
      ))}
    </Box>
  );
}

/**
 * One row of the mark, split into runs of face and depth so the two can
 * be painted apart. Colour carries the front/side distinction better
 * than glyph density does; the density ramp is still there underneath
 * for terminals with no colour to spend.
 */
function MarkRow({ row }: { row: string }): ReactElement {
  const runs: { text: string; face: boolean }[] = [];
  for (const ch of row) {
    const face = FACE_GLYPHS.has(ch);
    const last = runs[runs.length - 1];
    if (last && last.face === face) last.text += ch;
    else runs.push({ text: ch, face });
  }
  return (
    <Text wrap="truncate">
      {runs.map((run, idx) => (
        <Text
          key={idx}
          color={run.face ? theme.colors.brandFace : theme.colors.brandMark}
          bold
        >
          {run.text}
        </Text>
      ))}
    </Text>
  );
}

function WordMark(): ReactElement {
  return (
    <Box flexDirection="column">
      {WORDMARK_ROWS.map((row, idx) => (
        <Text key={idx} color={theme.colors.accentSoft} bold wrap="truncate">
          {row}
        </Text>
      ))}
    </Box>
  );
}
