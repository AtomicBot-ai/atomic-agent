import { getConfig, readUserConfigFileSync } from "../../config/index.js";
import { readConfigPath } from "../../config/config-paths.js";
import { formatSettingValue } from "../../config/settings-value-mask.js";
import { listSettingsReference } from "../../config/settings-reference-data.js";
import {
  filterSettings,
  renderSettingsText,
  type SettingEntry,
} from "../../config/settings-reference.js";

/**
 * `/settings` (ATO-41): find a setting without reading the source. Pure
 * text, like `/tools`. With no words it lists the blocks; with words it
 * shows the matching keys with type, default, description and, where the
 * config file sets something else, the current value. Changing a value
 * stays with `atomic-agent config set` and the panels that own it.
 */

/** Most rows one search prints; past this the user is asked to narrow it. */
export const SETTINGS_SEARCH_LIMIT = 25;

function blockOf(key: string): string {
  const dot = key.indexOf(".");
  return dot === -1 ? key : key.slice(0, dot);
}

export function renderSettingsOverview(entries: readonly SettingEntry[] = listSettingsReference()): string {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(blockOf(entry.key), (counts.get(blockOf(entry.key)) ?? 0) + 1);
  const blocks = [...counts.entries()].map(([block, count]) => `${block} (${count})`).join(", ");
  return [
    `${entries.length} settings in config.json: ${blocks}.`,
    "Search: `/settings <words>`, e.g. `/settings memory recall` or `/settings timeout`.",
    "Change one: `atomic-agent config set <key> <value>` (`config unset <key>` restores the default).",
    "Everything with descriptions: `atomic-agent config list --describe`; env-only settings: `atomic-agent config env`.",
  ].join("\n");
}

/** Current file values of `entries`, rendered as `config list` renders them; empty when unreadable. */
function currentValues(entries: readonly SettingEntry[]): Map<string, string> {
  try {
    const file = readUserConfigFileSync(getConfig().paths.userConfigFile);
    if (!file) return new Map();
    return new Map(entries.map((entry) => [entry.key, formatSettingValue(entry.key, readConfigPath(file, entry.key))]));
  } catch {
    // A broken file is reported elsewhere (startup, `atag doctor`); the list still helps.
    return new Map();
  }
}

export function renderSettingsSearch(
  query: string,
  entries: readonly SettingEntry[] = listSettingsReference(),
  values?: ReadonlyMap<string, string>,
): string {
  const matches = filterSettings(entries, query);
  if (matches.length === 0) {
    return `no setting matches "${query}". \`/settings\` lists the blocks.`;
  }
  const shown = matches.slice(0, SETTINGS_SEARCH_LIMIT);
  const body = renderSettingsText(shown, values ?? currentValues(shown));
  const more = matches.length > shown.length
    ? `\n… ${matches.length - shown.length} more; add a word to narrow it, or run \`atomic-agent config list --describe ${query}\`.`
    : "";
  return `${body}${more}`;
}
