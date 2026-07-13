import {
  ensureUserConfigFileSync,
  getConfig,
  parseUserConfigFile,
  resetConfigCache,
  writeUserConfigFileSync,
} from "../config/index.js";

/**
 * Persist the anonymous-analytics opt-out (`analytics.enabled`) into the
 * user config file, then invalidate the global config cache so the next
 * `getConfig()` sees it. Mirrors the other `persist-*` helpers: read →
 * merge → validate → write → reset.
 *
 * The caller is responsible for hot-applying the change to the live
 * runtime via `runtime.setAnalyticsEnabled`; this only durably records
 * the choice.
 */
export function persistAnalyticsEnabled(enabled: boolean): void {
  const path = getConfig().paths.userConfigFile;
  const prev = ensureUserConfigFileSync(path);
  const draft = { ...prev, analytics: { ...prev.analytics, enabled } };
  const validated = parseUserConfigFile(draft);
  writeUserConfigFileSync(path, validated);
  resetConfigCache();
}
