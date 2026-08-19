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

/**
 * Persist the mouse-support toggle into `tui.mouse`. Same read → merge →
 * validate → write → reset cycle as the theme; the caller owns turning
 * the terminal's reporting mode on or off for the running session.
 */
export function persistUserTuiMouse(mouse: boolean): void {
  const path = getConfig().paths.userConfigFile;
  const prev = ensureUserConfigFileSync(path);
  const draft = { ...prev, tui: { ...prev.tui, mouse } };
  const validated = parseUserConfigFile(draft);
  writeUserConfigFileSync(path, validated);
  resetConfigCache();
}
