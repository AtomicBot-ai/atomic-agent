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
  CLASSIC_DARK_COLORS,
  CLASSIC_LIGHT_COLORS,
  DARKY_DARK_COLORS,
  KHORNE_RED_COLORS,
  MOON_YELLOW_COLORS,
  TOXIC_GREEN_COLORS,
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
  /**
   * The accent hue as a *ground* — the tone a chip, badge or panel is
   * painted in, with `accent` ink read on top of it. A palette is free
   * to make it much darker than `accent` (the house one does: `#294793`
   * against `#7195e8`), so it is never a text colour. Text reads
   * `accent`; borders and other chrome may keep this tone, since they
   * are looked at rather than read.
   */
  readonly accentSoft: string;
  /**
   * The palette's violet, one hue away from `accent`. Reserved for a
   * state that is neither "normal" nor "wrong" and must not be read as
   * either — today, a context window whose transcript has been trimmed.
   * A warn/error colour would say something broke; the accent would say
   * nothing at all.
   */
  readonly accentAlt: string;
  /**
   * The brand mark's own blue — deliberately lighter and whiter than
   * `accent`. The mark is not a control, and painting it in the same
   * blue as every accented control made the start page read as one big
   * highlighted widget.
   */
  readonly brandMark: string;
  /**
   * The face of the brand mark — its front plane, as opposed to the
   * extruded walls and cast shadow, which stay in `brandMark`. Painting
   * the two apart is what makes the mark read as a solid object rather
   * than a flat stencil; the glyph density ramp (`#`/`+`/`.`) carries the
   * same information when there is no colour to spend.
   *
   * Per-palette rather than a literal white, for the same reason
   * `railBackground` is: `#fff` disappears on the four light palettes.
   * What has to hold is that the face reads *brighter than the depth
   * against the page*, not that it is any exact colour.
   */
  readonly brandFace: string;
  /**
   * Ground of the app's own chrome: the sidebar, the operator menu, the
   * composer's meta bar and every popup. It is the one piece of chrome
   * always on screen, and giving it a ground of its own is what makes
   * the layout read as a sidebar beside a document rather than two
   * columns of the same text.
   *
   * **One step off the page, not an inversion.** The rail used to flip
   * polarity — a near-white ground on a dark theme — and that is what
   * made the whole `rail*` ink set necessary: components kept dropping
   * page ink onto it, and page ink is *light* on a dark theme. Measured
   * on the palettes that shipped it, `assistant` on the rail came to
   * 1.09:1 and `warn` to 1.12:1. Light on light. A rail that stays on
   * the page's own side of the line cannot produce that pair even when
   * a component reaches for the wrong token.
   */
  readonly railBackground: string;
  readonly railForeground: string;
  /** Secondary text on the rail — same role as `muted`, on the rail ground. */
  readonly railMuted: string;
  /**
   * The palette's four semantic hues, re-picked for the rail ground.
   *
   * These exist because the rail is a different ground and contrast is
   * a property of a *pair*, not of a colour: `accent` is chosen to be
   * read on the page and nothing about that choice says it survives on
   * the rail. Anything drawn on the rail — the sidebar's active row,
   * the meta bar's health dot, a popup's warning line — reaches for
   * these; anything drawn on the page keeps `accent` / `success` /
   * `warn` / `error`. `theme-contrast.test.ts` checks both sets against
   * the ground each is actually painted on.
   */
  readonly railAccent: string;
  readonly railSuccess: string;
  readonly railWarn: string;
  readonly railError: string;
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
  /** Filled marker on the operator menu's selected row. */
  readonly menuCursor: string;
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
  | "classic-dark"
  | "classic-light"
  | "toxic-green"
  | "khorne-red"
  | "darky-dark"
  | "moon-yellow";

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
  menuCursor: "▶",
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
  "classic-dark": makeTheme(CLASSIC_DARK_COLORS),
  "classic-light": makeTheme(CLASSIC_LIGHT_COLORS),
  "toxic-green": makeTheme(TOXIC_GREEN_COLORS),
  "khorne-red": makeTheme(KHORNE_RED_COLORS),
  "darky-dark": makeTheme(DARKY_DARK_COLORS),
  "moon-yellow": makeTheme(MOON_YELLOW_COLORS),
};

/** Ordered list of theme names, for palettes / help / validation. */
export const THEME_NAMES: readonly ThemeName[] = [
  "classic-dark",
  "classic-light",
  "toxic-green",
  "khorne-red",
  "darky-dark",
  "moon-yellow",
];

/** Type guard: is `name` a registered {@link ThemeName}? */
export function isThemeName(name: string): name is ThemeName {
  return Object.prototype.hasOwnProperty.call(THEMES, name);
}

/**
 * Names the registry used to carry, mapped to the surviving palette
 * closest to each.
 *
 * The registry went from twelve palettes to six, and eleven of the
 * twelve were transcriptions of upstream terminal themes rather than
 * designs of our own — which is how the contrast failures this release
 * fixes got in (see `theme-palettes.ts`). Dropping a name that is
 * sitting in somebody's `tui.theme` would silently move them to the
 * autodetect default, so each retired name resolves to the survivor
 * nearest it instead: the dark transcriptions to `classic-dark`, the
 * light ones to `classic-light`, and gruvbox's warm dark to
 * `moon-yellow`, which is the one palette that kept its cast.
 *
 * `atomic-retro` is not a substitution at all — it is the same palette
 * under its new name, and it is still the default.
 */
const RETIRED_THEME_ALIASES: Readonly<Record<string, ThemeName>> = {
  "atomic-retro": "classic-dark",
  "github-dark": "classic-dark",
  "github-light": "classic-light",
  "catppuccin-mocha": "classic-dark",
  "catppuccin-latte": "classic-light",
  dracula: "classic-dark",
  nord: "classic-dark",
  "tokyo-night": "classic-dark",
  "gruvbox-dark": "moon-yellow",
  "gruvbox-light": "classic-light",
  "solarized-dark": "classic-dark",
  "solarized-light": "classic-light",
};

/**
 * Resolve a configured theme name to a registered one, following
 * {@link RETIRED_THEME_ALIASES}. Returns `null` for `"auto"` and for
 * anything that was never a theme name, which is the caller's signal to
 * fall back to terminal-background autodetection.
 */
export function resolveThemeName(name: string): ThemeName | null {
  if (isThemeName(name)) return name;
  return RETIRED_THEME_ALIASES[name] ?? null;
}

/** True when `name` is a retired name that {@link resolveThemeName} rehomes. */
export function isRetiredThemeName(name: string): boolean {
  return !isThemeName(name) && name in RETIRED_THEME_ALIASES;
}

// Module-level active theme, swapped by `setActiveTheme`. Defaults to the
// house palette so the proxy is usable from import time (before
// autodetection / an explicit `/theme` switch).
let activeTheme: TuiTheme = THEMES["classic-dark"];

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

/** Reverse-lookup the active theme's name; falls back to `classic-dark`. */
export function getActiveThemeName(): ThemeName {
  for (const name of THEME_NAMES) {
    if (THEMES[name] === activeTheme) return name;
  }
  return "classic-dark";
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

/**
 * Roles that paint a ground rather than ink on one. Dimming these to
 * `muted` alongside the text they sit under collapses the two into one
 * flat slab — the rail stops being a rail and becomes a grey block. The
 * backdrop should read as *faded*, not as *erased*: keep the grounds,
 * fade what is written on them.
 */
const GROUND_ROLES = new Set<keyof TuiColors>([
  "railBackground",
  "badgeBackground",
  "chipBackground",
]);

function dimColors(colors: TuiColors): TuiColors {
  if (dimmedColorsFor === colors && dimmedColorsCache) return dimmedColorsCache;
  const flat = Object.fromEntries(
    Object.keys(colors).map((key) => [
      key,
      GROUND_ROLES.has(key as keyof TuiColors)
        ? colors[key as keyof TuiColors]
        : colors.muted,
    ]),
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
