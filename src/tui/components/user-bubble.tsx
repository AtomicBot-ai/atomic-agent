import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { LinkifiedText } from "../render/linkify-text.js";
import { theme } from "../theme/theme.js";

interface UserBubbleProps {
  text: string;
}

/**
 * A user message: a `YOU` label over a coloured left border and
 * generous vertical padding around the body. `marginTop=1` between
 * messages prevents bubbles from touching.
 *
 * The label used to be absent, on the theory that the border colour is
 * the label. Colour alone says nothing under NO_COLOR, in a pipe, or to
 * a reader who cannot separate the two hues — and the design puts the
 * word back, which is also the accessible answer.
 *
 * No markdown rendering — the user authored the text and expects to
 * see exactly what they typed.
 */
export function UserBubble({ text }: UserBubbleProps): ReactElement {
  return (
    <Box marginTop={1} flexDirection="column">
      <Text color={theme.colors.user} bold>
        {"  YOU"}
      </Text>
      <Box
        borderStyle="single"
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderLeft
        borderColor={theme.colors.user}
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
