import { mkdirSync } from "node:fs";
import { expandVars } from "./plugin-mcp.js";
import { loadEnabledPlugins, type LoadedPlugins } from "./plugin-runtime.js";
import { isPartDisabled, pluginDataDir } from "./plugin-store.js";

/**
 * The monitors of enabled plugins that may start now (ATO-2438). A monitor
 * runs a command on this computer, so it needs the same consent as hooks
 * and local MCP servers (`runsCodeAccepted`, reset on every update); a
 * monitor the user switched off (`monitor:<name>`) is left out without a
 * note. `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` (and the neutral
 * `${PLUGIN_ROOT}` / `${PLUGIN_DATA}`) are filled into the command, as
 * Claude Code does; nothing else is exported to the process.
 */

export interface StartablePluginMonitor {
  plugin: string;
  name: string;
  /** `<plugin>/<name>`, unique across plugins. */
  key: string;
  description: string;
  /** The command line with the plugin path variables filled in. */
  command: string;
  until?: string;
}

export interface PluginMonitorList {
  monitors: StartablePluginMonitor[];
  skipped: Array<{ plugin: string; name: string; reason: string }>;
}

export function listPluginMonitors(stateDir: string, loaded: LoadedPlugins = loadEnabledPlugins(stateDir)): PluginMonitorList {
  const monitors: StartablePluginMonitor[] = [];
  const skipped: PluginMonitorList["skipped"] = [];
  for (const { record, bundle } of loaded.plugins) {
    for (const monitor of bundle.monitors) {
      if (isPartDisabled(record, `monitor:${monitor.name}`)) continue;
      if (record.runsCodeAccepted !== true) {
        skipped.push({ plugin: bundle.name, name: monitor.name, reason: `runs a command; allow code for this plugin first (atomic-agent plugin allow-code ${bundle.name})` });
        continue;
      }
      const dataDir = pluginDataDir(stateDir, bundle.name);
      const command = expandVars(monitor.command, { root: bundle.root, data: dataDir }) as string;
      if (monitor.command.includes("PLUGIN_DATA")) mkdirSync(dataDir, { recursive: true });
      monitors.push({
        plugin: bundle.name,
        name: monitor.name,
        key: `${bundle.name}/${monitor.name}`,
        description: monitor.description,
        command,
        ...(monitor.until !== undefined ? { until: monitor.until } : {}),
      });
    }
  }
  return { monitors, skipped };
}
