import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";

/**
 * Atomic-plus mark + `ATOMIC AGENT` wordmark, rendered side-by-side and
 * vertically centred. Extracted from `SplashBanner` so the same artwork
 * can be reused in any centered "home" layout (e.g. the empty-chat
 * landing surface) without copying the row data.
 *
 * Rendered as plain Ink primitives — no animations, no alpha. Use the
 * `compact` variant in narrow layouts where the wordmark would wrap.
 */
export interface LogoProps {
  compact?: boolean;
}

export function Logo({ compact = false }: LogoProps): ReactElement {
  return (
    <Box flexDirection="row" alignItems="center">
      <LogoMark />
      {compact ? null : (
        <Box flexDirection="column" marginLeft={3}>
          <WordMark />
          <Box marginTop={1}>
            <Text color={theme.colors.muted}>
              Local AI-First Agent
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}

function LogoMark(): ReactElement {
  // Leading padding has been uniformly trimmed so the middle bar sits
  // at column 0 — keeps the art within ~34 columns for narrow terminals.
  const rows: readonly string[] = [
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
  return (
    <Box flexDirection="column">
      {rows.map((row, idx) => (
        <Text key={idx} color={theme.colors.system} bold>
          {row}
        </Text>
      ))}
    </Box>
  );
}

function WordMark(): ReactElement {
  const rows: readonly string[] = [
    "▄▀█ ▀█▀ █▀█ █▀▄▀█ █ █▀▀   ▄▀█ █▀▀ █▀▀ █▄░█ ▀█▀",
    "█▀█ ░█░ █▄█ █░▀░█ █ █▄▄   █▀█ █▄█ ██▄ █░▀█ ░█░",
  ];
  return (
    <Box flexDirection="column">
      {rows.map((row, idx) => (
        <Text key={idx} color={theme.colors.accentSoft} bold>
          {row}
        </Text>
      ))}
    </Box>
  );
}
