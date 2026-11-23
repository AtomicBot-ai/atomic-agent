/**
 * Characters that make text read differently than the model receives it:
 * bidirectional overrides and isolates (the "Trojan Source" trick), zero-width
 * and other invisible characters, and Unicode tag characters (which can spell
 * a whole hidden instruction no screen shows). A recipe is text a person is
 * asked to read before sending, so any of these defeats that reading.
 *
 * The desktop link route refuses the first group outright
 * (desktop/main/deeplink.ts RECIPE_HIDDEN_RE); this list is that set plus
 * the tag block, the variation-selector supplement, the soft hyphen, U+061C,
 * U+180E and the line/paragraph separators. Ordinary emoji variation selectors
 * (U+FE00-FE0F) are left alone: they are in everyday text.
 */
const HIDDEN_RE =
  /[\u{ad}\u{61c}\u{180e}\u{200b}-\u{200f}\u{2028}-\u{202e}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{feff}\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;

export interface HiddenCharacter {
  /** 1-based line within the text. */
  line: number;
  /** 1-based column, in code points. */
  column: number;
  /** `U+202E`. */
  codePoint: string;
}

/** Every hidden character in the text, in order (at most `limit`). */
export function findHiddenCharacters(text: string, limit = 50): HiddenCharacter[] {
  const out: HiddenCharacter[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    const line = lines[i] ?? "";
    for (const m of line.matchAll(HIDDEN_RE)) {
      const ch = m[0];
      out.push({
        line: i + 1,
        column: [...line.slice(0, m.index ?? 0)].length + 1,
        codePoint: `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`,
      });
      if (out.length >= limit) break;
    }
  }
  return out;
}
