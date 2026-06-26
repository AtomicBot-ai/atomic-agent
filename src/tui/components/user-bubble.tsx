import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { LinkifiedText } from "../render/linkify-text.js";
import { theme } from "../theme/theme.js";

interface UserBubbleProps {
  text: string;
}

/**
 * opencode-style user message: a colored vertical left border plus
 * generous vertical padding around the body. The role itself is
 * implied by the border color (blue = user) — there is no inline
 * "you" label, so consecutive user / assistant turns read as a
 * coloured ribbon rather than a labelled list. `marginTop=1` between
 * messages prevents bubbles from touching.
 *
 * No markdown rendering — the user authored the text and expects to
 * see exactly what they typed.
 */
export function UserBubble({ text }: UserBubbleProps): ReactElement {
  return (
    <Box marginTop={1}>
      <Box
        borderStyle="single"
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderLeft
        borderColor={theme.colors.user}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={1}
        flexDirection="column"
      >
        {splitLines(text).map((line, idx) => (
          <Text key={idx}>
            <LinkifiedText text={line} />
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [""];
  return text.replace(/\r\n/g, "\n").split("\n");
}
