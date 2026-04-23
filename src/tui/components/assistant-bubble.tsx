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
 * Assistant reply bubble. The finalised message body runs through the
 * markdown renderer so fenced code, bold/italic, links and lists appear
 * closer to the openclaw look. While the turn is still streaming we
 * render plain text instead — partial markdown (half-opened `**`, a
 * fenced block missing its closing ```, a dangling list marker) lexes
 * into ugly literals that flicker and rearrange on every token. Marked
 * output stabilises only once the whole reply is in hand.
 */
export function AssistantBubble({
  text,
  streaming = false,
  toolSteps,
}: AssistantBubbleProps): ReactElement {
  const counter =
    streaming || toolSteps === undefined || toolSteps === 0
      ? null
      : ` ${theme.glyphs.dotSeparator} ${toolSteps} tool step${
          toolSteps === 1 ? "" : "s"
        }`;
  return (
    <Box flexDirection="column" marginBottom={1} marginLeft={1}>
      <Text color={theme.colors.assistant} bold>
        {theme.glyphs.assistantMarker} assistant
        {counter ? <Text color={theme.colors.muted}>{counter}</Text> : null}
        {streaming ? (
          <Text color={theme.colors.muted}> {theme.glyphs.ellipsis}</Text>
        ) : null}
      </Text>
      <Box flexDirection="column" marginTop={1} marginLeft={2}>
        {streaming ? <Text>{text}</Text> : <MarkdownRenderer text={text} />}
      </Box>
    </Box>
  );
}
