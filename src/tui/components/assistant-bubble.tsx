import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { MarkdownRenderer } from "../render/markdown-renderer.js";
import { theme } from "../theme/theme.js";

interface AssistantBubbleProps {
  text: string;
  /** `true` while the turn is still streaming — surfaces a soft spinner hint. */
  streaming?: boolean;
  /** Counts non-reply tool steps run during the turn. */
  toolSteps?: number;
}

/**
 * opencode-style assistant reply bubble. Mirrors `UserBubble` (left
 * coloured border + vertical padding + `marginTop=1`) so the chat
 * surface reads as a two-colour ribbon instead of a labelled list.
 * Tool-step count and a final `●` glyph land in a meta-row **below**
 * the bubble (outside the border), again copied from opencode — the
 * label is the colour, not the inline text.
 *
 * Markdown rendering is gated on `!streaming`: partial markdown
 * (half-opened `**`, fenced block missing its closing ```, dangling
 * list marker) lexes into ugly literals that flicker as the stream
 * arrives. Plain text while streaming, markdown once finalised.
 */
export function AssistantBubble({
  text,
  streaming = false,
  toolSteps,
}: AssistantBubbleProps): ReactElement {
  const showFooter = !streaming && toolSteps !== undefined && toolSteps > 0;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box
        borderStyle="single"
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderLeft
        borderColor={theme.colors.assistant}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={1}
        flexDirection="column"
      >
        {streaming ? <Text>{text}</Text> : <MarkdownRenderer text={text} />}
      </Box>
      {showFooter ? (
        <Box marginLeft={3}>
          <Text color={theme.colors.assistant}>●</Text>
          <Text color={theme.colors.muted}>
            {" "}
            {toolSteps} tool step{toolSteps === 1 ? "" : "s"}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
