import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import type { MemoryDetailPayload } from "../memory/memory-panel-state.js";

export interface MemoryDetailProps {
  detail: MemoryDetailPayload | null;
  maxBodyLines?: number;
}

const DEFAULT_MAX_BODY_LINES = 28;

export function MemoryDetail(props: MemoryDetailProps): ReactElement {
  const { detail, maxBodyLines = DEFAULT_MAX_BODY_LINES } = props;
  if (!detail) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text color={theme.colors.muted}>(loading…)</Text>
      </Box>
    );
  }
  const title =
    detail.channel === "profile"
      ? `profile: ${detail.key}`
      : detail.channel === "notes"
        ? `note #${detail.id}`
        : detail.channel === "lessons"
          ? `lesson #${detail.id}`
          : detail.channel === "procedures"
            ? `procedure #${detail.id}`
            : detail.channel;
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      <Box marginTop={1} flexDirection="column">
        {renderBody(detail.body, maxBodyLines)}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.colors.muted}>
          Esc back · r refresh
          {detail.channel === "notes" ? " · g expand graph · Enter neighbor" : ""}
        </Text>
      </Box>
    </Box>
  );
}

function renderBody(body: string, maxLines: number): ReactElement {
  const lines = body.split("\n");
  const head = lines.slice(0, maxLines);
  const truncated = lines.length > maxLines;
  return (
    <Box flexDirection="column">
      {head.map((line, idx) => (
        <Text key={idx}>{line.length === 0 ? " " : line}</Text>
      ))}
      {truncated ? (
        <Text color={theme.colors.muted}>
          … ({lines.length - maxLines} more lines hidden)
        </Text>
      ) : null}
    </Box>
  );
}
