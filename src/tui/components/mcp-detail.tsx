import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import {
  MCP_DETAIL_TAB_ORDER,
  type McpDetailTab,
  type McpPanelState,
  type McpServerDetail,
} from "../mcp/mcp-panel-state.js";
import type {
  McpPromptMeta,
  McpResourceMeta,
  McpToolMeta,
} from "../../mcp/mcp-types.js";

export interface McpDetailProps {
  panel: McpPanelState;
  maxRows: number;
}

export function McpDetail(props: McpDetailProps): ReactElement {
  const { panel, maxRows } = props;
  const detail = panel.detail;
  if (!detail) {
    return (
      <Box>
        <Text color={theme.colors.muted}>(no server selected)</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <ServerHeader detail={detail} />
      <TabBar active={panel.detailTab} detail={detail} />
      <TabBody panel={panel} maxRows={maxRows} />
    </Box>
  );
}

function ServerHeader({ detail }: { detail: McpServerDetail }): ReactElement {
  const stateColor = stateToColor(detail.state);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold>{detail.name} </Text>
        <Text color={stateColor}>[{detail.state}]</Text>
        <Text color={theme.colors.muted}> · trust: {detail.trust}</Text>
      </Box>
      {detail.description ? (
        <Text color={theme.colors.muted}>{detail.description}</Text>
      ) : null}
      <Text color={theme.colors.muted}>{detail.transport}</Text>
      {detail.lastError ? (
        <Text color={theme.colors.error}>! {detail.lastError}</Text>
      ) : null}
    </Box>
  );
}

function TabBar({
  active,
  detail,
}: {
  active: McpDetailTab;
  detail: McpServerDetail;
}): ReactElement {
  const counts: Record<McpDetailTab, number> = {
    tools: detail.tools.length,
    resources: detail.resources.length,
    prompts: detail.prompts.length,
  };
  const labels = MCP_DETAIL_TAB_ORDER.map((tab, idx) => {
    const label = `${idx + 1}:${tab}(${counts[tab]})`;
    return tab === active ? `[${label}]` : label;
  });
  return (
    <Box marginBottom={1}>
      <Text color={theme.colors.muted}>{labels.join("  ")}</Text>
    </Box>
  );
}

function TabBody({
  panel,
  maxRows,
}: {
  panel: McpPanelState;
  maxRows: number;
}): ReactElement {
  const detail = panel.detail!;
  switch (panel.detailTab) {
    case "tools":
      return (
        <ItemList
          items={detail.tools.map(formatTool)}
          cursor={panel.detailCursor}
          maxRows={maxRows}
        />
      );
    case "resources":
      return (
        <ItemList
          items={detail.resources.map(formatResource)}
          cursor={panel.detailCursor}
          maxRows={maxRows}
        />
      );
    case "prompts":
      return (
        <ItemList
          items={detail.prompts.map(formatPrompt)}
          cursor={panel.detailCursor}
          maxRows={maxRows}
        />
      );
  }
}

function ItemList({
  items,
  cursor,
  maxRows,
}: {
  items: readonly { primary: string; secondary: string | null }[];
  cursor: number;
  maxRows: number;
}): ReactElement {
  if (items.length === 0) {
    return (
      <Box>
        <Text color={theme.colors.muted}>(empty)</Text>
      </Box>
    );
  }
  const start = Math.max(
    0,
    Math.min(items.length - maxRows, Math.max(0, cursor - Math.floor(maxRows / 2))),
  );
  const end = Math.min(items.length, start + maxRows);
  const slice = items.slice(start, end);
  return (
    <Box flexDirection="column">
      {slice.map((item, idx) => {
        const active = start + idx === cursor;
        return (
          <Box flexDirection="column" key={`${start + idx}-${item.primary}`}>
            <Box>
              <Text color={active ? theme.colors.accent : theme.colors.muted}>
                {active ? "> " : "  "}
              </Text>
              <Text bold={active}>{item.primary}</Text>
            </Box>
            {item.secondary ? (
              <Box marginLeft={2}>
                <Text color={theme.colors.muted}>{item.secondary}</Text>
              </Box>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}

function formatTool(t: McpToolMeta): { primary: string; secondary: string | null } {
  return {
    primary: `${t.rawName} (${t.resourceClass})`,
    secondary: t.description || null,
  };
}

function formatResource(r: McpResourceMeta): {
  primary: string;
  secondary: string | null;
} {
  const mime = r.mimeType ? ` [${r.mimeType}]` : "";
  const name = r.name ? ` · ${r.name}` : "";
  return {
    primary: `${r.uri}${mime}${name}`,
    secondary: r.description ?? null,
  };
}

function formatPrompt(p: McpPromptMeta): {
  primary: string;
  secondary: string | null;
} {
  const argList = (p.arguments ?? [])
    .map((a) => (a.required === false ? `${a.name}?` : a.name))
    .join(", ");
  return {
    primary: `${p.name}(${argList})`,
    secondary: p.description ?? null,
  };
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
