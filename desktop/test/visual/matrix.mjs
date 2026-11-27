/**
 * matrix.mjs: which windows, scales and themes the visual suite shoots.
 *
 * Pure: no I/O, no app. The defaults are the set agreed for the UI quality
 * wave (27.11.2026): three window sizes at 1x, plus the middle window at
 * 1.5x, in both themes. Every part can be narrowed from the environment so
 * a PR can re-shoot one screen at one size without editing code:
 *
 *   VISUAL_VARIANTS="1470x923@1,1470x923@1.5"   window sizes and scales
 *   VISUAL_THEMES="light"                       themes
 *   VISUAL_SCREENS="chat-empty,settings-general" screen ids (see screens.mjs)
 */

export const DEFAULT_VARIANTS = '1100x700@1,1470x923@1,1470x923@1.5,1920x1080@1';
export const DEFAULT_THEMES = 'light,dark';
export const THEMES = ['light', 'dark'];

/** "1470x923@1.5" -> {width:1470, height:923, scale:1.5}. Throws on nonsense. */
export function parseVariant(spec) {
  const m = /^\s*(\d{3,5})x(\d{3,5})(?:@(\d+(?:\.\d+)?)x?)?\s*$/i.exec(String(spec));
  if (!m) throw new Error(`visual: cannot read the window size "${spec}" (expected like 1470x923@1.5)`);
  const width = Number(m[1]);
  const height = Number(m[2]);
  const scale = m[3] === undefined ? 1 : Number(m[3]);
  if (!(scale > 0 && scale <= 4)) throw new Error(`visual: scale ${m[3]} in "${spec}" is out of range (0 to 4)`);
  return { width, height, scale };
}

/** A comma list, trimmed, empties dropped, duplicates removed in order. */
export function splitList(s) {
  const out = [];
  for (const part of String(s ?? '').split(',')) {
    const v = part.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** Stable label of a variant, safe in a file name on every OS: 1470x923-1.5x. */
export function variantLabel(v) {
  return `${v.width}x${v.height}-${v.scale}x`;
}

/** The file name of one shot, without extension. */
export function shotName(screenId, theme, variant) {
  return `${screenId}--${theme}--${variantLabel(variant)}`;
}

/**
 * The whole run as a flat list, grouped the way the runner walks it:
 * variant (one viewport change), then theme (one theme switch), then screen.
 *
 * @param {object} o
 * @param {Array<{id:string}>} o.screens   the known screens (screens.mjs)
 * @param {object} [o.env]                 defaults to process.env
 * @returns {{variants:object[], themes:string[], screens:object[], shots:object[], unknownScreens:string[]}}
 */
export function buildMatrix({ screens, env = process.env }) {
  const variants = splitList(env.VISUAL_VARIANTS || DEFAULT_VARIANTS).map(parseVariant);
  const seen = new Set();
  const uniqVariants = variants.filter((v) => {
    const k = variantLabel(v);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const themes = splitList(env.VISUAL_THEMES || DEFAULT_THEMES);
  for (const t of themes) {
    if (!THEMES.includes(t)) throw new Error(`visual: unknown theme "${t}" (expected ${THEMES.join(' or ')})`);
  }

  const wanted = splitList(env.VISUAL_SCREENS || '');
  const known = new Set(screens.map((s) => s.id));
  const unknownScreens = wanted.filter((id) => !known.has(id));
  const picked = wanted.length ? screens.filter((s) => wanted.includes(s.id)) : screens.slice();

  const shots = [];
  for (const variant of uniqVariants) {
    for (const theme of themes) {
      for (const screen of picked) {
        shots.push({ name: shotName(screen.id, theme, variant), screen: screen.id, theme, variant });
      }
    }
  }
  return { variants: uniqVariants, themes, screens: picked, shots, unknownScreens };
}
