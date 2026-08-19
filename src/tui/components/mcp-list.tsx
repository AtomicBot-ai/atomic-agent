import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import { MouseListRow, pressEnter } from "../mouse/mouse-list-row.js";
import { handleMcpTabKey } from "../mcp/mcp-key-bindings.js";
import type {
  McpPanelState,
  McpServerRow,
} from "../mcp/mcp-panel-state.js";

export interface McpListProps {
  panel: McpPanelState;
  maxRows: number;
}

export function McpList(props: McpListProps): ReactElement {
  const { panel, maxRows } = props;
  const total = panel.rows.length;
  if (total === 0) {
    return (
      <Box>
        <Text color={theme.colors.muted}>(no servers)</Text>
      </Box>
    );
  }
  const start = Math.max(
    0,
    Math.min(total - maxRows, Math.max(0, panel.cursor - Math.floor(maxRows / 2))),
  );
  const end = Math.min(total, start + maxRows);
  const slice = panel.rows.slice(start, end);
  return (
    <Box flexDirection="column">
      {slice.map((row, idx) => (
        <MouseListRow
          key={row.name}
          selected={start + idx === panel.cursor}
          onSelect={(mouse) =>
            mouse.dispatch({ type: "mcp_cursor_set", row: start + idx })
          }
          onActivate={pressEnter(handleMcpTabKey)}
        >
          <Row row={row} active={start + idx === panel.cursor} />
        </MouseListRow>
      ))}
    </Box>
  );
}

function Row({
  row,
  active,
}: {
  row: McpServerRow;
  active: boolean;
}): ReactElement {
  const marker = active ? ">" : " ";
  const stateColor = stateToColor(row.state);
  const stateBadge = `[${row.state}]`;
  const trustBadge =
    row.trust === "pure_read" ? "pure_read" : "approval_gated";
  const counts = `${row.toolCount} tools · ${row.resourceCount} res · ${row.promptCount} prompts`;
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={active ? theme.colors.accent : theme.colors.muted}>
          {marker}{" "}
        </Text>
        <Text bold>{padRight(row.name, 18)}</Text>
        <Text color={stateColor}>{padRight(stateBadge, 11)}</Text>
        <Text color={theme.colors.muted}>{padRight(row.transportKind, 18)}</Text>
        <Text color={theme.colors.muted}>{padRight(trustBadge, 16)}</Text>
        <Text color={theme.colors.muted}>{counts}</Text>
      </Box>
      {row.description ? (
        <Box marginLeft={2}>
          <Text color={theme.colors.muted}>{row.description}</Text>
        </Box>
      ) : null}
      {row.lastError ? (
        <Box marginLeft={2}>
          <Text color={theme.colors.error}>! {row.lastError}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function stateToColor(state: string): string {
  switch (state) {
    case "up":
      return theme.colors.success;
    case "down":
      return theme.colors.error;
    case "starting":
      return theme.colors.warn;
    case "disabled":
      return theme.colors.muted;
    default:
      return theme.colors.muted;
  }
}

function padRight(text: string, width: number): string {
  if (text.length >= width) return `${text.slice(0, width - 1)} `;
  return text + " ".repeat(width - text.length);
}
