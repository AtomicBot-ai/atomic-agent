/**
 * Colour palettes for every registered TUI theme.
 *
 * Each palette maps the project's 16 role colours onto a well-known terminal
 * theme using one consistent semantic rule (never "nearest hex"):
 *
 *   user / tool / accent / accentSoft / info  -> theme accent  (blue, links/info)
 *   assistant / toolOk / success              -> theme green   (positive)
 *   toolError / error                         -> theme red     (danger)
 *   warn                                      -> theme yellow  (attention)
 *   warnStrong                                -> theme orange  (severe)
 *   reasoning                                 -> theme purple  (done/special)
 *   muted / system                            -> theme gray    (muted text)
 *   border                                    -> theme border / surface
 *
 * Hex values are taken from each theme's canonical/official source, cited
 * per palette. Glyphs + spinner are theme-independent and live in theme.ts.
 */

import type { TuiColors } from "./theme.js";

// GitHub Primer "dark (default)" — @primer/primitives functional tokens
// (dist/css/functional/themes/dark.css). accent=fgColor-accent,
// success=fgColor-success, attention=fgColor-attention,
// severe=fgColor-severe, danger=fgColor-danger, done=fgColor-done,
// muted=fgColor-muted, border=borderColor-default.
export const GITHUB_DARK_COLORS: TuiColors = {
  user: "#4493f8",
  assistant: "#3fb950",
  system: "#9198a1",
  reasoning: "#ab7df8",
  tool: "#4493f8",
  toolOk: "#3fb950",
  toolError: "#f85149",
  accent: "#4493f8",
  accentSoft: "#4493f8",
  border: "#3d444d",
  muted: "#9198a1",
  error: "#f85149",
  warn: "#d29922",
  warnStrong: "#db6d28",
  success: "#3fb950",
  info: "#4493f8",
};

// GitHub Primer "light (default)" — @primer/primitives functional tokens
// (dist/css/functional/themes/light.css).
export const GITHUB_LIGHT_COLORS: TuiColors = {
  user: "#0969da",
  assistant: "#1a7f37",
  system: "#59636e",
  reasoning: "#8250df",
  tool: "#0969da",
  toolOk: "#1a7f37",
  toolError: "#d1242f",
  accent: "#0969da",
  accentSoft: "#0969da",
  border: "#d1d9e0",
  muted: "#59636e",
  error: "#d1242f",
  warn: "#9a6700",
  warnStrong: "#bc4c00",
  success: "#1a7f37",
  info: "#0969da",
};

// Catppuccin Mocha — official palette (catppuccin/palette palette.json).
// accent=blue, green, yellow, peach(severe), red, mauve(done),
// subtext0(muted), surface1(border).
export const CATPPUCCIN_MOCHA_COLORS: TuiColors = {
  user: "#89b4fa",
  assistant: "#a6e3a1",
  system: "#a6adc8",
  reasoning: "#cba6f7",
  tool: "#89b4fa",
  toolOk: "#a6e3a1",
  toolError: "#f38ba8",
  accent: "#89b4fa",
  accentSoft: "#89b4fa",
  border: "#45475a",
  muted: "#a6adc8",
  error: "#f38ba8",
  warn: "#f9e2af",
  warnStrong: "#fab387",
  success: "#a6e3a1",
  info: "#89b4fa",
};

// Catppuccin Latte — official palette (light flavour).
export const CATPPUCCIN_LATTE_COLORS: TuiColors = {
  user: "#1e66f5",
  assistant: "#40a02b",
  system: "#6c6f85",
  reasoning: "#8839ef",
  tool: "#1e66f5",
  toolOk: "#40a02b",
  toolError: "#d20f39",
  accent: "#1e66f5",
  accentSoft: "#1e66f5",
  border: "#bcc0cc",
  muted: "#6c6f85",
  error: "#d20f39",
  warn: "#df8e1d",
  warnStrong: "#fe640b",
  success: "#40a02b",
  info: "#1e66f5",
};

// Dracula — official spec (draculatheme.com). accent=purple, green,
// yellow, orange(severe), red, pink(done/reasoning), comment(muted),
// currentLine(border).
export const DRACULA_COLORS: TuiColors = {
  user: "#bd93f9",
  assistant: "#50fa7b",
  system: "#6272a4",
  reasoning: "#ff79c6",
  tool: "#bd93f9",
  toolOk: "#50fa7b",
  toolError: "#ff5555",
  accent: "#bd93f9",
  accentSoft: "#bd93f9",
  border: "#44475a",
  muted: "#6272a4",
  error: "#ff5555",
  warn: "#f1fa8c",
  warnStrong: "#ffb86c",
  success: "#50fa7b",
  info: "#bd93f9",
};

// Nord — official spec (nordtheme.com). accent=nord8 frost, nord14 green,
// nord13 yellow, nord12 orange(severe), nord11 red, nord15 purple(done),
// nord3 muted, nord3 border.
export const NORD_COLORS: TuiColors = {
  user: "#88c0d0",
  assistant: "#a3be8c",
  system: "#4c566a",
  reasoning: "#b48ead",
  tool: "#88c0d0",
  toolOk: "#a3be8c",
  toolError: "#bf616a",
  accent: "#88c0d0",
  accentSoft: "#88c0d0",
  border: "#434c5e",
  muted: "#4c566a",
  error: "#bf616a",
  warn: "#ebcb8b",
  warnStrong: "#d08770",
  success: "#a3be8c",
  info: "#88c0d0",
};

// Tokyo Night ("Night" variant) — official spec
// (enkia/tokyo-night-vscode-theme). accent=blue, green, yellow,
// orange(severe), red, magenta(done), comment(muted), #414868 border.
export const TOKYO_NIGHT_COLORS: TuiColors = {
  user: "#7aa2f7",
  assistant: "#9ece6a",
  system: "#565f89",
  reasoning: "#bb9af7",
  tool: "#7aa2f7",
  toolOk: "#9ece6a",
  toolError: "#f7768e",
  accent: "#7aa2f7",
  accentSoft: "#7aa2f7",
  border: "#414868",
  muted: "#565f89",
  error: "#f7768e",
  warn: "#e0af68",
  warnStrong: "#ff9e64",
  success: "#9ece6a",
  info: "#7aa2f7",
};

// Gruvbox Dark — official "bright" palette (morhetz/gruvbox). accent=blue,
// green, yellow, orange(severe), red, purple(done), gray(muted),
// bg2(border).
export const GRUVBOX_DARK_COLORS: TuiColors = {
  user: "#83a598",
  assistant: "#b8bb26",
  system: "#928374",
  reasoning: "#d3869b",
  tool: "#83a598",
  toolOk: "#b8bb26",
  toolError: "#fb4934",
  accent: "#83a598",
  accentSoft: "#83a598",
  border: "#504945",
  muted: "#928374",
  error: "#fb4934",
  warn: "#fabd2f",
  warnStrong: "#fe8019",
  success: "#b8bb26",
  info: "#83a598",
};

// Gruvbox Light — official "faded" palette on light bg (morhetz/gruvbox).
export const GRUVBOX_LIGHT_COLORS: TuiColors = {
  user: "#076678",
  assistant: "#79740e",
  system: "#7c6f64",
  reasoning: "#8f3f71",
  tool: "#076678",
  toolOk: "#79740e",
  toolError: "#9d0006",
  accent: "#076678",
  accentSoft: "#076678",
  border: "#d5c4a1",
  muted: "#7c6f64",
  error: "#9d0006",
  warn: "#b57614",
  warnStrong: "#af3a03",
  success: "#79740e",
  info: "#076678",
};

// Solarized Dark — official spec (Ethan Schoonover). Accents are shared
// across light/dark; only base bg/fg flips. accent=blue, green, yellow,
// orange(severe), red, violet(done), base01(muted), base02(border).
export const SOLARIZED_DARK_COLORS: TuiColors = {
  user: "#268bd2",
  assistant: "#859900",
  system: "#586e75",
  reasoning: "#6c71c4",
  tool: "#268bd2",
  toolOk: "#859900",
  toolError: "#dc322f",
  accent: "#268bd2",
  accentSoft: "#268bd2",
  border: "#073642",
  muted: "#586e75",
  error: "#dc322f",
  warn: "#b58900",
  warnStrong: "#cb4b16",
  success: "#859900",
  info: "#268bd2",
};

// Solarized Light — same accent set, light base. base1(muted), base2(border).
export const SOLARIZED_LIGHT_COLORS: TuiColors = {
  user: "#268bd2",
  assistant: "#859900",
  system: "#93a1a1",
  reasoning: "#6c71c4",
  tool: "#268bd2",
  toolOk: "#859900",
  toolError: "#dc322f",
  accent: "#268bd2",
  accentSoft: "#268bd2",
  border: "#eee8d5",
  muted: "#93a1a1",
  error: "#dc322f",
  warn: "#b58900",
  warnStrong: "#cb4b16",
  success: "#859900",
  info: "#268bd2",
};
