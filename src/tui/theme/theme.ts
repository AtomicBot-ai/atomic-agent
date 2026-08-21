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
  ATOMIC_RETRO_COLORS,
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
  /**
   * The brand mark's own blue — deliberately lighter and whiter than
   * `accent`. The mark is not a control, and painting it in the same
   * blue as every accented control made the start page read as one big
   * highlighted widget.
   */
  readonly brandMark: string;
  /**
   * The left rail is drawn inverted — a light ground under dark text on
   * a dark theme, and the reverse on a light one. It is the app's one
   * piece of chrome that is always on screen, and giving it its own
   * ground is what makes the layout read as a sidebar next to a document
   * rather than two columns of the same text.
   *
   * Per-palette rather than a literal white: `#fff` would disappear on
   * the four light palettes, and "inverted" is the property that has to
   * hold, not the exact colour.
   */
  readonly railBackground: string;
  readonly railForeground: string;
  /** Secondary text on the rail — same role as `muted`, on the rail ground. */
  readonly railMuted: string;
  /**
   * Ground for an accent-tinted badge — one step off the terminal's own
   * background, always read with `accent` text on top. A terminal has no
   * alpha, so what the design expresses as "accent at 15% over the page"
   * is baked per palette instead.
   */
  readonly badgeBackground: string;
  /**
   * Face and label of a raised control (`+ new`, `≡ Menu`, `send →`).
   * Its own pair rather than the rail's, because a palette may paint the
   * rail in a colour — this design does — and a button then has to stay
   * legible against that panel rather than merge into it.
   */
  readonly chipBackground: string;
  readonly chipForeground: string;
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
  /** Hamburger, for the rail's menu button. */
  readonly menuGlyph: string;
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
  | "atomic-retro"
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
  menuGlyph: "☰",
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
  "atomic-retro": makeTheme(ATOMIC_RETRO_COLORS),
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
  "atomic-retro",
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
// house palette so the proxy is usable from import time (before
// autodetection / an explicit `/theme` switch).
let activeTheme: TuiTheme = THEMES["atomic-retro"];

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
  return "atomic-retro";
}

/**
 * Backdrop dimming. While the operator menu is open the whole app behind it
 * fades, so the popup reads as the foreground rather than as one more panel
 * competing with the chat log.
 *
 * Implemented here rather than by threading a `dimmed` prop through every
 * component because {@link theme} is already a read-at-render proxy — the
 * same machinery that makes `/theme` live-preview repaint the whole UI. One
 * flag flips every colour; the menu itself reads {@link chromeTheme}, which
 * ignores the flag, so it stays at full contrast.
 *
 * Every colour collapses to the active theme's `muted`: a real terminal has
 * no alpha channel, so "faded" has to mean "one low-contrast tone" rather
 * than "the same colours, weaker".
 */
let backdropDimmed = false;
let dimmedColorsFor: TuiColors | null = null;
let dimmedColorsCache: TuiColors | null = null;

export function setBackdropDimmed(next: boolean): void {
  backdropDimmed = next;
}

export function isBackdropDimmed(): boolean {
  return backdropDimmed;
}

function dimColors(colors: TuiColors): TuiColors {
  if (dimmedColorsFor === colors && dimmedColorsCache) return dimmedColorsCache;
  const flat = Object.fromEntries(
    Object.keys(colors).map((key) => [key, colors.muted]),
  ) as unknown as TuiColors;
  dimmedColorsFor = colors;
  dimmedColorsCache = flat;
  return flat;
}

/**
 * The themed palette consumed across the TUI. A `Proxy` that always forwards
 * to the current {@link activeTheme}, so `theme.colors.X` reflects the active
 * theme at read time even after a `setActiveTheme` swap.
 */
export const theme: TuiTheme = new Proxy({} as TuiTheme, {
  get(_target, prop: string | symbol): unknown {
    if (prop === "colors" && backdropDimmed) return dimColors(activeTheme.colors);
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

/**
 * The palette for chrome that must stay legible while the backdrop is dimmed —
 * i.e. the operator menu. Identical to {@link theme} except that it ignores
 * {@link setBackdropDimmed}.
 */
export const chromeTheme: TuiTheme = new Proxy({} as TuiTheme, {
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
