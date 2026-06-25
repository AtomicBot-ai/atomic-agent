/**
 * Central colour + glyph palette for the Ink-based TUI. Avoids scattering
 * `color="cyan"` literals across components and keeps the visual language
 * consistent with openclaw's theme contract.
 *
 * Colours are Ink colour names (see https://github.com/vadimdemedes/ink#color)
 * or explicit hex values. Glyphs are single Unicode code points that render
 * consistently on macOS Terminal, iTerm2, Windows Terminal and Alacritty.
 *
 * The exported `theme` is a `Proxy` over a swappable active theme. Consumers
 * keep importing `{ theme }` and reading `theme.colors.X` at render time;
 * `setActiveTheme(...)` swaps the backing object (used at startup after
 * terminal-background autodetection, and at runtime via `/theme <name>`).
 * Because every consumer reads through the proxy on each render, swapping is
 * invisible to them — a re-render picks up the new colours.
 *
 * Palette definitions live in {@link ./theme-palettes.ts}; this module owns
 * the shared glyphs/spinner, the theme registry, and the proxy machinery.
 */

import {
  CATPPUCCIN_LATTE_COLORS,
  CATPPUCCIN_MOCHA_COLORS,
  DRACULA_COLORS,
  GITHUB_DARK_COLORS,
  GITHUB_LIGHT_COLORS,
  GRUVBOX_DARK_COLORS,
  GRUVBOX_LIGHT_COLORS,
  NORD_COLORS,
  SOLARIZED_DARK_COLORS,
  SOLARIZED_LIGHT_COLORS,
  TOKYO_NIGHT_COLORS,
} from "./theme-palettes.js";

export interface TuiColors {
  readonly user: string;
  readonly assistant: string;
  readonly system: string;
  readonly reasoning: string;
  readonly tool: string;
  readonly toolOk: string;
  readonly toolError: string;
  readonly accent: string;
  readonly accentSoft: string;
  readonly border: string;
  readonly muted: string;
  readonly error: string;
  readonly warn: string;
  /** Stronger warn accent (orange) for high-visibility badges. */
  readonly warnStrong: string;
  readonly success: string;
  readonly info: string;
}

export interface TuiGlyphs {
  readonly userMarker: string;
  readonly assistantMarker: string;
  readonly systemMarker: string;
  readonly reasoningMarker: string;
  readonly toolBoxTopLeft: string;
  readonly toolBoxTopRight: string;
  readonly toolBoxBottomLeft: string;
  readonly toolBoxBottomRight: string;
  readonly toolBoxHorizontal: string;
  readonly toolBoxVertical: string;
  readonly bullet: string;
  readonly arrowRight: string;
  readonly arrowLeft: string;
  readonly check: string;
  readonly cross: string;
  readonly warn: string;
  readonly info: string;
  readonly ellipsis: string;
  readonly promptCaret: string;
  readonly chevronRight: string;
  readonly dotSeparator: string;
  readonly pipeSeparator: string;
}

export interface TuiTheme {
  readonly colors: TuiColors;
  readonly glyphs: TuiGlyphs;
  readonly spinnerFrames: readonly string[];
  readonly spinnerFrameMs: number;
}

/** Canonical theme identifier used by the registry and resolver. */
export type ThemeName =
  | "github-dark"
  | "github-light"
  | "catppuccin-mocha"
  | "catppuccin-latte"
  | "dracula"
  | "nord"
  | "tokyo-night"
  | "gruvbox-dark"
  | "gruvbox-light"
  | "solarized-dark"
  | "solarized-light";

// Glyphs and spinner are theme-independent — shared across every palette.
const GLYPHS: TuiGlyphs = {
  userMarker: "›",
  assistantMarker: "●",
  systemMarker: "·",
  reasoningMarker: "◈",
  toolBoxTopLeft: "┌",
  toolBoxTopRight: "┐",
  toolBoxBottomLeft: "└",
  toolBoxBottomRight: "┘",
  toolBoxHorizontal: "─",
  toolBoxVertical: "│",
  bullet: "•",
  arrowRight: "→",
  arrowLeft: "←",
  check: "✓",
  cross: "✗",
  warn: "⚠",
  info: "ℹ",
  ellipsis: "…",
  promptCaret: "❯",
  chevronRight: "▸",
  dotSeparator: "·",
  pipeSeparator: "|",
};

const SPINNER_FRAMES: readonly string[] = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];

function makeTheme(colors: TuiColors): TuiTheme {
  return {
    colors,
    glyphs: GLYPHS,
    spinnerFrames: SPINNER_FRAMES,
    spinnerFrameMs: 120,
  };
}

/** Registry of every named theme, keyed by {@link ThemeName}. */
export const THEMES: Readonly<Record<ThemeName, TuiTheme>> = {
  "github-dark": makeTheme(GITHUB_DARK_COLORS),
  "github-light": makeTheme(GITHUB_LIGHT_COLORS),
  "catppuccin-mocha": makeTheme(CATPPUCCIN_MOCHA_COLORS),
  "catppuccin-latte": makeTheme(CATPPUCCIN_LATTE_COLORS),
  dracula: makeTheme(DRACULA_COLORS),
  nord: makeTheme(NORD_COLORS),
  "tokyo-night": makeTheme(TOKYO_NIGHT_COLORS),
  "gruvbox-dark": makeTheme(GRUVBOX_DARK_COLORS),
  "gruvbox-light": makeTheme(GRUVBOX_LIGHT_COLORS),
  "solarized-dark": makeTheme(SOLARIZED_DARK_COLORS),
  "solarized-light": makeTheme(SOLARIZED_LIGHT_COLORS),
};

/** Ordered list of theme names, for palettes / help / validation. */
export const THEME_NAMES: readonly ThemeName[] = [
  "github-dark",
  "github-light",
  "catppuccin-mocha",
  "catppuccin-latte",
  "dracula",
  "nord",
  "tokyo-night",
  "gruvbox-dark",
  "gruvbox-light",
  "solarized-dark",
  "solarized-light",
];

/** Type guard: is `name` a registered {@link ThemeName}? */
export function isThemeName(name: string): name is ThemeName {
  return Object.prototype.hasOwnProperty.call(THEMES, name);
}

// Module-level active theme, swapped by `setActiveTheme`. Defaults to the
// GitHub dark baseline so the proxy is usable from import time (before
// autodetection / an explicit `/theme` switch).
let activeTheme: TuiTheme = THEMES["github-dark"];

/**
 * Swap the active theme behind the {@link theme} proxy. Call this at startup
 * (after terminal-background autodetection) or at runtime (`/theme <name>`).
 * Consumers read through the proxy on every render, so the swap is picked up
 * by the next re-render without any per-component changes.
 */
export function setActiveTheme(next: TuiTheme): void {
  activeTheme = next;
}

/** Return the currently active theme object (for non-render-path callers). */
export function getActiveTheme(): TuiTheme {
  return activeTheme;
}

/** Reverse-lookup the active theme's name; falls back to `github-dark`. */
export function getActiveThemeName(): ThemeName {
  for (const name of THEME_NAMES) {
    if (THEMES[name] === activeTheme) return name;
  }
  return "github-dark";
}

/**
 * The themed palette consumed across the TUI. A `Proxy` that always forwards
 * to the current {@link activeTheme}, so `theme.colors.X` reflects the active
 * theme at read time even after a `setActiveTheme` swap.
 */
export const theme: TuiTheme = new Proxy({} as TuiTheme, {
  get(_target, prop: string | symbol): unknown {
    return activeTheme[prop as keyof TuiTheme];
  },
  has(_target, prop: string | symbol): boolean {
    return prop in activeTheme;
  },
  ownKeys(): ArrayLike<string | symbol> {
    return Reflect.ownKeys(activeTheme);
  },
  getOwnPropertyDescriptor(_target, prop: string | symbol) {
    return Reflect.getOwnPropertyDescriptor(activeTheme, prop);
  },
});
