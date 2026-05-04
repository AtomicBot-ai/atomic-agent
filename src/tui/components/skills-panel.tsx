import { Box, Text } from "ink";
import { useMemo } from "react";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import {
  listSkillsFilterOrder,
  selectVisibleSkillRows,
} from "../skills/skills-filter.js";
import type {
  SkillsFilterStatus,
  SkillsPanelState,
} from "../skills/skills-panel-state.js";
import { SkillsList } from "./skills-list.js";
import { SkillsDetail } from "./skills-detail.js";

export interface SkillsPanelProps {
  panel: SkillsPanelState;
  maxRows?: number;
}

/**
 * Top-level router for the Skills tab. Switches between list and
 * detail views based on `panel.mode`. The filter bar + status line
 * stays visible in both modes so the operator never loses the
 * enabled/disabled count.
 */
export function SkillsPanel(props: SkillsPanelProps): ReactElement {
  const { panel, maxRows = 14 } = props;
  const visibleRows = useMemo(
    () => selectVisibleSkillRows(panel),
    [panel.rows, panel.filterStatus],
  );
  const enabledCount = panel.rows.filter((r) => !r.disabled).length;
  const disabledCount = panel.rows.length - enabledCount;
  return (
    <Box flexDirection="column">
      <FilterBar
        filter={panel.filterStatus}
        visibleCount={visibleRows.length}
        enabledCount={enabledCount}
        disabledCount={disabledCount}
        autoRefresh={panel.autoRefresh}
        loading={panel.loading}
      />
      {panel.lastError ? (
        <Box>
          <Text color={theme.colors.error}>! {panel.lastError}</Text>
        </Box>
      ) : null}
      {panel.mode === "list" ? (
        <SkillsList panel={panel} visibleRows={visibleRows} maxRows={maxRows} />
      ) : null}
      {panel.mode === "detail" ? <SkillsDetail panel={panel} /> : null}
    </Box>
  );
}

function FilterBar({
  filter,
  visibleCount,
  enabledCount,
  disabledCount,
  autoRefresh,
  loading,
}: {
  filter: SkillsFilterStatus;
  visibleCount: number;
  enabledCount: number;
  disabledCount: number;
  autoRefresh: boolean;
  loading: boolean;
}): ReactElement {
  const filters = listSkillsFilterOrder();
  return (
    <Box>
      <Text color={theme.colors.muted}>filter: </Text>
      {filters.map((f, idx) => (
        <Text key={f}>
          <Text
            color={f === filter ? theme.colors.accentSoft : theme.colors.muted}
            bold={f === filter}
          >
            {f}
          </Text>
          {idx < filters.length - 1 ? (
            <Text color={theme.colors.muted}> · </Text>
          ) : null}
        </Text>
      ))}
      <Text color={theme.colors.muted}>
        {"   "}
        {visibleCount} shown · {enabledCount} enabled · {disabledCount} disabled
        {autoRefresh ? " · auto" : ""}
        {loading ? " · …" : ""}
      </Text>
    </Box>
  );
}
