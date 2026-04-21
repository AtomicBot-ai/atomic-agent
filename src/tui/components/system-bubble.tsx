import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";

interface SystemBubbleProps {
  text: string;
  /** When true render with a warn colour (used for runtime-info errors). */
  warn?: boolean;
}

/**
 * Low-key system / runtime-info line. Rendered inline between chat
 * bubbles so ambient telemetry (`runtime ready — llama …`, `/clear`
 * confirmation, etc.) does not compete visually with the dialogue.
 */
export function SystemBubble({ text, warn }: SystemBubbleProps): ReactElement {
  const color = warn ? theme.colors.warn : theme.colors.system;
  return (
    <Box>
      <Text color={color}>
        {theme.glyphs.systemMarker} {text}
      </Text>
    </Box>
  );
}
