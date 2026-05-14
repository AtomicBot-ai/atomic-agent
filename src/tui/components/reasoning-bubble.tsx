import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";

interface ReasoningBubbleProps {
  blocks: readonly string[];
  /** Collapsed summary is shown by default; pass `true` for the full CoT. */
  expanded: boolean;
  onToggle?: () => void;
}

const SUMMARY_LIMIT = 180;

/**
 * Collapsible `<think>` block. Mirrors the user / assistant ribbon
 * layout (left coloured border, `marginTop=1`, padded body) so
 * reasoning blends into the chat flow instead of fighting it. Magenta
 * border identifies the role; a single muted-colour header keeps the
 * "(N blocks)" hint visible. The toggle itself is owned by the parent
 * (chat-log) via `onToggle`.
 */
export function ReasoningBubble({
  blocks,
  expanded,
}: ReasoningBubbleProps): ReactElement | null {
  if (blocks.length === 0) return null;
  const joined = blocks.join("\n\n").trim();
  if (joined.length === 0) return null;
  const lines = expanded
    ? splitLines(joined)
    : [clip(joined.replace(/\s+/g, " "), SUMMARY_LIMIT)];
  return (
    <Box marginTop={1}>
      <Box
        borderStyle="single"
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderLeft
        borderColor={theme.colors.reasoning}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={1}
        flexDirection="column"
      >
        <Text color={theme.colors.reasoning} bold>
          {theme.glyphs.reasoningMarker} reasoning
          <Text color={theme.colors.muted}>
            {" "}
            ({blocks.length} block{blocks.length === 1 ? "" : "s"})
          </Text>
        </Text>
        {lines.map((line, idx) => (
          <Text key={idx} color={theme.colors.muted}>
            {line}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

function clip(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
}
