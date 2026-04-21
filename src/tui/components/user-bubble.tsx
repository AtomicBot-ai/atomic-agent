import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";

interface UserBubbleProps {
  text: string;
}

/**
 * Openclaw-style user message: one-line role header with a colour-coded
 * marker, then the raw text on following lines. No markdown — the user
 * authored it, so we render literally.
 */
export function UserBubble({ text }: UserBubbleProps): ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={theme.colors.user} bold>
        {theme.glyphs.userMarker} you
      </Text>
      {splitLines(text).map((line, idx) => (
        <Text key={idx}>  {line}</Text>
      ))}
    </Box>
  );
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [""];
  return text.replace(/\r\n/g, "\n").split("\n");
}
