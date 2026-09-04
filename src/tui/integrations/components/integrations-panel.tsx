import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../../theme/theme.js";
import type {
  IntegrationRow,
  IntegrationsPanelState,
} from "../integrations-panel-state.js";
import type { IntegrationStatusLevel } from "../../../integrations/index.js";

export interface IntegrationsPanelProps {
  panel: IntegrationsPanelState;
  maxRows?: number;
}

/**
 * The Integrations tab: one place for every third-party credential.
 *
 * List mode shows every integration with a status badge; detail mode
 * shows one integration's fields, masked, with edit / clear. Secrets are
 * never rendered in the clear except in the edit buffer the operator is
 * actively typing into.
 */
export function IntegrationsPanel({
  panel,
  maxRows = 14,
}: IntegrationsPanelProps): ReactElement {
  const row = panel.rows[panel.selected];
  return (
    <Box flexDirection="column">
      <Header panel={panel} />
      {panel.lastError ? (
        <Box>
          <Text color={theme.colors.error}>! {panel.lastError}</Text>
        </Box>
      ) : null}
      {panel.message ? (
        <Box>
          <Text color={theme.colors.accentSoft}>{panel.message}</Text>
        </Box>
      ) : null}
      {panel.rows.length === 0 ? (
        <Box marginTop={1}>
          <Text color={theme.colors.muted}>no integrations available</Text>
        </Box>
      ) : panel.mode === "list" ? (
        <ListView panel={panel} maxRows={maxRows} />
      ) : (
        <DetailView panel={panel} row={row} />
      )}
      <Box marginTop={1}>
        <Text color={theme.colors.muted}>{hint(panel)}</Text>
      </Box>
    </Box>
  );
}

function Header({ panel }: { panel: IntegrationsPanelState }): ReactElement {
  const configured = panel.rows.filter(
    (r) => r.level === "configured" || r.level === "connected",
  ).length;
  return (
    <Box>
      <Text bold color={theme.colors.accentSoft}>
        Integrations
      </Text>
      <Text color={theme.colors.muted}>
        {"  "}
        {configured}/{panel.rows.length} configured
      </Text>
      {panel.busy ? <Text color={theme.colors.muted}>{"  "}…</Text> : null}
    </Box>
  );
}

function ListView({
  panel,
  maxRows,
}: {
  panel: IntegrationsPanelState;
  maxRows: number;
}): ReactElement {
  return (
    <Box marginTop={1} flexDirection="column">
      {panel.rows.slice(0, maxRows).map((row, i) => (
        <Box key={row.id} flexDirection="column">
          <Box>
            <Text
              color={
                i === panel.selected
                  ? theme.colors.accent
                  : theme.colors.muted
              }
            >
              {i === panel.selected ? "> " : "  "}
            </Text>
            <Text bold={i === panel.selected}>{row.label}</Text>
            <Text color={badgeColor(row.level)}>
              {"  "}
              {badgeText(row)}
            </Text>
          </Box>
          <Box>
            <Text color={theme.colors.muted}>{"    "}{row.summary}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}

function DetailView({
  panel,
  row,
}: {
  panel: IntegrationsPanelState;
  row: IntegrationRow | undefined;
}): ReactElement {
  if (!row) {
    return (
      <Box marginTop={1}>
        <Text color={theme.colors.muted}>nothing selected</Text>
      </Box>
    );
  }
  return (
    <Box marginTop={1} flexDirection="column">
      <Box>
        <Text bold>{row.label}</Text>
        <Text color={badgeColor(row.level)}>
          {"  "}
          {badgeText(row)}
        </Text>
      </Box>
      {row.docsUrl ? (
        <Box>
          <Text color={theme.colors.muted}>{"  "}{row.docsUrl}</Text>
        </Box>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        {row.fields.map((field, i) => {
          const active = i === panel.selectedField;
          const editing = active && panel.mode === "edit";
          return (
            <Box key={field.key} flexDirection="column">
              <Box>
                <Text
                  color={active ? theme.colors.accent : theme.colors.muted}
                >
                  {active ? "> " : "  "}
                </Text>
                <Text>{field.label}</Text>
                <Text color={theme.colors.muted}>{"  "}</Text>
                {editing ? (
                  <Text color={theme.colors.accent}>
                    {panel.editBuffer}
                    <Text color={theme.colors.muted}>▏</Text>
                  </Text>
                ) : (
                  <Text
                    color={
                      field.present
                        ? theme.colors.accentSoft
                        : theme.colors.muted
                    }
                  >
                    {field.display}
                  </Text>
                )}
              </Box>
              {active && field.help ? (
                <Box>
                  <Text color={theme.colors.muted}>{"    "}{field.help}</Text>
                </Box>
              ) : null}
            </Box>
          );
        })}
      </Box>
      {!row.appliesLive ? (
        <Box marginTop={1}>
          <Text color={theme.colors.muted}>
            {"  "}changes take effect after a restart
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

function badgeText(row: IntegrationRow): string {
  if (row.detail) return `· ${row.detail}`;
  switch (row.level) {
    case "connected":
      return "· connected";
    case "configured":
      return "· configured";
    case "error":
      return "· error";
    default:
      return "· not configured";
  }
}

function badgeColor(level: IntegrationStatusLevel): string {
  switch (level) {
    case "connected":
      return theme.colors.accentSoft;
    case "configured":
      return theme.colors.accentSoft;
    case "error":
      return theme.colors.error;
    default:
      return theme.colors.muted;
  }
}

function hint(panel: IntegrationsPanelState): string {
  if (panel.mode === "edit") return "enter save · esc cancel";
  if (panel.mode === "detail") {
    return "↑/↓ field · e edit · d clear · esc back";
  }
  return "↑/↓ move · enter open · r refresh";
}
