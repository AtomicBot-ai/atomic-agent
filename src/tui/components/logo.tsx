import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
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
 * (17×10) and `mini` (a single 14-column line). `SplashBanner` picks
 * one via `computeSplashFit`; callers that just want the classic
 * artwork can keep using the defaults.
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
export const LOGO_ART: Readonly<Record<LogoVariant, readonly string[]>> = {
  // Leading padding has been uniformly trimmed so the middle bar sits
  // at column 0 — keeps the art within ~34 columns for narrow terminals.
  full: [
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
  ],
  small: [
    "      -:::--",
    "      -::::-",
    "     -:::::-",
    "   -:::::::-",
    "-:::::::::::::::-",
    ":::::::::::::::::",
    "=-----:::::::::-=",
    " @@@@@*-::::-=#%",
    "      -::::-*",
    "      +----*",
  ],
  mini: ["+ ATOMIC AGENT"],
};

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
  if (variant === "mini") {
    return (
      <Text color={theme.colors.system} bold wrap="truncate">
        {LOGO_ART.mini[0]}
      </Text>
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

function LogoMark({ variant }: { variant: LogoVariant }): ReactElement {
  return (
    <Box flexDirection="column">
      {LOGO_ART[variant].map((row, idx) => (
        <Text key={idx} color={theme.colors.system} bold wrap="truncate">
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
