import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import type { MemoryPanelState } from "../memory/memory-panel-state.js";
import type { MemorySummaryRow } from "../memory/memory-panel-state.js";

export interface MemoryListProps {
  panel: MemoryPanelState;
  visibleRows: readonly MemorySummaryRow[];
  maxRows: number;
}

export function MemoryList(props: MemoryListProps): ReactElement {
  const { panel, visibleRows, maxRows } = props;
  if (panel.channelHint) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text color={theme.colors.warn}>{panel.channelHint}</Text>
      </Box>
    );
  }
  if (visibleRows.length === 0) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text color={theme.colors.muted}>
          (empty) — press `r` to refresh
          {panel.channel === "notes" ? " · `f` cycles active/archived/all" : ""}
        </Text>
      </Box>
    );
  }
  const clamped = Math.max(0, Math.min(panel.cursor, visibleRows.length - 1));
  const windowStart = computeWindowStart(clamped, visibleRows.length, maxRows);
  const pageRows = visibleRows.slice(windowStart, windowStart + maxRows);
  const hiddenBefore = windowStart;
  const hiddenAfter = Math.max(
    0,
    visibleRows.length - windowStart - pageRows.length,
  );
  return (
    <Box flexDirection="column">
      <HeaderRow channel={panel.channel} />
      {hiddenBefore > 0 ? (
        <Text color={theme.colors.muted}>↑ {hiddenBefore} above</Text>
      ) : null}
      {pageRows.map((row, idx) => (
        <MemoryRow
          key={row.rowKey}
          row={row}
          selected={idx + windowStart === clamped}
        />
      ))}
      {hiddenAfter > 0 ? (
        <Text color={theme.colors.muted}>↓ {hiddenAfter} below</Text>
      ) : null}
      <HintsRow channel={panel.channel} />
    </Box>
  );
}

function HeaderRow({ channel }: { channel: string }): ReactElement {
  return (
    <Box>
      <Text color={theme.colors.muted}>
        {"  "}primary                    secondary / meta
      </Text>
      <Text color={theme.colors.muted}>{"     "}[{channel}]</Text>
    </Box>
  );
}

function HintsRow({ channel }: { channel: string }): ReactElement {
  const extra =
    channel === "notes"
      ? " · f archive filter"
      : channel === "links"
        ? " · Enter opens from-note"
        : "";
  return (
    <Box marginTop={1}>
      <Text color={theme.colors.muted}>
        j/k · Enter detail · r refresh · a auto · [/] channel · 1-6 jump{extra}
      </Text>
    </Box>
  );
}

function MemoryRow({
  row,
  selected,
}: {
  row: MemorySummaryRow;
  selected: boolean;
}): ReactElement {
  const chevron = selected ? theme.glyphs.chevronRight : " ";
  const primary = truncate(row.primary, 28).padEnd(30);
  const accent = selected ? theme.colors.accentSoft : undefined;
  return (
    <Box>
      <Text color={accent} bold={selected}>
        {chevron} {primary}
      </Text>
      <Text color={theme.colors.muted}>{truncate(row.secondary, 36)}</Text>
      {row.meta ? (
        <Text color={theme.colors.muted}> · {truncate(row.meta, 28)}</Text>
      ) : null}
    </Box>
  );
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function computeWindowStart(cursor: number, total: number, size: number): number {
  if (total <= size) return 0;
  if (cursor < size) return 0;
  return Math.min(cursor - size + 1, total - size);
}
