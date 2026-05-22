import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import type { McpRemoveConfirmState } from "../mcp/mcp-panel-state.js";

export interface McpRemoveModalProps {
  confirm: McpRemoveConfirmState;
}

/**
 * Y/N confirmation modal shown before an MCP server is removed from
 * `config.json`. Rendering mirrors `TasksCancelModal` so the operator
 * sees a consistent warning surface across tabs. The submitting flag
 * keeps the dialog open while the persist call is in flight so a
 * spurious second `y` cannot double-fire the write.
 */
export function McpRemoveModal(props: McpRemoveModalProps): ReactElement {
  const { confirm } = props;
  const borderColor = confirm.error
    ? theme.colors.error
    : theme.colors.warn;
  return (
    <Box
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      flexDirection="column"
    >
      <Text color={borderColor} bold>
        remove MCP server?
      </Text>
      <Text>
        <Text color={theme.colors.muted}>name:</Text> {confirm.name}
      </Text>
      <Text color={theme.colors.muted}>
        rewrites config.json; restart atomic-agent to drop the live connection.
      </Text>
      {confirm.error ? (
        <Text color={theme.colors.error}>! {confirm.error}</Text>
      ) : null}
      <Text color={theme.colors.muted}>
        {confirm.submitting
          ? "working…"
          : "y / Enter = confirm · n / Esc = keep"}
      </Text>
    </Box>
  );
}
