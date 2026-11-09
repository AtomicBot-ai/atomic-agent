import type { PluginOverview, PluginPartOverview } from "../../plugins/plugin-overview.js";

/**
 * UI state for the "Plugins" tab: every installed plugin with what it
 * brings, its switches and whether its code may run. Rows are the shared
 * `PluginOverview` (src/plugins/plugin-overview.ts), the same data the
 * desktop Plugins screen and `atomic-agent plugin list --json` show.
 *
 * The orchestrator pushes rows in through `plugins_synced`; the reducer
 * only folds actions and never touches plugins.json.
 */

/**
 * `remove` and `allow-code` are one-key confirmations on the selected
 * plugin: both change what the agent can do, so neither happens on a
 * single stray keypress.
 */
export type PluginsPanelMode = "list" | "remove" | "allow-code";

export interface PluginsPanelState {
  mode: PluginsPanelMode;
  rows: readonly PluginOverview[];
  /** Index into `pluginsPanelLines(state)`. Clamped by the reducer. */
  selected: number;
  /** Name of the plugin whose parts are listed under it, if any. */
  expanded: string | null;
  /** False until the first sync, so the empty state does not flash. */
  loaded: boolean;
  busy: boolean;
  message: string | null;
  lastError: string | null;
}

export type PluginsLine =
  | { kind: "plugin"; plugin: PluginOverview }
  | { kind: "part"; plugin: PluginOverview; part: PluginPartOverview };

export function createInitialPluginsPanelState(): PluginsPanelState {
  return {
    mode: "list",
    rows: [],
    selected: 0,
    expanded: null,
    loaded: false,
    busy: false,
    message: null,
    lastError: null,
  };
}

/** The visible lines: one per plugin, plus the parts of the expanded one right under it. */
export function pluginsPanelLines(state: Pick<PluginsPanelState, "rows" | "expanded">): PluginsLine[] {
  const lines: PluginsLine[] = [];
  for (const plugin of state.rows) {
    lines.push({ kind: "plugin", plugin });
    if (plugin.name !== state.expanded) continue;
    for (const part of plugin.parts) lines.push({ kind: "part", plugin, part });
  }
  return lines;
}

export function selectedPluginsLine(state: PluginsPanelState): PluginsLine | undefined {
  return pluginsPanelLines(state)[state.selected];
}

/** Stable identity of a line, so a re-sync keeps the cursor on the same thing. */
export function pluginsLineKey(line: PluginsLine): string {
  return line.kind === "plugin" ? line.plugin.name : `${line.plugin.name}\0${line.part.id}`;
}

const KIND_LABEL: Record<PluginPartOverview["kind"], string> = {
  skill: "skill",
  mcp: "MCP server",
  hook: "hook",
  command: "command",
  agent: "subagent",
};

export function pluginPartKindLabel(kind: PluginPartOverview["kind"]): string {
  return KIND_LABEL[kind];
}

/** Proposed wording for the trust column; see the PR for the product decision. */
export function pluginTrustLabel(plugin: PluginOverview): string {
  switch (plugin.trust) {
    case "no-code": return "no code";
    case "code-allowed": return "code allowed";
    case "code-off": return "code off";
  }
}
