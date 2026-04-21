import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";

/**
 * Welcome screen shown in place of an empty chat-log. The atomic plus
 * mark is drawn with the canonical `-`/`:`/`=`/`*`/`@`/`#`/`%` glyph
 * ramp (matching the project icon reference), followed by the
 * `atomic agent` brand line, a short tagline and the six most useful
 * hotkeys / slash commands.
 *
 * The banner is stateless: visibility is decided by the parent
 * (`ChatLog`) based on `messages.length === 0`, so restoring a
 * historical session via `/sessions` swaps it out for the transcript.
 */
export function SplashBanner(): ReactElement {
  return (
    <Box flexDirection="column" paddingX={2}>
      <Box flexDirection="row" alignItems="center">
        <LogoMark />
        <Box flexDirection="column" marginLeft={3}>
          <WordMark />
          <Box marginTop={1}>
            <Text color={theme.colors.muted}>
              local operator agent — Ink + llama.cpp
            </Text>
          </Box>
        </Box>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Tip left="Enter" right="submit message to the agent" />
        <Tip left="/help" right="list all slash commands" />
        <Tip left="/sessions" right="switch to a previous thread" />
        <Tip left="/new" right="start a fresh session" />
        <Tip left="F2" right="toggle chat ↔ debug pane" />
        <Tip left="Ctrl+C ×2" right="quit (once aborts a running turn)" />
      </Box>
    </Box>
  );
}

/**
 * Canonical atomic-plus mark copied verbatim from the project icon
 * reference. Uses a gradient of glyphs (`-` / `:` / `=` / `*` / `@` /
 * `#` / `%`) to imply soft edges on the rounded top-left cap and the
 * concave bottom-right scoop. Rendered in yellow to match the source.
 */
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
        <Text key={idx} color={theme.colors.warn} bold>
          {row}
        </Text>
      ))}
    </Box>
  );
}

/**
 * `ATOMIC AGENT` rendered in half-block characters. ~48 columns wide —
 * sits to the right of the logo and is vertically centred next to the
 * cross's middle bar via `alignItems="center"` in the parent row.
 */
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

interface TipProps {
  left: string;
  right: string;
}

function Tip({ left, right }: TipProps): ReactElement {
  return (
    <Text>
      <Text color={theme.colors.muted}>  {theme.glyphs.bullet} </Text>
      <Text color={theme.colors.accent}>{left.padEnd(24, " ")}</Text>
      <Text color={theme.colors.muted}>{right}</Text>
    </Text>
  );
}
