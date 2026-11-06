import { Box, Text } from "ink";
import type { ReactElement } from "react";

import { formatPluginCounts, type PluginOverview, type PluginPartOverview } from "../../../plugins/plugin-overview.js";
import { theme } from "../../theme/theme.js";
import {
  pluginPartKindLabel,
  pluginsPanelLines,
  pluginTrustLabel,
  selectedPluginsLine,
  type PluginsLine,
  type PluginsPanelState,
} from "../plugins-panel-state.js";

export interface PluginsPanelProps {
  panel: PluginsPanelState;
  /** Rows the pane can spend on the list. */
  maxRows?: number;
}

/** Header, detail and hint lines around the list. */
const FIXED_ROWS = 4;

/**
 * The Plugins tab: every installed plugin with its version, what it
 * brings, whether it can run code and whether that code is allowed, and
 * a "needs a key" mark when a switched-on MCP server lacks a variable.
 * Enter opens a plugin's parts, each with its own switch.
 *
 * Installing is not here on purpose: `atomic-agent plugin install
 * <folder>` (and the marketplace flow, which lands separately) own it.
 */
export function PluginsPanel({ panel, maxRows = 14 }: PluginsPanelProps): ReactElement {
  const listRows = Math.max(1, maxRows - FIXED_ROWS);
  return (
    <Box flexDirection="column">
      <Header panel={panel} />
      {panel.lastError ? (
        <Box height={1} overflow="hidden">
          <Text color={theme.colors.error} wrap="truncate-end">! {panel.lastError}</Text>
        </Box>
      ) : null}
      {panel.message ? (
        <Box height={1} overflow="hidden">
          <Text color={theme.colors.accentSoft} wrap="truncate-end">{panel.message}</Text>
        </Box>
      ) : null}
      <ListView panel={panel} maxRows={listRows} />
      <Detail panel={panel} />
      <Box marginTop={1}>
        <Text color={theme.colors.muted} wrap="truncate-end">{hint(panel)}</Text>
      </Box>
    </Box>
  );
}

function Header({ panel }: { panel: PluginsPanelState }): ReactElement {
  const on = panel.rows.filter((r) => r.enabled).length;
  const keys = panel.rows.filter((r) => r.enabled && r.needsKey).length;
  return (
    <Box>
      <Text bold color={theme.colors.accentSoft}>
        Plugins
      </Text>
      <Text color={theme.colors.muted}>
        {"  "}
        {panel.rows.length} installed · {on} on
        {keys > 0 ? ` · ${keys} need a key` : ""}
      </Text>
      {panel.busy ? <Text color={theme.colors.muted}>{"  "}…</Text> : null}
    </Box>
  );
}

function ListView({ panel, maxRows }: { panel: PluginsPanelState; maxRows: number }): ReactElement {
  if (!panel.loaded) {
    return (
      <Box marginTop={1}>
        <Text color={theme.colors.muted}>reading plugins…</Text>
      </Box>
    );
  }
  if (panel.rows.length === 0) {
    return (
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.colors.muted}>No plugins installed.</Text>
        <Text color={theme.colors.muted}>
          Install one from a terminal: atomic-agent plugin install {"<folder>"}
        </Text>
      </Box>
    );
  }
  const lines = pluginsPanelLines(panel);
  // Keep the cursor on screen when the list outgrows the pane.
  const visible = Math.max(1, maxRows);
  const start = Math.max(0, Math.min(panel.selected - visible + 1, lines.length - visible));
  return (
    <Box marginTop={1} flexDirection="column">
      {lines.slice(start, start + visible).map((line, i) => {
        const index = start + i;
        const active = index === panel.selected;
        return (
          <Box key={lineKey(line)} height={1} overflow="hidden">
            {line.kind === "plugin" ? (
              <PluginLine plugin={line.plugin} active={active} panel={panel} />
            ) : (
              <PartLine plugin={line.plugin} part={line.part} active={active} />
            )}
          </Box>
        );
      })}
    </Box>
  );
}

function PluginLine({
  plugin,
  active,
  panel,
}: {
  plugin: PluginOverview;
  active: boolean;
  panel: PluginsPanelState;
}): ReactElement {
  const open = panel.expanded === plugin.name;
  const confirming = active && panel.mode !== "list";
  return (
    <Text wrap="truncate-end">
      <Text color={active ? theme.colors.accent : theme.colors.muted}>{active ? "> " : "  "}</Text>
      <Text color={theme.colors.muted}>{open ? "▾ " : "▸ "}</Text>
      <Switch on={plugin.enabled} />
      <Text bold={active}> {plugin.name}</Text>
      <Text color={theme.colors.muted}> {plugin.version}</Text>
      {confirming ? (
        <Text color={theme.colors.error}>
          {panel.mode === "remove"
            ? "  remove this plugin and its files? y / esc"
            : `  allow it to run ${plugin.codeParts.join("; ") || "code"}? y / esc`}
        </Text>
      ) : plugin.filesOk ? (
        <>
          <Text color={theme.colors.muted}>{"  "}{formatPluginCounts(plugin.counts)}</Text>
          {plugin.runsCode ? (
            <Text color={plugin.trust === "code-allowed" ? theme.colors.accentSoft : theme.colors.warn}>
              {"  "}[runs code · {pluginTrustLabel(plugin)}]
            </Text>
          ) : (
            <Text color={theme.colors.muted}>{"  "}[{pluginTrustLabel(plugin)}]</Text>
          )}
          {plugin.needsKey ? <Text color={theme.colors.warn}>{"  "}[needs a key]</Text> : null}
        </>
      ) : (
        <Text color={theme.colors.error}>{"  "}files missing — reinstall it</Text>
      )}
    </Text>
  );
}

function PartLine({
  plugin,
  part,
  active,
}: {
  plugin: PluginOverview;
  part: PluginPartOverview;
  active: boolean;
}): ReactElement {
  const waitingForCode = plugin.enabled && part.enabled && !part.active;
  return (
    <Text wrap="truncate-end">
      <Text color={active ? theme.colors.accent : theme.colors.muted}>{active ? "> " : "  "}</Text>
      <Text>{"    "}</Text>
      <Switch on={part.enabled} dim={!plugin.enabled} />
      <Text color={theme.colors.muted}> {pluginPartKindLabel(part.kind)}</Text>
      <Text bold={active} color={plugin.enabled ? undefined : theme.colors.muted}> {part.name}</Text>
      {part.runsCode ? <Text color={theme.colors.muted}>{"  "}runs code</Text> : null}
      {waitingForCode ? <Text color={theme.colors.warn}>{"  "}off until code is allowed (c)</Text> : null}
      {part.missingKeys.length > 0 ? (
        <Text color={theme.colors.warn}>{"  "}needs {part.missingKeys.join(", ")}</Text>
      ) : null}
    </Text>
  );
}

function Switch({ on, dim = false }: { on: boolean; dim?: boolean }): ReactElement {
  return (
    <Text color={on && !dim ? theme.colors.accentSoft : theme.colors.muted}>{on ? "[on] " : "[off]"}</Text>
  );
}

/** One line about the selected plugin: description, source, missing keys. */
function Detail({ panel }: { panel: PluginsPanelState }): ReactElement | null {
  if (panel.mode !== "list") return null;
  const line = selectedPluginsLine(panel);
  if (!line) return null;
  const p = line.plugin;
  const bits = [
    p.description,
    `from ${p.sourceLabel}`,
    p.needsKey ? `set ${p.missingKeys.join(", ")} in ~/.atomic-agent/.env` : "",
    p.error && !p.filesOk ? p.error : "",
  ].filter(Boolean);
  return (
    <Box height={1} overflow="hidden">
      <Text color={theme.colors.muted} wrap="truncate-end">
        {"  "}
        {bits.join(" · ")}
      </Text>
    </Box>
  );
}

function hint(panel: PluginsPanelState): string {
  if (panel.mode !== "list") return "y confirm · any other key cancels";
  if (panel.rows.length === 0) return "r refresh";
  return "↑↓ move · enter parts · space on/off · c allow/stop code · d remove · r refresh";
}

function lineKey(line: PluginsLine): string {
  return line.kind === "plugin" ? line.plugin.name : `${line.plugin.name}/${line.part.id}`;
}
