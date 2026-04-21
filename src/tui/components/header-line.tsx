import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import type { TuiState } from "../tui-state.js";

interface HeaderLineProps {
  state: TuiState;
}

/**
 * Single-line openclaw-style header: compact brand, cwd, llama URL,
 * skills count and session id (when known). Kept to one terminal row so
 * the chat-log below has maximum vertical breathing room.
 */
export function HeaderLine({ state }: HeaderLineProps): ReactElement {
  const { session } = state;
  const parts: Array<{ label: string; value: string }> = [
    { label: "cwd", value: shortenPath(session.workingDir) },
    { label: "llama", value: session.llamaUrl },
    {
      label: "session",
      value: session.sessionId ? shortenId(session.sessionId) : "(pending)",
    },
    { label: "skills", value: String(session.skillCount) },
  ];
  return (
    <Box>
      <Text color={theme.colors.accentSoft} bold>
        atomic-agent
      </Text>
      {parts.map((part) => (
        <Text key={part.label}>
          <Text color={theme.colors.muted}> {theme.glyphs.pipeSeparator} </Text>
          <Text color={theme.colors.muted}>{part.label} </Text>
          <Text>{part.value}</Text>
        </Text>
      ))}
    </Box>
  );
}

function shortenPath(value: string): string {
  const home = process.env.HOME;
  if (home && value.startsWith(home)) return `~${value.slice(home.length)}`;
  return value;
}

function shortenId(value: string): string {
  if (value.length <= 8) return value;
  return `${value.slice(0, 8)}…`;
}
