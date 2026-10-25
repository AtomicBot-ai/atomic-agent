import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { closeStreamingMarkdown } from "../render/close-streaming-markdown.js";
import { MarkdownRenderer } from "../render/markdown-renderer.js";
import { fusionInk } from "../theme/fusion-tint.js";
import { theme } from "../theme/theme.js";

interface AssistantBubbleProps {
  text: string;
  /** `true` while the turn is still streaming — surfaces a soft spinner hint. */
  streaming?: boolean;
  /** Counts non-reply tool steps run during the turn. */
  toolSteps?: number;
  /**
   * Files the reply delivered (`reply.attachments`). Listed under the
   * text so an attachment is visible here too, not only on the channel
   * that received it — a field nothing renders is a field the model
   * learns to ignore.
   */
  attachments?: readonly string[];
  /**
   * The Fusion run mode is on: the label, the border and the footer
   * glyph take the palette's orange, because this reply is the cloud
   * orchestrator's and the tint is what says so.
   */
  fusion?: boolean;
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
 * Markdown renders while streaming too, through
 * `closeStreamingMarkdown`: the unfinished end of the text gets its open
 * `**`, `*`, `~~` and code spans closed and a half-written link shown as
 * its label, so the reply never shows literal markers that switch to
 * styling when the turn ends, and the layout does not jump. An open
 * ``` fence needs no help: the lexer renders the rest as code. Bare URLs
 * stay clickable while streaming through the renderer's own linkifier.
 */
export function AssistantBubble({
  text,
  streaming = false,
  toolSteps,
  attachments,
  fusion = false,
}: AssistantBubbleProps): ReactElement {
  const showFooter = !streaming && toolSteps !== undefined && toolSteps > 0;
  const files = attachments ?? [];
  const tone = fusion ? fusionInk() : theme.colors.assistant;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={tone} bold>
        {"  AGENT"}
      </Text>
      <Box
        borderStyle="single"
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderLeft
        borderColor={tone}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={1}
        flexDirection="column"
      >
        <MarkdownRenderer
          text={streaming ? closeStreamingMarkdown(text) : text}
        />
        {files.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            {files.map((path) => (
              <Text key={path} color={theme.colors.muted}>
                {"📎 "}
                {path}
              </Text>
            ))}
          </Box>
        ) : null}
      </Box>
      {showFooter ? (
        <Box marginLeft={3}>
          <Text color={tone}>●</Text>
          <Text color={theme.colors.muted}>
            {" "}
            {toolSteps} tool step{toolSteps === 1 ? "" : "s"}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
