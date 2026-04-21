import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { FeedEntry, TuiState } from "./tui-state.js";

interface EventFeedProps {
  state: TuiState;
  maxVisible: number;
}

export function EventFeed({ state, maxVisible }: EventFeedProps): ReactElement {
  const visible = state.feed.slice(-maxVisible);
  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor="gray" paddingX={1}>
      <Text color="gray">── feed ──────────────────────────────────────────</Text>
      {visible.length === 0 ? (
        <Text color="gray">waiting for agent events…</Text>
      ) : (
        visible.map((entry) => <FeedRow key={entry.id} entry={entry} />)
      )}
    </Box>
  );
}

interface FeedRowProps {
  entry: FeedEntry;
}

function FeedRow({ entry }: FeedRowProps): ReactElement {
  return (
    <Text>
      <Text color={entry.color}>{glyph(entry)}</Text>
      <Text> </Text>
      <Text>{entry.line}</Text>
    </Text>
  );
}

function glyph(entry: FeedEntry): string {
  switch (entry.kind) {
    case "step_started":
      return "▸";
    case "step_finished":
      return "✓";
    case "tool_call_parsed":
      return "→";
    case "tool_call_executed":
      return "←";
    case "step_error":
      return "!";
    case "loop_completed":
      return "»";
    case "loop_failed":
      return "✗";
    case "runtime_info":
      return "ℹ";
    default:
      return "·";
  }
}
