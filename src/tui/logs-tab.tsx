import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { LogRecord } from "../tracing/structured-logger.js";
import type { TuiState } from "./tui-state.js";

interface LogsTabProps {
  state: TuiState;
  maxVisible: number;
}

const LEVEL_COLOR: Record<LogRecord["level"], string> = {
  debug: "gray",
  info: "blue",
  warn: "yellow",
  error: "red",
};

export function LogsTab({ state, maxVisible }: LogsTabProps): ReactElement {
  const visible = state.logs.slice(-maxVisible);
  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor="gray" paddingX={1}>
      <Text color="gray">── logs ──────────────────────────────────────────</Text>
      {visible.length === 0 ? (
        <Text color="gray">no log records yet</Text>
      ) : (
        visible.map((record, idx) => (
          <LogRow key={`${record.timestamp}-${idx}`} record={record} />
        ))
      )}
    </Box>
  );
}

interface LogRowProps {
  record: LogRecord;
}

function LogRow({ record }: LogRowProps): ReactElement {
  const time = new Date(record.timestamp).toISOString().slice(11, 19);
  return (
    <Text>
      <Text color="gray">{time}</Text>
      <Text> </Text>
      <Text color={LEVEL_COLOR[record.level]}>{record.level.toUpperCase().padEnd(5)}</Text>
      <Text> </Text>
      <Text>{record.message}</Text>
      {record.context ? <Text color="gray"> {safeJson(record.context)}</Text> : null}
    </Text>
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserialisable]";
  }
}
