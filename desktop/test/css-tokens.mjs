// ATO-2763: read the colour tokens of desktop/renderer/styles.css the way the
// browser resolves them, for the contrast gate (token-contrast.test.mjs).
//
// Three themes are read from the token part of styles.css (above the
// end-of-tokens marker):
//   light        :root alone (also :root[data-theme="light"] under a dark OS)
//   dark-os      :root + @media (prefers-color-scheme: dark) :root:not([data-theme="light"])
//   dark-forced  :root + :root[data-theme="dark"]
// Every token is declared on :root, so a later block simply re-points names;
// var() is then resolved in that merged map, like the cascade on :root does.
//
// Colours understood: #rgb #rgba #rrggbb #rrggbbaa, rgb()/rgba() (comma or
// space syntax, alpha as a number or %), transparent, white, black and
// color-mix(in srgb, A p%, B q%) with premultiplied alpha, which is how the
// washes (--hover, --brand-wash...) are built. Anything else throws, so a new
// colour syntax in the tokens fails the gate loudly instead of passing.
import { readFileSync } from "node:fs";

const MARKER = "/* === end tokens === */";
const BLOCKS = {
  root: ":root {",
  darkOs: '@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {',
  darkForced: ':root[data-theme="dark"] {',
};

export function readTokenCss(url = new URL("../renderer/styles.css", import.meta.url)) {
  const css = readFileSync(url, "utf8");
  const end = css.indexOf(MARKER);
  if (end < 0) throw new Error("styles.css lost its end-of-tokens marker");
  return css.slice(0, end).replace(/\/\*[\s\S]*?\*\//g, "");
}

function blockBody(css, opener) {
  const at = css.indexOf(opener);
  if (at < 0) throw new Error("styles.css token block not found: " + opener);
  const start = at + opener.length;
  const close = css.indexOf("}", start);
  return css.slice(start, close);
}

function declarations(body) {
  const out = {};
  for (const part of body.split(";")) {
    const m = part.match(/^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export function themes(css = readTokenCss()) {
  const root = declarations(blockBody(css, BLOCKS.root));
  return {
    light: { ...root },
    "dark-os": { ...root, ...declarations(blockBody(css, BLOCKS.darkOs)) },
    "dark-forced": { ...root, ...declarations(blockBody(css, BLOCKS.darkForced)) },
  };
}

export function resolve(map, value, seen = []) {
  return value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (_, name, fallback) => {
    if (seen.includes(name)) throw new Error("var() cycle: " + [...seen, name].join(" -> "));
    if (map[name] === undefined) {
      if (fallback !== undefined) return resolve(map, fallback.trim(), seen);
      throw new Error("undefined token " + name);
    }
    return resolve(map, map[name], [...seen, name]);
  });
}

const NAMED = { transparent: [0, 0, 0, 0], white: [255, 255, 255, 1], black: [0, 0, 0, 1] };

// Split on commas that are not inside parentheses.
function topLevelArgs(s) {
  const out = []; let depth = 0; let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const alphaOf = (s) => (s.endsWith("%") ? parseFloat(s) / 100 : parseFloat(s));

export function parseColor(input) {
  const s = input.trim().toLowerCase();
  if (NAMED[s]) return [...NAMED[s]];
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m && [3, 4, 6, 8].includes(m[1].length)) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    const n = [0, 2, 4, 6].map((i) => (i < h.length ? parseInt(h.slice(i, i + 2), 16) : 255));
    return [n[0], n[1], n[2], n[3] / 255];
  }
  m = s.match(/^rgba?\((.*)\)$/);
  if (m) {
    const parts = m[1].includes(",") ? m[1].split(",") : m[1].replace("/", " ").split(/\s+/);
    const [r, g, b, a] = parts.map((p) => p.trim()).filter(Boolean);
    const ch = (v) => (v.endsWith("%") ? parseFloat(v) * 2.55 : parseFloat(v));
    return [ch(r), ch(g), ch(b), a === undefined ? 1 : alphaOf(a)];
  }
  m = s.match(/^color-mix\(\s*in\s+srgb\s*,(.*)\)$/);
  if (m) {
    const [a, b] = topLevelArgs(m[1]).map((arg) => {
      const pm = arg.match(/^(.*?)\s+(\d+(?:\.\d+)?)%$/);
      return pm ? { c: parseColor(pm[1]), p: Number(pm[2]) / 100 } : { c: parseColor(arg), p: undefined };
    });
    const pa = a.p ?? (b.p === undefined ? 0.5 : 1 - b.p);
    const pb = b.p ?? 1 - pa;
    const alpha = a.c[3] * pa + b.c[3] * pb;
    if (alpha === 0) return [0, 0, 0, 0];
    const mix = (i) => (a.c[i] * a.c[3] * pa + b.c[i] * b.c[3] * pb) / alpha;
    return [mix(0), mix(1), mix(2), alpha];
  }
  throw new Error("unsupported colour: " + input);
}

export const colorOf = (map, token) => parseColor(resolve(map, "var(" + token + ")"));

// Source-over: top (with its alpha) painted on an opaque bottom.
export function over(top, bottom) {
  const a = top[3];
  return [0, 1, 2].map((i) => top[i] * a + bottom[i] * (1 - a)).concat(1);
}

function luminance(c) {
  const [r, g, b] = c.slice(0, 3).map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// The ratio a pair actually renders at: a translucent background is first
// painted over its ground, then the text (alpha too) over that.
export function pairRatio(map, { fg, bg, ground }) {
  let back = colorOf(map, bg);
  if (back[3] < 1) {
    if (!ground) throw new Error(bg + " is translucent: the pair needs a ground");
    const g = colorOf(map, ground);
    if (g[3] < 1) throw new Error("ground " + ground + " must be opaque");
    back = over(back, g);
  }
  return contrast(over(colorOf(map, fg), back), back);
}
