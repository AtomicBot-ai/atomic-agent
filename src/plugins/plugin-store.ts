import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Installed plugins live under `<stateDir>/plugins/`, which the desktop and
 * the terminal share (one `~/.atomic-agent`):
 *
 *   plugins/plugins.json        install record + enabled flag per plugin
 *   plugins/installed/<name>/   the copied plugin files
 *   plugins/data/<name>/        writable data folder (${CLAUDE_PLUGIN_DATA})
 *
 * The record lives here, not in config.json, so plugin state never fights
 * with config schema migrations.
 */

export type PluginSourceRecord =
  | { kind: "local"; path: string }
  | { kind: "marketplace"; marketplace: string; entry: string; url?: string; ref?: string; sha?: string }
  | { kind: "git"; url: string; ref?: string; sha?: string };

export interface InstalledPluginRecord {
  name: string;
  version: string;
  enabled: boolean;
  source: PluginSourceRecord;
  installedAt: string;
  updatedAt: string;
  /** Set when the user agreed that this plugin may run code (hooks, stdio MCP, scripts). */
  runsCodeAccepted?: boolean;
  /** Names of the plugin's parts the user switched off (`skill:x`, `mcp:y`, `hook:z`, `command:w`). */
  disabledParts?: string[];
}

export interface PluginStateFile {
  version: 1;
  plugins: Record<string, InstalledPluginRecord>;
}

export function pluginsRoot(stateDir: string): string {
  return join(stateDir, "plugins");
}

export function installedPluginDir(stateDir: string, name: string): string {
  return join(pluginsRoot(stateDir), "installed", name);
}

export function pluginDataDir(stateDir: string, name: string): string {
  return join(pluginsRoot(stateDir), "data", name);
}

function stateFile(stateDir: string): string {
  return join(pluginsRoot(stateDir), "plugins.json");
}

/** Missing or unreadable state reads as "no plugins": a broken file must never stop the agent. */
export function readPluginState(stateDir: string): PluginStateFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(stateFile(stateDir), "utf8"));
  } catch {
    return { version: 1, plugins: {} };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { version: 1, plugins: {} };
  const plugins = (raw as { plugins?: unknown }).plugins;
  const out: PluginStateFile = { version: 1, plugins: {} };
  if (plugins && typeof plugins === "object" && !Array.isArray(plugins)) {
    for (const [name, rec] of Object.entries(plugins as Record<string, unknown>)) {
      if (rec && typeof rec === "object" && typeof (rec as InstalledPluginRecord).name === "string") {
        const r = rec as InstalledPluginRecord;
        out.plugins[name] = { ...r, enabled: r.enabled !== false };
      }
    }
  }
  return out;
}

/** Atomic write (tmp + rename), owner-only, so a crash never leaves half a file. */
export function writePluginState(stateDir: string, state: PluginStateFile): void {
  mkdirSync(pluginsRoot(stateDir), { recursive: true });
  const file = stateFile(stateDir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

export function updatePluginRecord(
  stateDir: string,
  name: string,
  mutate: (rec: InstalledPluginRecord) => InstalledPluginRecord | null,
): InstalledPluginRecord | null {
  const state = readPluginState(stateDir);
  const current = state.plugins[name];
  if (!current) return null;
  const next = mutate({ ...current });
  if (next === null) delete state.plugins[name];
  else state.plugins[name] = { ...next, updatedAt: new Date().toISOString() };
  writePluginState(stateDir, state);
  return next;
}

export function listEnabledPlugins(stateDir: string): InstalledPluginRecord[] {
  return Object.values(readPluginState(stateDir).plugins)
    .filter(p => p.enabled)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function isPartDisabled(rec: InstalledPluginRecord, part: string): boolean {
  return rec.disabledParts?.includes(part) ?? false;
}
