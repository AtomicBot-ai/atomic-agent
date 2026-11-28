/**
 * How much room a line of slide text takes, measured instead of counted
 * (ATO-2444). A fixed character budget treated "iiii" and "WWWW" alike
 * and ignored the box: a column beside a chart got the same budget as
 * the full width. Here each character has an advance width (thousandths
 * of an em, close to Calibri and the usual sans fallbacks: Arial,
 * Helvetica, Liberation Sans), words wrap greedily at the box's width,
 * and a box holds as many lines as its height allows at the font size.
 *
 * An estimate, on purpose: the deck is opened in PowerPoint, Keynote,
 * LibreOffice or Google Slides, each with its own fonts, so the fit
 * keeps a margin and the body's autofit absorbs the rest.
 */

const EMU_PER_PT = 12_700;
/** Room kept free, so a font a little wider than the table still fits. */
const SAFETY = 0.92;

const NARROW = new Set([..."il.,:;'|!`ı"]);
const SLIM = new Set([..."fjrtI()[]{}/\\-\""]);
const WIDE_LOWER = new Set([..."mw"]);
const WIDE_UPPER = new Set([..."MW@%"]);

/** Advance width of one character, in thousandths of an em. */
export function charWidth(ch: string): number {
  if (ch === " ") return 226;
  if (NARROW.has(ch)) return 230;
  if (SLIM.has(ch)) return 330;
  if (WIDE_LOWER.has(ch)) return 800;
  if (WIDE_UPPER.has(ch)) return 860;
  if (/[0-9]/.test(ch)) return 507;
  if (/[A-Z]/.test(ch)) return 600;
  // CJK, kana, Hangul and full-width forms take a whole em.
  if (/[ᄀ-ᇿ⺀-꓏가-힯豈-﫿︰-﹏＀-￯]/u.test(ch)) return 1000;
  if (/\p{Lu}/u.test(ch)) return 620;
  return 480;
}

/** Width of a run of text at `fontPt`, in EMU. */
export function textWidthEmu(text: string, fontPt: number): number {
  let units = 0;
  for (const ch of text) units += charWidth(ch);
  return (units / 1000) * fontPt * EMU_PER_PT;
}

/** Lines a paragraph wraps to in a box `widthEmu` wide; a word longer than the line breaks mid-word. */
export function wrappedLines(text: string, widthEmu: number, fontPt: number): number {
  const room = widthEmu * SAFETY;
  if (room <= 0) return Number.POSITIVE_INFINITY;
  let lines = 0;
  for (const paragraph of text.split(/\r?\n/)) {
    lines += 1;
    let used = 0;
    const space = textWidthEmu(" ", fontPt);
    for (const word of paragraph.split(/\s+/).filter((w) => w.length > 0)) {
      const w = textWidthEmu(word, fontPt);
      const need = used === 0 ? w : used + space + w;
      if (need <= room) {
        used = need;
        continue;
      }
      if (used > 0) lines += 1;
      // A word wider than the line takes as many lines as it needs.
      const extra = Math.max(0, Math.ceil(w / room) - 1);
      lines += extra;
      used = w - extra * room;
    }
  }
  return lines;
}

