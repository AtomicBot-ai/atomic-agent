import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import type { LocalLlmLogsState } from "../local-models/local-llm-logs-state.js";

interface LocalLlmLogsPanelProps {
  logs: LocalLlmLogsState;
  maxLines?: number;
}

const DEFAULT_MAX_LINES = 30;

/**
 * Tail view of `<dataDir>/llama-server.log`. The orchestrator polls the
 * file every 1s while this tab is active and emits `local_llm_logs_*`
 * actions into the reducer. The component is intentionally dumb: split
 * the tail on `\n`, keep the last N lines, render.
 */
export function LocalLlmLogsPanel({
  logs,
  maxLines = DEFAULT_MAX_LINES,
}: LocalLlmLogsPanelProps): ReactElement {
  const lines = logs.text.split("\n").filter((l) => l.length > 0);
  const tail = lines.slice(-maxLines);
  const header =
    logs.path !== null
      ? logs.path
      : "(waiting for the first daemon start — no log file yet)";
  return (
    <Box flexDirection="column">
      <Text color={theme.colors.muted}>{header}</Text>
      {logs.size !== null ? (
        <Text color={theme.colors.muted}>
          {formatBytes(logs.size)}
          {logs.truncated ? " · showing tail only" : ""}
          {logs.lastReadAt
            ? ` · last read ${new Date(logs.lastReadAt).toLocaleTimeString()}`
            : ""}
        </Text>
      ) : null}
      {logs.error ? (
        <Text color="yellow">{logs.error}</Text>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        {tail.length === 0 ? (
          <Text color={theme.colors.muted}>
            {logs.error ? "" : "(log is empty — start the daemon to see output)"}
          </Text>
        ) : (
          tail.map((line, i) => (
            <Text key={i} color={colorForLine(line)}>
              {line}
            </Text>
          ))
        )}
      </Box>
    </Box>
  );
}

function colorForLine(line: string): string | undefined {
  const lower = line.toLowerCase();
  if (/\b(error|fatal|fail|abort)\b/.test(lower)) return "red";
  if (/\b(warn|warning)\b/.test(lower)) return "yellow";
  if (/\b(loading|loaded|ready|listening)\b/.test(lower)) return "green";
  return undefined;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
