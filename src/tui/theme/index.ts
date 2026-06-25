export {
  theme,
  setActiveTheme,
  getActiveTheme,
  getActiveThemeName,
  isThemeName,
  THEMES,
  THEME_NAMES,
} from "./theme.js";
export type { TuiColors, TuiGlyphs, TuiTheme, ThemeName } from "./theme.js";
export {
  detectTerminalBackground,
  resolveStartupTheme,
} from "./detect-terminal-background.js";
export type {
  TerminalBackgroundMode,
  DetectTerminalBackgroundDeps,
} from "./detect-terminal-background.js";
