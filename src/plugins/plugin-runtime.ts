import { statSync } from "node:fs";
import { join } from "node:path";
import { readPluginBundle } from "./plugin-bundle.js";
import { installedPluginDir, isPartDisabled, listEnabledPlugins, pluginsRoot, type InstalledPluginRecord } from "./plugin-store.js";
import type { PluginBundle } from "./plugin-types.js";

export interface LoadedPlugin {
  record: InstalledPluginRecord;
  bundle: PluginBundle;
}

export interface LoadedPlugins {
  plugins: LoadedPlugin[];
  diagnostics: string[];
}

/**
 * A skill folder a plugin contributes. The loader names it
 * `plugin:<frontmatter name>`, or just `plugin` when the plugin root is
 * itself the skill (`rootSkill`).
 */
export interface PluginSkillDir {
  plugin: string;
  dir: string;
  rootSkill: boolean;
}

let cache: { key: string; value: LoadedPlugins } | null = null;

/**
 * Parse every enabled installed plugin. Called on each workspace refresh, so
 * the result is cached on the state file's mtime; a plugin that fails to
 * parse becomes a diagnostic, never an exception.
 */
export function loadEnabledPlugins(stateDir: string): LoadedPlugins {
  const key = cacheKey(stateDir);
  if (cache && cache.key === key) return cache.value;
  const diagnostics: string[] = [];
  const plugins: LoadedPlugin[] = [];
  for (const record of listEnabledPlugins(stateDir)) {
    try {
      plugins.push({ record, bundle: readPluginBundle(installedPluginDir(stateDir, record.name)) });
    } catch (err) {
      diagnostics.push(`plugin ${record.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const value = { plugins, diagnostics };
  cache = { key, value };
  return value;
}

/** Drop the cache (tests, and right after install/remove in the same process). */
export function resetPluginCache(): void {
  cache = null;
}

export function listEnabledPluginSkills(stateDir: string): PluginSkillDir[] {
  const out: PluginSkillDir[] = [];
  for (const { record, bundle } of loadEnabledPlugins(stateDir).plugins) {
    for (const skill of bundle.skills) {
      if (isPartDisabled(record, `skill:${skill.name || bundle.name}`)) continue;
      out.push({ plugin: bundle.name, dir: skill.dir, rootSkill: skill.name === "" });
    }
  }
  return out;
}

function cacheKey(stateDir: string): string {
  try {
    const st = statSync(join(pluginsRoot(stateDir), "plugins.json"));
    return `${stateDir}\0${st.mtimeMs}\0${st.size}`;
  } catch {
    return `${stateDir}\0none`;
  }
}
