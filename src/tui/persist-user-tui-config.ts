import {
  ensureUserConfigFileSync,
  getConfig,
  parseUserConfigFile,
  resetConfigCache,
  writeUserConfigFileSync,
  type WhileBusySubmitMode,
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

/**
 * Persist what Enter does while a turn is running (`steer` / `queue`)
 * into `tui.whileBusySubmit`. Same read → merge → validate → write →
 * reset shape as {@link persistUserTuiTheme}; the live `TuiState` flip
 * is the caller's job, this only makes it survive a restart.
 */
export function persistUserWhileBusySubmit(mode: WhileBusySubmitMode): void {
  const path = getConfig().paths.userConfigFile;
  const prev = ensureUserConfigFileSync(path);
  const draft = { ...prev, tui: { ...prev.tui, whileBusySubmit: mode } };
  const validated = parseUserConfigFile(draft);
  writeUserConfigFileSync(path, validated);
  resetConfigCache();
}
