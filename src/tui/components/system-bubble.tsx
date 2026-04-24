import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";

interface SystemBubbleProps {
  text: string;
  /** When true render with a warn colour (used for runtime-info errors). */
  warn?: boolean;
}

/**
 * System / slash-command notices: framed so they read as machine output,
 * not part of the user↔agent dialogue. Multiline text is split so `/help`
 * and similar stay readable.
 */
export function SystemBubble({ text, warn }: SystemBubbleProps): ReactElement {
  const color = warn ? theme.colors.warn : theme.colors.system;
  const borderColor = warn ? theme.colors.warn : theme.colors.accentSoft;
  const lines = text.split("\n");
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      marginLeft={2}
      marginBottom={1}
    >
      {lines.map((line, i) => (
        <Text key={i} color={color}>
          {theme.glyphs.systemMarker} {line}
        </Text>
      ))}
    </Box>
  );
}
