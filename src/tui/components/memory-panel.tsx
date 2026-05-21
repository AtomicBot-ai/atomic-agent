import { Box, Text } from "ink";
import { useMemo } from "react";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import { selectVisibleMemoryRows } from "../memory/memory-filter.js";
import type { MemoryChannel, MemoryPanelState } from "../memory/memory-panel-state.js";
import { MemoryDetail } from "./memory-detail.js";
import { MemoryList } from "./memory-list.js";

export interface MemoryPanelProps {
  panel: MemoryPanelState;
  maxRows?: number;
}

export function MemoryPanel(props: MemoryPanelProps): ReactElement {
  const { panel, maxRows = 14 } = props;
  const visibleRows = useMemo(
    () => selectVisibleMemoryRows(panel),
    [panel.rows, panel.searchQuery],
  );
  return (
    <Box flexDirection="column">
      <ChannelBar panel={panel} />
      {panel.lastError ? (
        <Box>
          <Text color={theme.colors.error}>! {panel.lastError}</Text>
        </Box>
      ) : null}
      {panel.mode === "list" ? (
        <MemoryList panel={panel} visibleRows={visibleRows} maxRows={maxRows} />
      ) : (
        <MemoryDetail detail={panel.detail} />
      )}
    </Box>
  );
}

function ChannelBar({ panel }: { panel: MemoryPanelState }): ReactElement {
  const labels = panel.availableChannels.map((ch, idx) =>
    formatChannelLabel(ch, idx + 1, ch === panel.channel),
  );
  const status = [
    panel.loading ? "loading" : null,
    panel.autoRefresh ? "auto" : "manual",
    panel.lastRefreshedAt
      ? `refreshed ${new Date(panel.lastRefreshedAt).toLocaleTimeString()}`
      : null,
    panel.channel === "notes"
      ? `notes: ${panel.notesArchiveFilter}`
      : null,
    panel.searchQuery.trim()
      ? `search: "${panel.searchQuery.trim()}"`
      : null,
    `${visibleCount(panel)} shown`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={theme.colors.muted}>{labels.join("  ")}</Text>
      <Text color={theme.colors.muted}>{status}</Text>
    </Box>
  );
}

function formatChannelLabel(
  ch: MemoryChannel,
  num: number,
  active: boolean,
): string {
  const label = `${num}:${ch}`;
  return active ? `[${label}]` : label;
}

function visibleCount(panel: MemoryPanelState): number {
  return selectVisibleMemoryRows(panel).length;
}
