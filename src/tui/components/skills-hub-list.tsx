import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import { formatDownloads } from "../skills/format-downloads.js";
import type {
  HubSkillRow,
  SkillsPanelState,
} from "../skills/skills-panel-state.js";

export interface SkillsHubListProps {
  panel: SkillsPanelState;
  maxRows?: number;
}

/**
 * Hub browse/search view. Renders the search line, the catalog rows
 * (cursor-windowed), and the key hints. Install confirmation is a
 * separate overlay component routed by `SkillsPanel`.
 */
export function SkillsHubList(props: SkillsHubListProps): ReactElement {
  const { panel, maxRows = 12 } = props;
  return (
    <Box flexDirection="column">
      <SearchLine
        query={panel.hubQuery}
        editing={panel.hubSearchEditing}
        loading={panel.hubLoading}
        count={panel.hubRows.length}
      />
      {panel.hubError ? (
        <Box>
          <Text color={theme.colors.error}>! {panel.hubError}</Text>
        </Box>
      ) : null}
      {panel.installError ? (
        <Box>
          <Text color={theme.colors.error}>
            ! install failed: {panel.installError}
          </Text>
        </Box>
      ) : null}
      {renderBody(panel, maxRows)}
      <HintsRow />
    </Box>
  );
}

function renderBody(panel: SkillsPanelState, maxRows: number): ReactElement {
  if (panel.hubLoading && panel.hubRows.length === 0) {
    return (
      <Box paddingY={1}>
        <Text color={theme.colors.muted}>browsing the skill hub…</Text>
      </Box>
    );
  }
  if (panel.hubRows.length === 0) {
    return (
      <Box paddingY={1}>
        <Text color={theme.colors.muted}>
          no skills found — press `/` to search, `r` to re-browse, or `Esc`
          to go back.
        </Text>
      </Box>
    );
  }
  const clamped = Math.max(
    0,
    Math.min(panel.hubCursor, panel.hubRows.length - 1),
  );
  const windowStart = computeWindowStart(
    clamped,
    panel.hubRows.length,
    maxRows,
  );
  const pageRows = panel.hubRows.slice(windowStart, windowStart + maxRows);
  const hiddenBefore = windowStart;
  const hiddenAfter = Math.max(
    0,
    panel.hubRows.length - windowStart - pageRows.length,
  );
  return (
    <Box flexDirection="column">
      {hiddenBefore > 0 ? (
        <Text color={theme.colors.muted}>↑ {hiddenBefore} above</Text>
      ) : null}
      {pageRows.map((row, idx) => (
        <HubRow
          key={row.identifier}
          row={row}
          selected={idx + windowStart === clamped}
        />
      ))}
      {hiddenAfter > 0 ? (
        <Text color={theme.colors.muted}>↓ {hiddenAfter} below</Text>
      ) : null}
    </Box>
  );
}

function SearchLine({
  query,
  editing,
  loading,
  count,
}: {
  query: string;
  editing: boolean;
  loading: boolean;
  count: number;
}): ReactElement {
  return (
    <Box>
      <Text color={theme.colors.muted}>hub search: </Text>
      <Text color={editing ? theme.colors.accentSoft : undefined}>
        {query.length > 0 ? query : editing ? "" : "(all)"}
        {editing ? "▌" : ""}
      </Text>
      <Text color={theme.colors.muted}>
        {"   "}
        {count} result{count === 1 ? "" : "s"}
        {loading ? " · …" : ""}
      </Text>
    </Box>
  );
}

function HintsRow(): ReactElement {
  return (
    <Box marginTop={1}>
      <Text color={theme.colors.muted}>
        j/k move · Enter open card · / search · r re-browse · Esc back
      </Text>
    </Box>
  );
}

function HubRow({
  row,
  selected,
}: {
  row: HubSkillRow;
  selected: boolean;
}): ReactElement {
  const chevron = selected ? theme.glyphs.chevronRight : " ";
  const accent = selected ? theme.colors.accentSoft : undefined;
  const idLabel = truncate(formatHubIdentifier(row.identifier), 30).padEnd(32);
  const downloadsLabel = `↓${formatDownloads(row.downloads)}`.padEnd(9);
  const badge = row.source === "clawhub" ? "claw" : "gh  ";
  const badgeColor =
    row.source === "clawhub" ? theme.colors.accent : theme.colors.muted;
  return (
    <Box>
      <Text color={accent} bold={selected}>
        {chevron}{" "}
      </Text>
      <Text color={badgeColor}>{badge} </Text>
      <Text color={accent} bold={selected}>
        {idLabel}
      </Text>
      <Text color={theme.colors.muted}>{downloadsLabel}</Text>
      <Text color={accent ?? theme.colors.muted}>
        {truncate(row.description, 48)}
      </Text>
    </Box>
  );
}

/**
 * Compact display label for a hub identifier. Repo paths can nest a
 * skills subtree (`anthropics/skills/skills/brand-guidelines`), which
 * reads like a mount path. Collapse it to the first segment (owner) and
 * the last segment (skill dir): `anthropics/…/brand-guidelines`. Two-part
 * identifiers (`owner/repo`) are shown verbatim. Display-only — the full
 * identifier is still used for install.
 */
function formatHubIdentifier(identifier: string): string {
  const segments = identifier.split("/").filter((s) => s.length > 0);
  if (segments.length <= 2) return identifier;
  return `${segments[0]}/…/${segments[segments.length - 1]}`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function computeWindowStart(
  cursor: number,
  total: number,
  size: number,
): number {
  if (total <= size) return 0;
  if (cursor < size) return 0;
  return Math.min(cursor - size + 1, total - size);
}
