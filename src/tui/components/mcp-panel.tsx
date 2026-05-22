import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import type { McpPanelState } from "../mcp/mcp-panel-state.js";
import { McpAddModal } from "./mcp-add-modal.js";
import { McpDetail } from "./mcp-detail.js";
import { McpList } from "./mcp-list.js";
import { McpRemoveModal } from "./mcp-remove-modal.js";

export interface McpPanelProps {
  panel: McpPanelState;
  maxRows?: number;
  onAddJsonChange?: (json: string) => void;
  onAddSubmit?: (json: string) => void;
  onAddCancel?: () => void;
}

export function McpPanel(props: McpPanelProps): ReactElement {
  const {
    panel,
    maxRows = 14,
    onAddJsonChange,
    onAddSubmit,
    onAddCancel,
  } = props;
  return (
    <Box flexDirection="column">
      <Header panel={panel} />
      {panel.lastError ? (
        <Box>
          <Text color={theme.colors.error}>! {panel.lastError}</Text>
        </Box>
      ) : null}
      {panel.emptyHint && panel.rows.length === 0 ? (
        <Box marginBottom={1}>
          <Text color={theme.colors.muted}>{panel.emptyHint}</Text>
        </Box>
      ) : null}
      {panel.addModal !== null ? (
        <McpAddModal
          state={panel.addModal}
          onJsonChange={onAddJsonChange ?? noop}
          onSubmit={onAddSubmit ?? noopString}
          onCancel={onAddCancel ?? noop}
        />
      ) : (
        <>
          {panel.mode === "list" ? (
            <McpList panel={panel} maxRows={maxRows} />
          ) : (
            <McpDetail panel={panel} maxRows={maxRows} />
          )}
          {panel.removeConfirm !== null ? (
            <McpRemoveModal confirm={panel.removeConfirm} />
          ) : null}
        </>
      )}
    </Box>
  );
}

function noop(): void {}
function noopString(_value: string): void {}

function Header({ panel }: { panel: McpPanelState }): ReactElement {
  const status = [
    panel.loading ? "loading" : null,
    panel.autoRefresh ? "auto" : "manual",
    panel.lastRefreshedAt
      ? `refreshed ${new Date(panel.lastRefreshedAt).toLocaleTimeString()}`
      : null,
    `${panel.rows.length} servers`,
  ]
    .filter(Boolean)
    .join(" · ");
  const hint =
    panel.addModal !== null
      ? "Enter submit · Esc cancel · paste JSON of one MCP server"
      : panel.removeConfirm !== null
        ? "y / Enter confirm · n / Esc cancel"
        : panel.mode === "list"
          ? "j/k move · Enter open · n add · d remove · r refresh · a auto"
          : "Esc back · 1/2/3 tools/res/prompts · [ ] cycle · d remove · r refresh";
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={theme.colors.muted}>{status}</Text>
      <Text color={theme.colors.muted}>{hint}</Text>
    </Box>
  );
}
