import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import { MouseListRow, pressEnter } from "../mouse/mouse-list-row.js";
import { handleSkillsTabKey } from "../skills/skills-key-bindings.js";
import type {
  SkillSummaryRow,
  SkillsPanelState,
} from "../skills/skills-panel-state.js";

export interface SkillsListProps {
  panel: SkillsPanelState;
  visibleRows: readonly SkillSummaryRow[];
  maxRows: number;
}

/**
 * Scrollable table view. `visibleRows` is already filtered + sorted by
 * the caller; this component owns only the cursor windowing and the
 * per-row rendering contract.
 */
export function SkillsList(props: SkillsListProps): ReactElement {
  const { panel, visibleRows, maxRows } = props;
  if (visibleRows.length === 0) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text color={theme.colors.muted}>
          no skills match the current filter — install one with
          `atomic-agent skill install`, or press `f` to cycle filter / `r`
          to refresh.
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
      <HeaderRow />
      {hiddenBefore > 0 ? (
        <Text color={theme.colors.muted}>↑ {hiddenBefore} above</Text>
      ) : null}
      {pageRows.map((row, idx) => (
        <MouseListRow
          key={row.name}
          selected={idx + windowStart === clamped}
          onSelect={(mouse) =>
            mouse.dispatch({ type: "skills_cursor_set", row: idx + windowStart })
          }
          onActivate={pressEnter(handleSkillsTabKey)}
        >
          <SkillRow row={row} selected={idx + windowStart === clamped} />
        </MouseListRow>
      ))}
      {hiddenAfter > 0 ? (
        <Text color={theme.colors.muted}>↓ {hiddenAfter} below</Text>
      ) : null}
      <HintsRow />
      <HubCta />
    </Box>
  );
}

/**
 * Standalone call-to-action banner for the Skills Hub. Kept separate from
 * the inline hint row so the "browse & install" entry point is visually
 * distinct from the per-row navigation keys.
 */
function HubCta(): ReactElement {
  return (
    <Box
      marginTop={1}
      borderStyle="round"
      borderColor={theme.colors.accent}
      paddingX={1}
    >
      <Text color={theme.colors.accent} bold>
        i
      </Text>
      <Text color={theme.colors.accent}> · Skills Hub</Text>
      <Text color={theme.colors.muted}>
        {"  "}browse &amp; install skills from ClawHub
      </Text>
    </Box>
  );
}

function HeaderRow(): ReactElement {
  return (
    <Box>
      <Text color={theme.colors.muted}>
        {"  "}state     source   version  name                       description
      </Text>
    </Box>
  );
}

function HintsRow(): ReactElement {
  return (
    <Box marginTop={1}>
      <Text color={theme.colors.muted}>
        j/k move · Enter detail · e toggle · d remove · r refresh · a auto · f
        filter
      </Text>
    </Box>
  );
}

function SkillRow({
  row,
  selected,
}: {
  row: SkillSummaryRow;
  selected: boolean;
}): ReactElement {
  const chevron = selected ? theme.glyphs.chevronRight : " ";
  const stateLabel = (row.disabled ? "disabled" : "enabled").padEnd(9);
  const stateColor = row.disabled ? theme.colors.warn : theme.colors.success;
  const sourceLabel = `[${row.source}]`.padEnd(9);
  const versionLabel = `v${row.version}`.padEnd(8);
  const nameLabel = truncate(row.name, 24).padEnd(26);
  const accent = selected ? theme.colors.accentSoft : undefined;
  const dimmed = row.disabled ? theme.colors.muted : undefined;
  return (
    <Box>
      <Text color={accent} bold={selected}>
        {chevron} <Text color={stateColor}>{stateLabel}</Text>
      </Text>
      <Text color={theme.colors.muted}>
        {sourceLabel} {versionLabel}
      </Text>
      <Text color={accent ?? dimmed}>{nameLabel}</Text>
      <Text color={dimmed ?? accent}>{truncate(row.description, 60)}</Text>
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
