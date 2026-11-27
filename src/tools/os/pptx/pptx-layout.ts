import type { PptxBullet, PptxSlideSpec } from "./pptx-spec.js";

/**
 * Slide layouts for `os.fs.write_pptx` and the two pure decisions around
 * them: which layout a slide gets when the model does not name one
 * (`pickLayout`, the Gamma / Beautiful.ai "auto layout" idea), and how
 * much text a layout holds before the rest moves to the speaker notes
 * (`fitSlideText`), so a slide never overflows its box.
 */

export const PPTX_LAYOUTS = [
  "title",
  "bullets",
  "two-column",
  "quote",
  "big-number",
  "image-full",
  "chart",
] as const;
export type PptxLayout = (typeof PPTX_LAYOUTS)[number];

export interface TextCap {
  /** Most bullets (any level) the layout shows. */
  bullets: number;
  /** Most characters of bullet text, all bullets together. */
  chars: number;
}

/**
 * What each layout holds. `bullets` is narrower when a picture, table or
 * chart takes the right half. The numbers follow the usual 6x6 slide
 * rule of thumb at the master's 24 pt body size.
 */
export const LAYOUT_TEXT_CAPS: Record<PptxLayout, TextCap> = {
  title: { bullets: 0, chars: 0 },
  bullets: { bullets: 6, chars: 600 },
  "two-column": { bullets: 12, chars: 1_000 },
  quote: { bullets: 0, chars: 0 },
  "big-number": { bullets: 1, chars: 120 },
  "image-full": { bullets: 0, chars: 0 },
  chart: { bullets: 3, chars: 240 },
};
export const BULLETS_BESIDE_VISUAL_CAP: TextCap = { bullets: 5, chars: 300 };

/** More top-level text than one column holds: auto layout splits it in two. */
export const TWO_COLUMN_FROM = 7;
/** A chart with more bullets than this keeps the half/half bullets layout. */
const CHART_FOCUS_MAX_BULLETS = 3;
const BIG_NUMBER_MAX_CHARS = 12;

/** "42%", "$1.2M", "3x", "10,000", "+18 pts", "~2.5bn": a headline that is one figure. */
const NUMBER_LIKE =
  /^[~≈<>+\-−]?\s?[$€£¥₽]?\s?\d[\d.,\s]*\s?(%|x|×|k|K|m|M|bn|B|pts?|\+)?$/;
const QUOTE_OPEN = /^["“„«'‘]/;
const QUOTE_CLOSE = /["”“»'’]$/;

export function isNumberLike(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= BIG_NUMBER_MAX_CHARS && NUMBER_LIKE.test(t);
}

export function isQuoteLike(text: string): boolean {
  const t = text.trim();
  return t.length >= 8 && QUOTE_OPEN.test(t) && QUOTE_CLOSE.test(t);
}

function hasVisual(slide: PptxSlideSpec): boolean {
  return slide.image !== undefined || slide.table !== undefined || slide.chart !== undefined;
}

/** The layout a slide gets from its content alone. */
export function pickLayout(slide: PptxSlideSpec): PptxLayout {
  const count = slide.bullets.length;
  if (slide.chart !== undefined) return count <= CHART_FOCUS_MAX_BULLETS ? "chart" : "bullets";
  if (slide.image !== undefined) return count === 0 ? "image-full" : "bullets";
  if (slide.table !== undefined) return "bullets";
  if (count <= 1 && isNumberLike(slide.title)) return "big-number";
  if (count === 0) return isQuoteLike(slide.title) ? "quote" : "title";
  const topLevel = slide.bullets.filter((b) => b.level === 0).length;
  if (count >= TWO_COLUMN_FROM && topLevel >= 2) return "two-column";
  return "bullets";
}

/** Whether a named layout can show the slide's picture, table or chart (or the lack of one). */
export function layoutFits(layout: PptxLayout, slide: PptxSlideSpec): boolean {
  switch (layout) {
    case "bullets":
      return true;
    case "image-full":
      return slide.image !== undefined;
    case "chart":
      return slide.chart !== undefined;
    default:
      return !hasVisual(slide);
  }
}

/** The model's layout when it fits the content, otherwise the automatic one. */
export function resolveLayout(slide: PptxSlideSpec): PptxLayout {
  const asked = slide.layout;
  return asked !== undefined && layoutFits(asked, slide) ? asked : pickLayout(slide);
}

export function textCap(layout: PptxLayout, slide: PptxSlideSpec): TextCap {
  return layout === "bullets" && hasVisual(slide) ? BULLETS_BESIDE_VISUAL_CAP : LAYOUT_TEXT_CAPS[layout];
}

/** Bullets as notes lines, two spaces per level, the way the model wrote them. */
function bulletLines(bullets: readonly PptxBullet[]): string {
  return bullets.map((b) => `${"  ".repeat(b.level)}- ${b.text}`).join("\n");
}

export const MOVED_NOTES_HEADING = "More on this slide:";

export interface FittedSlide {
  slide: PptxSlideSpec;
  /** How many bullets left the slide for the notes. */
  moved: number;
}

/**
 * Keep the bullets the layout holds, in order, and move the rest to the
 * end of the speaker notes, so nothing is lost and nothing spills off
 * the slide. The first bullet stays whenever the layout shows bullets at
 * all (the body's autofit shrinks one long line rather than leave the
 * slide empty).
 */
export function fitSlideText(slide: PptxSlideSpec, layout: PptxLayout): FittedSlide {
  const cap = textCap(layout, slide);
  let keep = 0;
  let chars = 0;
  for (const bullet of slide.bullets) {
    if (keep >= cap.bullets) break;
    if (keep > 0 && chars + bullet.text.length > cap.chars) break;
    chars += bullet.text.length;
    keep += 1;
  }
  const overflow = slide.bullets.slice(keep);
  if (overflow.length === 0) return { slide, moved: 0 };
  const extra = `${MOVED_NOTES_HEADING}\n${bulletLines(overflow)}`;
  const notes = slide.notes === undefined ? extra : `${slide.notes}\n\n${extra}`;
  return { slide: { ...slide, bullets: slide.bullets.slice(0, keep), notes }, moved: overflow.length };
}

export interface LaidOutSlide extends FittedSlide {
  layout: PptxLayout;
}

/** Layout chosen, text fitted, and the slide stamped with the layout it renders with. */
export function layoutSlide(slide: PptxSlideSpec): LaidOutSlide {
  const layout = resolveLayout(slide);
  const fitted = fitSlideText(slide, layout);
  return { layout, moved: fitted.moved, slide: { ...fitted.slide, layout } };
}

/**
 * Two columns of bullets: the split lands on a top-level bullet at or
 * after the middle, so a sub-point stays with its parent.
 */
export function splitColumns(bullets: readonly PptxBullet[]): [PptxBullet[], PptxBullet[]] {
  const middle = Math.ceil(bullets.length / 2);
  let at = bullets.findIndex((b, i) => i >= middle && b.level === 0);
  if (at <= 0) at = middle;
  return [bullets.slice(0, at), bullets.slice(at)];
}
