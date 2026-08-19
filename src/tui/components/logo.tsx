import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import { rasteriseMark, toInkMask } from "./logo-raster.js";
import type { LogoVariant } from "./splash-fit.js";

/**
 * Atomic-plus mark + `ATOMIC AGENT` wordmark, rendered side-by-side and
 * vertically centred. Extracted from `SplashBanner` so the same artwork
 * can be reused in any centered "home" layout (e.g. the empty-chat
 * landing surface) without copying the row data.
 *
 * Rendered as plain Ink primitives — no animations, no alpha. The mark
 * comes in three sizes so the same component can serve a 200-column
 * desktop terminal and a 40-column SSH window: `full` (34×20), `small`
 * (20×12) and `mini` (9×5). `SplashBanner` picks one via
 * `computeSplashFit`; callers that just want the classic artwork can
 * keep using the defaults.
 *
 * Only `full` is drawn by hand. The smaller two are **measured off it**
 * by `logo-raster.ts` — half-block glyphs at the terminal's ~2:1 cell
 * aspect, so they are the same shape at a smaller scale rather than a
 * second and third attempt at drawing it. The hand-drawn half-size copy
 * they replace had lost the taper of the lower-right tail and read as a
 * blob; a redrawn mark also drifts from the original every time either
 * is touched, which is a maintenance cost with no upside.
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
}

/**
 * Mark artwork keyed by variant. `full` is the original drawing; the
 * others preserve its silhouette — upper-left flare, full-width cross
 * bar, tapering lower-right tail — at roughly half scale and as a
 * single line. `splash-fit.ts` mirrors these dimensions in
 * `LOGO_METRICS`; `logo-fit.test.ts` fails if the two ever disagree.
 */
const FULL_ART: readonly string[] = [
  // Leading padding has been uniformly trimmed so the middle bar sits
  // at column 0 — keeps the art within ~34 columns for narrow terminals.
  "            -:::::::--",
  "            -::::::::-",
  "           -:::::::::-",
  "          -::::::::::-",
  "         -:::::::::::-",
  "       -:::::::::::::-",
  "    -::::::::::::::::-",
  "-::::::::::::::::::::::::::::::::-",
  "::::::::::::::::::::::::::::::::::",
  "::::::::::::::::::::::::::::::::::",
  "-:::::::::::::::::::::::::::::::::",
  "=------------:::::::::::::::::---=",
  " @@@@@@@@@@@*-::::::::::::-=+#%%@",
  "            -:::::::::::-+#@",
  "            -::::::::::=#@",
  "            -:::::::::=#",
  "            -::::::::-*",
  "            -::::::::=",
  "            +--------*",
  "              %%%%%%",
];

/**
 * Mark artwork keyed by variant. `full` is the original drawing and the
 * single source of truth; `small` and `mini` are scaled from it at load
 * time, so all three are the same shape by construction. `splash-fit.ts`
 * mirrors these dimensions in `LOGO_METRICS`; `logo-fit.test.ts` fails if
 * the two ever disagree.
 */
export const LOGO_ART: Readonly<Record<LogoVariant, readonly string[]>> = {
  full: FULL_ART,
  small: rasteriseMark(toInkMask(FULL_ART), { columns: 20, rows: 12 }),
  mini: rasteriseMark(toInkMask(FULL_ART), { columns: 7, rows: 4 }),
};

/**
 * The rail's own mark: smaller than `mini`, because on the rail it sits
 * beside the wordmark rather than above it and has to leave room for the
 * text. 6x4 is the floor at which the silhouette still reads — 6x3 and
 * 5x3 collapse the arms into a blob.
 */
export const RAIL_MARK: readonly string[] = rasteriseMark(
  toInkMask(FULL_ART),
  { columns: 6, rows: 4 },
);

export const WORDMARK_ROWS: readonly string[] = [
  "▄▀█ ▀█▀ █▀█ █▀▄▀█ █ █▀▀   ▄▀█ █▀▀ █▀▀ █▄ █ ▀█▀",
  "█▀█  █  █▄█ █ ▀ █ █ █▄▄   █▀█ █▄█ ██▄ █ ▀█  █ ",
];

export const TAGLINE = "Local AI-First Agent";

export function Logo({
  variant = "full",
  compact = false,
  wordmark,
  tagline,
}: LogoProps): ReactElement {
  const showWordmark = wordmark ?? !compact;
  const showTagline = tagline ?? showWordmark;
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

function LogoMark({ variant }: { variant: LogoVariant }): ReactElement {
  return (
    <Box flexDirection="column">
      {LOGO_ART[variant].map((row, idx) => (
        <Text key={idx} color={theme.colors.brandMark} bold wrap="truncate">
          {row}
        </Text>
      ))}
    </Box>
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
