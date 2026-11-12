import { ensureUserConfigFileSync, getConfig } from "../config/index.js";
import { formatConfigValue, isSecretConfigKey, readConfigPath } from "../config/config-paths.js";
import { ENV_SETTINGS } from "../config/env-settings.js";
import { listSettingsReference } from "../config/settings-reference-data.js";
import {
  filterSettings,
  renderEnvSettingsText,
  renderSettingsText,
} from "../config/settings-reference.js";

/**
 * `atomic-agent config list --describe|--json [words…]` and
 * `atomic-agent config env` (ATO-41): the settings reference with the
 * values in this install's config.json. Kept apart from
 * `config-command.ts`, which owns get/set/unset.
 */

export const DESCRIBE_FLAG = "--describe";
export const JSON_FLAG = "--json";

/** True when `config list` was given a flag this module answers. */
export function wantsSettingsReference(args: readonly string[]): boolean {
  return args.includes(DESCRIBE_FLAG) || args.includes(JSON_FLAG);
}

/** A value as `config list --json` prints it: secrets masked, never the raw string. */
export function maskedValue(key: string, value: unknown): unknown {
  if (isSecretConfigKey(key) && typeof value === "string" && value.length > 0) return "***";
  return value;
}

export function handleListReference(args: readonly string[]): number {
  const query = args.filter((arg) => arg !== DESCRIBE_FLAG && arg !== JSON_FLAG).join(" ");
  const file = ensureUserConfigFileSync(getConfig().paths.userConfigFile);
  const entries = filterSettings(listSettingsReference(), query);
  if (args.includes(JSON_FLAG)) {
    const rows = entries.map((entry) => ({
      ...entry,
      value: maskedValue(entry.key, readConfigPath(file, entry.key)),
    }));
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  if (entries.length === 0) {
    process.stdout.write(`no setting matches "${query}"\n`);
    return 0;
  }
  const values = new Map(
    entries.map((entry) => [entry.key, formatConfigValue(entry.key, readConfigPath(file, entry.key))]),
  );
  process.stdout.write(`${renderSettingsText(entries, values)}\n`);
  return 0;
}

/**
 * `config env`: the variables that are not in config.json, or that win
 * over a config.json key, with whether each is set in this process.
 * Values are not printed; one of them is an API key.
 */
export function handleEnv(): number {
  const set = ENV_SETTINGS.filter((setting) => (process.env[setting.name] ?? "") !== "").map((s) => s.name);
  process.stdout.write(`${renderEnvSettingsText(ENV_SETTINGS)}\n`);
  process.stdout.write(set.length > 0 ? `\nset in this environment: ${set.join(", ")}\n` : "\nnone of these is set in this environment\n");
  return 0;
}
