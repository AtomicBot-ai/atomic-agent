/**
 * Colour palettes for every registered TUI theme.
 *
 * Six palettes, all designed here rather than transcribed from upstream
 * terminal themes. That is the change this file records: the registry
 * used to carry twelve, eleven of them mapped onto somebody else's
 * sixteen ANSI slots, and a mapping cannot know which of its colours
 * this app is about to paint *on which ground*. It painted a lot of them
 * on the wrong one — see `theme-contrast.test.ts`, which walks every
 * (ink, ground) pair the UI actually draws and now fails the build when
 * one of them is unreadable.
 *
 * ## Three grounds, not one
 *
 * A terminal app has no page of its own: the terminal owns the
 * background and the app draws on it. But this app also paints two
 * grounds of its own, and every colour token belongs to exactly one of
 * the three:
 *
 *   1. **the page** — the terminal's background, given per palette as
 *      {@link CANONICAL_PAGE}. Every `*text*` role is read here:
 *      `user`, `assistant`, `accent`, `error`, `muted`, and so on.
 *   2. **the rail** — the sidebar, the operator menu, the composer's
 *      meta bar, every popup. Its ground is `railBackground` and the
 *      only colours legible on it are the `rail*` ones.
 *   3. **a chip or badge** — a raised control or an accent-tinted pill.
 *      `chipBackground`/`chipForeground` and `badgeBackground`.
 *
 * Mixing them is the bug class this file was rewritten to make
 * impossible. The old palettes drew the rail *inverted* — a near-white
 * ground on a dark theme — and then components dropped page ink onto it:
 * `github-dark` painted `assistant` (`#e6edf3`) on a `#f0f6fc` rail, a
 * contrast ratio of **1.09:1**. White on white. `tokyo-night` did the
 * same at 1.13:1 and `catppuccin-mocha` put `warn` on its rail at
 * 1.12:1.
 *
 * ## The rail is a surface, not an inversion
 *
 * So the rail no longer flips polarity. It is a *different tone of the
 * same family* — one step off the page, dark on a dark theme and light
 * on a light one — and it carries its own ink set (`railForeground`,
 * `railMuted`, `railAccent`, `railSuccess`, `railWarn`, `railError`).
 * Anything drawn on the rail reaches for those. The invariant a palette
 * must satisfy is no longer "the rail is inverted" (which the house
 * palette never was, since its sidebar is a solid indigo panel) but
 * "the rail is distinguishable from the page, and its own ink is
 * readable on it". Both are checked.
 *
 * ## The gate
 *
 * Text pairs must clear 4.5:1 (WCAG AA for body text). Chrome that is
 * looked at rather than read — `border`, `accentSoft` — only has to be
 * *distinguishable* from its ground, so it is held to 1.5:1 and no
 * more: a hairline rule that met AA would be a wall.
 */

import type { TuiColors } from "./theme.js";

/**
 * The terminal background each palette is designed against.
 *
 * The app never paints this — the terminal owns it — so it is not a
 * `TuiColors` token. It still has to be written down somewhere, because
 * "is this ink readable" is a question about a specific ground, and the
 * contrast gate has to be able to ask it. A palette that ships without
 * a row here does not compile.
 *
 * An operator whose terminal is set to some other background gets a
 * result this table cannot predict; that is what `--theme` and the
 * OSC 11 autodetect in `detect-terminal-background.ts` are for.
 */
export const CANONICAL_PAGE: Record<string, string> = {
  "classic-dark": "#0b0e14",
  "classic-light": "#ffffff",
  "toxic-green": "#06120a",
  "khorne-red": "#12070a",
  "darky-dark": "#000000",
  "moon-yellow": "#0d0f18",
};

// ---------------------------------------------------------------------------
// classic dark — the house palette, and the one the app boots into.
//
// Unchanged in its page inks: these are the design's own oklch tokens
// converted to sRGB, and they were the one palette in the old registry
// that had actually been checked against the ground it is read on.
// What is new is the rail ink set. The sidebar is a solid indigo panel
// (`#294793`) — the design's own choice, and the reason the house
// palette was the only one whose rail was never inverted — and page ink
// on it measured 2.48:1 (`muted`), 2.67:1 (`error`) and 2.97:1
// (`accent`). Those three now have rail-side counterparts.
// ---------------------------------------------------------------------------
export const CLASSIC_DARK_COLORS: TuiColors = {
  // `primary` (oklch 42% .13 265 = #294793) is a *fill* in the design:
  // the rail and the composer sit on it. As TEXT on a dark terminal it
  // lands around 2:1 against the ground, so anything drawn in the accent
  // uses the same hue lifted to oklch 68% instead. Same colour, readable.
  user: "#7195e8",
  assistant: "#5edb81",
  system: "#858992",
  reasoning: "#bb9af4",
  tool: "#e6e8eb",
  toolOk: "#5edb81",
  toolError: "#eb6264",
  accent: "#7195e8",
  accentAlt: "#bb9af4",
  // The un-lifted fill. Anything that paints a ground (chips, the RUN
  // badge, the composer) reaches for this, not for `accent`; anything
  // that paints *text* on a ground reaches for `accent`, not for this.
  // Borders and other chrome may sit at either — looked at, not read.
  accentSoft: "#294793",
  border: "#3c4048",
  muted: "#858992",
  error: "#eb6264",
  warn: "#e6d35c",
  warnStrong: "#f98f3a",
  success: "#5edb81",
  info: "#7195e8",
  brandMark: "#c4d8ff",
  brandFace: "#ffffff",
  // The design's sidebar is a solid indigo panel — the one place the
  // fill colour is used as a fill, exactly as drawn.
  railBackground: "#294793",
  railForeground: "#eef1f6",
  railMuted: "#b9c8ea",
  railAccent: "#cfe0ff",
  railSuccess: "#a5e8b8",
  railWarn: "#f2dd93",
  railError: "#ffb3b4",
  badgeBackground: "#181d2b",
  chipBackground: "#f1f3f8",
  chipForeground: "#13161d",
};

// ---------------------------------------------------------------------------
// classic light — the same layout on a white page.
//
// Not a recoloured dark theme: every ink is re-picked against `#ffffff`,
// because the tones that read on a near-black page are exactly the ones
// that vanish on a white one. The rail goes one step *darker* than the
// page rather than inverting to black, for the same reason the dark
// palettes' rails go one step lighter — a full inversion is a slab, not
// a surface.
// ---------------------------------------------------------------------------
export const CLASSIC_LIGHT_COLORS: TuiColors = {
  user: "#1f4bb8",
  assistant: "#136c33",
  system: "#5a6069",
  reasoning: "#6b30bd",
  tool: "#24282e",
  toolOk: "#136c33",
  toolError: "#c1121f",
  accent: "#1f4bb8",
  accentAlt: "#6b30bd",
  accentSoft: "#bccdf0",
  border: "#c9ced6",
  muted: "#5a6069",
  error: "#c1121f",
  warn: "#7a5300",
  warnStrong: "#a03d00",
  success: "#136c33",
  info: "#1f4bb8",
  brandMark: "#2c3b96",
  brandFace: "#0b0e14",
  railBackground: "#e7ebf1",
  railForeground: "#171a1f",
  railMuted: "#4e545d",
  railAccent: "#1b429f",
  railSuccess: "#0f5c2b",
  railWarn: "#6b4900",
  railError: "#a90f1b",
  badgeBackground: "#dde4f4",
  chipBackground: "#0f1216",
  chipForeground: "#f4f6f9",
};

// ---------------------------------------------------------------------------
// toxic green — acid on a near-black green page.
//
// The accent is the loudest thing in the registry on purpose; the rest
// of the palette is deliberately quiet so it stays loud. Its hazard
// hues (`warn`, `error`) are pulled away from green rather than toward
// it, because a warning that shares a hue with the accent stops being a
// warning.
// ---------------------------------------------------------------------------
export const TOXIC_GREEN_COLORS: TuiColors = {
  user: "#5ef58a",
  assistant: "#9df871",
  system: "#7f9a86",
  reasoning: "#8ee9c9",
  tool: "#d8f0dd",
  toolOk: "#9df871",
  toolError: "#ff6b6b",
  accent: "#5ef58a",
  accentAlt: "#8ee9c9",
  accentSoft: "#134528",
  border: "#254a34",
  muted: "#7f9a86",
  error: "#ff6b6b",
  warn: "#f7e05c",
  warnStrong: "#ff9d42",
  success: "#9df871",
  info: "#5ef58a",
  brandMark: "#b6ffcb",
  brandFace: "#f2fff6",
  railBackground: "#10331d",
  railForeground: "#e4f7e9",
  railMuted: "#9dc0aa",
  railAccent: "#79ff9e",
  railSuccess: "#b3ff8c",
  railWarn: "#ffe873",
  railError: "#ff9a9a",
  badgeBackground: "#0d2416",
  chipBackground: "#f4fdf6",
  chipForeground: "#06120a",
};

// ---------------------------------------------------------------------------
// khorne red — blood and brass.
//
// Red is the accent, which puts it in tension with `error`: the one
// colour that must never be mistaken for "normal" would share a hue
// with the colour that means exactly that. Resolved by splitting them
// on brightness and saturation rather than hue — the accent is a bright
// blood red, `error` is a hot near-orange scarlet — and by giving the
// palette a brass second accent (`accentAlt`, `warn`) that carries most
// of the non-danger emphasis instead.
// ---------------------------------------------------------------------------
export const KHORNE_RED_COLORS: TuiColors = {
  user: "#f2555f",
  assistant: "#d9a441",
  system: "#a08a8d",
  reasoning: "#d98f6a",
  tool: "#f0dfe0",
  toolOk: "#d9a441",
  toolError: "#ff7a5c",
  accent: "#f2555f",
  accentAlt: "#d98f6a",
  accentSoft: "#621822",
  border: "#5a2531",
  muted: "#a08a8d",
  error: "#ff7a5c",
  warn: "#e8c15a",
  warnStrong: "#ff9138",
  success: "#d9a441",
  info: "#f2555f",
  brandMark: "#ff9aa1",
  brandFace: "#fff0f1",
  railBackground: "#3a0f16",
  railForeground: "#f7e6e7",
  railMuted: "#c9a4a8",
  railAccent: "#ff8f96",
  railSuccess: "#eec065",
  railWarn: "#f5d67c",
  railError: "#ff9f85",
  badgeBackground: "#2a0b11",
  chipBackground: "#fdf3f4",
  chipForeground: "#12070a",
};

// ---------------------------------------------------------------------------
// darky dark — pure black page, minimum chroma.
//
// For OLED panels and for people who find every other theme too loud.
// The constraint is that "quiet" must not become "unreadable": on a
// `#000000` page there is nowhere darker for a muted tone to go, so the
// greys here are lifted well above where a dark-grey page would put
// them, and the palette spends its very small colour budget on the four
// roles that carry meaning (accent, success, warn, error) rather than
// tinting the body text.
// ---------------------------------------------------------------------------
export const DARKY_DARK_COLORS: TuiColors = {
  user: "#9fb4d4",
  assistant: "#b9c9b4",
  system: "#8d9199",
  reasoning: "#b3a8c9",
  tool: "#d6d8dc",
  toolOk: "#b9c9b4",
  toolError: "#d98a8a",
  accent: "#9fb4d4",
  accentAlt: "#b3a8c9",
  accentSoft: "#262e40",
  border: "#33363c",
  muted: "#8d9199",
  error: "#d98a8a",
  warn: "#cfc08a",
  warnStrong: "#d9a06e",
  success: "#b9c9b4",
  info: "#9fb4d4",
  brandMark: "#c2cfe4",
  brandFace: "#f2f4f7",
  railBackground: "#16181c",
  railForeground: "#e2e4e8",
  railMuted: "#989ca3",
  railAccent: "#a8bcdb",
  railSuccess: "#c0d0bb",
  railWarn: "#d5c692",
  railError: "#e09292",
  badgeBackground: "#1f2126",
  chipBackground: "#e2e4e8",
  chipForeground: "#000000",
};

// ---------------------------------------------------------------------------
// moon yellow — moonlight on a blue-black page.
//
// The accent is a pale, desaturated yellow rather than a bright one:
// saturated yellow on a dark ground is the highest-contrast pair a
// terminal can produce and it glares at this size. The page carries a
// blue cast so the yellow reads as *lit* rather than as a warning
// colour — which is also why `warn` here is pushed to amber and
// `warnStrong` to orange, away from the accent.
// ---------------------------------------------------------------------------
export const MOON_YELLOW_COLORS: TuiColors = {
  user: "#e8d79a",
  assistant: "#a9d6a4",
  system: "#8e93a8",
  reasoning: "#bfa9e0",
  tool: "#dfe2ee",
  toolOk: "#a9d6a4",
  toolError: "#e78b8b",
  accent: "#e8d79a",
  accentAlt: "#bfa9e0",
  accentSoft: "#3d3622",
  border: "#3a3f52",
  muted: "#8e93a8",
  error: "#e78b8b",
  warn: "#e6b962",
  warnStrong: "#ef9247",
  success: "#a9d6a4",
  info: "#e8d79a",
  brandMark: "#f3e7b8",
  brandFace: "#fffbe9",
  railBackground: "#232840",
  railForeground: "#eceef7",
  railMuted: "#a7adc4",
  railAccent: "#f0e0a8",
  railSuccess: "#b5dfb0",
  railWarn: "#eec678",
  railError: "#f09b9b",
  badgeBackground: "#1a1e30",
  chipBackground: "#f8f9fd",
  chipForeground: "#0d0f18",
};
