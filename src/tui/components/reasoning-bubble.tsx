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
 * Collapsible `<think>` block. Openclaw hides reasoning behind a gutter
 * marker; we follow the same convention and render a single-line summary
 * by default, with the full transcript revealed when `expanded` is true.
 * The toggle itself is owned by the parent (chat-log) via `onToggle`.
 */
export function ReasoningBubble({
  blocks,
  expanded,
}: ReasoningBubbleProps): ReactElement | null {
  if (blocks.length === 0) return null;
  const joined = blocks.join("\n\n").trim();
  if (joined.length === 0) return null;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={theme.colors.reasoning} bold>
        {theme.glyphs.reasoningMarker} reasoning
        <Text color={theme.colors.muted}>
          {" "}
          ({blocks.length} block{blocks.length === 1 ? "" : "s"})
        </Text>
      </Text>
      {expanded ? (
        splitLines(joined).map((line, idx) => (
          <Text key={idx} color={theme.colors.muted}>
            {"  "}
            {line}
          </Text>
        ))
      ) : (
        <Text color={theme.colors.muted}>
          {"  "}
          {clip(joined.replace(/\s+/g, " "), SUMMARY_LIMIT)}
        </Text>
      )}
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
