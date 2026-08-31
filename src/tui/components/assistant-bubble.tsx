import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { LinkifiedText } from "../render/linkify-text.js";
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
 * The assistant reply. Mirrors `UserBubble`: an `AGENT` label over a
 * coloured left border, with the tool-step count and a final `●` glyph
 * in a meta-row **below** the bubble, outside the border.
 *
 * The label is the word AND the colour. Colour on its own carries
 * nothing under NO_COLOR or in a pipe, and a reply that is only
 * distinguishable by hue from the message that prompted it is a
 * transcript nobody can skim.
 *
 * Markdown rendering is gated on `!streaming`: partial markdown
 * (half-opened `**`, fenced block missing its closing ```, dangling
 * list marker) lexes into ugly literals that flicker as the stream
 * arrives. Plain text while streaming, markdown once finalised — but
 * the plain-text phase still routes through `LinkifiedText`, so a URL
 * is clickable the moment it appears, not only after the turn ends.
 */
export function AssistantBubble({
  text,
  streaming = false,
  toolSteps,
}: AssistantBubbleProps): ReactElement {
  const showFooter = !streaming && toolSteps !== undefined && toolSteps > 0;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.colors.assistant} bold>
        {"  AGENT"}
      </Text>
      <Box
        borderStyle="single"
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderLeft
        borderColor={theme.colors.assistant}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={1}
        flexDirection="column"
      >
        {streaming ? (
          <Text>
            <LinkifiedText text={text} />
          </Text>
        ) : (
          <MarkdownRenderer text={text} />
        )}
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
