import { listConfigLeaves } from "./config-paths.js";
import { ENV_SETTINGS } from "./env-settings.js";
import { SETTINGS_DOCS } from "./settings-docs.generated.js";
import { buildSettingsReference, type SettingEntry } from "./settings-reference.js";

/**
 * The live settings reference: every `config.json` key with its type,
 * default, description and env override. Built once per process; the
 * inputs are compile-time constants.
 */
let cached: readonly SettingEntry[] | null = null;

export function listSettingsReference(): readonly SettingEntry[] {
  cached ??= buildSettingsReference(listConfigLeaves(), SETTINGS_DOCS, ENV_SETTINGS);
  return cached;
}
