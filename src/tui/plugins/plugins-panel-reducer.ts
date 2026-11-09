import type { TuiState } from "../tui-state.js";
import { isPluginsAction, type PluginsAction } from "./plugins-actions.js";
import {
  pluginsLineKey,
  pluginsPanelLines,
  type PluginsPanelState,
} from "./plugins-panel-state.js";

/**
 * Reducer slice for `state.pluginsPanel`. Returns an updated `TuiState`
 * when the action belongs to this slice, `null` otherwise so the root
 * reducer can fall through. Pure: every write to plugins.json lives in
 * `plugins-orchestrator.ts`.
 */
export function reducePluginsAction(
  state: TuiState,
  action: { type: string },
): TuiState | null {
  if (!isPluginsAction(action)) return null;
  const panel = state.pluginsPanel;
  const next = reducePanel(panel, action);
  if (next === panel) return state;
  return { ...state, pluginsPanel: next };
}

export function reducePanel(
  panel: PluginsPanelState,
  action: PluginsAction,
): PluginsPanelState {
  switch (action.type) {
    case "plugins_synced": {
      // A re-sync (after a toggle, or a plugin installed from another
      // terminal) must keep the cursor on the same plugin or part.
      const before = pluginsPanelLines(panel)[panel.selected];
      const expanded =
        panel.expanded !== null && action.rows.some((r) => r.name === panel.expanded)
          ? panel.expanded
          : null;
      const next = { ...panel, rows: action.rows, expanded, loaded: true };
      const lines = pluginsPanelLines(next);
      let selected = -1;
      if (before) {
        const key = pluginsLineKey(before);
        selected = lines.findIndex((l) => pluginsLineKey(l) === key);
        if (selected === -1) {
          selected = lines.findIndex((l) => l.kind === "plugin" && l.plugin.name === before.plugin.name);
        }
      }
      if (selected === -1) selected = clamp(panel.selected, lines.length);
      const mode = panel.mode !== "list" && lines[selected]?.kind !== "plugin" ? "list" : panel.mode;
      return { ...next, selected, mode };
    }
    case "plugins_moved": {
      if (panel.mode !== "list") return panel;
      const selected = clamp(panel.selected + action.delta, pluginsPanelLines(panel).length);
      if (selected === panel.selected) return panel;
      return { ...panel, selected };
    }
    case "plugins_expand_toggled": {
      if (panel.mode !== "list") return panel;
      const line = pluginsPanelLines(panel)[panel.selected];
      if (!line || line.kind !== "plugin") return panel;
      const name = line.plugin.name;
      const expanded = panel.expanded === name ? null : name;
      // Collapsing another plugin above the cursor would shift it: anchor on the plugin row.
      const lines = pluginsPanelLines({ rows: panel.rows, expanded });
      const selected = lines.findIndex((l) => l.kind === "plugin" && l.plugin.name === name);
      return { ...panel, expanded, selected: Math.max(0, selected) };
    }
    case "plugins_collapsed": {
      if (panel.mode !== "list" || panel.expanded === null) return panel;
      const name = panel.expanded;
      const lines = pluginsPanelLines({ rows: panel.rows, expanded: null });
      const selected = lines.findIndex((l) => l.kind === "plugin" && l.plugin.name === name);
      return { ...panel, expanded: null, selected: Math.max(0, selected) };
    }
    case "plugins_remove_started":
    case "plugins_allow_code_started": {
      if (panel.mode !== "list") return panel;
      const line = pluginsPanelLines(panel)[panel.selected];
      if (!line || line.kind !== "plugin") return panel;
      if (action.type === "plugins_allow_code_started" && !line.plugin.runsCode) return panel;
      return {
        ...panel,
        mode: action.type === "plugins_remove_started" ? "remove" : "allow-code",
        message: null,
        lastError: null,
      };
    }
    case "plugins_cancelled":
      if (panel.mode === "list") return panel;
      return { ...panel, mode: "list" };
    case "plugins_action_started":
      return { ...panel, busy: true };
    case "plugins_action_settled":
      return {
        ...panel,
        busy: false,
        mode: "list",
        message: action.message ?? null,
        lastError: action.error ?? null,
      };
    case "plugins_message_cleared":
      if (panel.message === null && panel.lastError === null) return panel;
      return { ...panel, message: null, lastError: null };
    default:
      return panel;
  }
}

/** Clamp an index into `[0, length)`, or 0 when the list is empty. */
function clamp(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, index));
}
