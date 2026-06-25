import {
  ensureUserConfigFileSync,
  getConfig,
  parseUserConfigFile,
  resetConfigCache,
  writeUserConfigFileSync,
} from "../config/index.js";

/**
 * Persist the selected TUI theme (`"auto"` or a registered theme name) into
 * the user config file's `tui.theme` key, then invalidate the global config
 * cache so the next `getConfig()` sees it. Mirrors the other `persist-*`
 * helpers: read → merge → validate → write → reset.
 *
 * The caller is responsible for actually swapping the live palette via
 * `setActiveTheme`; this only durably records the choice.
 */
export function persistUserTuiTheme(theme: string): void {
  const path = getConfig().paths.userConfigFile;
  const prev = ensureUserConfigFileSync(path);
  const draft = { ...prev, tui: { ...prev.tui, theme } };
  const validated = parseUserConfigFile(draft);
  writeUserConfigFileSync(path, validated);
  resetConfigCache();
}
