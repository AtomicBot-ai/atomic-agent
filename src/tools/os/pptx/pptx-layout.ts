import type { PptxBullet, PptxSlideSpec } from "./pptx-spec.js";
import { bulletsThatFit, textAreaOf } from "./pptx-text-fit.js";

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
  "section",
  "comparison",
  "timeline",
  "table",
] as const;
export type PptxLayout = (typeof PPTX_LAYOUTS)[number];

/** More top-level text than one column holds: auto layout splits it in two. */
export const TWO_COLUMN_FROM = 7;
/** A chart with more bullets than this keeps the half/half bullets layout. */
const CHART_FOCUS_MAX_BULLETS = 3;
const BIG_NUMBER_MAX_CHARS = 12;
/** A table with at most this many bullets leads its slide (`table`); more keep the half/half bullets layout. */
const TABLE_LED_MAX_BULLETS = 2;
/** A timeline reads at a glance with three to six steps. */
const TIMELINE_STEPS = { min: 3, max: 6 };
/** "2024: …", "Q3 - …", "Jan 2026: …", "Step 2: …", "Phase 1: …", "Week 3: …", "v1.0: …" (any dash or a colon). */
const MONTH = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";
const STEP_LIKE = new RegExp(
  `^(?:\\d{4}|[QH][1-4](?:\\s?\\d{2,4})?|${MONTH}(?:\\s\\d{1,4})?|(?:Step|Phase|Stage|Week|Day|Month|Sprint|Milestone)\\s\\d{1,3}|v\\d+(?:\\.\\d+)*)\\s*[:\\-\u2013\u2014]\\s*\\S`,
  "i",
);

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

/** Every bullet a top-level step that starts with a date, quarter or step number. */
export function isTimelineLike(bullets: readonly PptxBullet[]): boolean {
  return (
    bullets.length >= TIMELINE_STEPS.min &&
    bullets.length <= TIMELINE_STEPS.max &&
    bullets.every((b) => b.level === 0 && STEP_LIKE.test(b.text))
  );
}

/** Exactly two top-level bullets (the sides), each with sub-points under it. */
export function isComparisonLike(bullets: readonly PptxBullet[]): boolean {
  const heads = bullets.flatMap((b, i) => (b.level === 0 ? [i] : []));
  if (heads.length !== 2 || heads[0] !== 0) return false;
  const second = heads[1]!;
  return second > 1 && second < bullets.length - 1;
}

export function hasVisual(slide: PptxSlideSpec): boolean {
  return slide.image !== undefined || slide.table !== undefined || slide.chart !== undefined;
}

/**
 * The layout a slide gets from its content alone. `index` is its place
 * in the deck: a slide of only a title after the first is a section
 * header, the first is the deck's title slide.
 */
export function pickLayout(slide: PptxSlideSpec, index = 0): PptxLayout {
  const count = slide.bullets.length;
  if (slide.chart !== undefined) return count <= CHART_FOCUS_MAX_BULLETS ? "chart" : "bullets";
  if (slide.image !== undefined) return count === 0 ? "image-full" : "bullets";
  if (slide.table !== undefined) return count <= TABLE_LED_MAX_BULLETS ? "table" : "bullets";
  if (count <= 1 && isNumberLike(slide.title)) return "big-number";
  if (count === 0) return isQuoteLike(slide.title) ? "quote" : index > 0 ? "section" : "title";
  if (isTimelineLike(slide.bullets)) return "timeline";
  if (isComparisonLike(slide.bullets)) return "comparison";
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
    case "table":
      return slide.table !== undefined;
    case "comparison":
      return !hasVisual(slide) && isComparisonLike(slide.bullets);
    case "timeline":
      return !hasVisual(slide) && slide.bullets.length > 0 && slide.bullets.every((b) => b.level === 0);
    default:
      return !hasVisual(slide);
  }
}

/** The model's layout when it fits the content, otherwise the automatic one. */
export function resolveLayout(slide: PptxSlideSpec, index = 0): PptxLayout {
  const asked = slide.layout;
  return asked !== undefined && layoutFits(asked, slide) ? asked : pickLayout(slide, index);
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
 * the slide. What it holds is measured (`pptx-text-fit.ts`, ATO-2444):
 * the text's wrapped lines in the layout's text area, not a character
 * count. The first bullet stays whenever the layout shows bullets at
 * all (the body's autofit shrinks one long line rather than leave the
 * slide empty).
 */
export function fitSlideText(slide: PptxSlideSpec, layout: PptxLayout): FittedSlide {
  const area = textAreaOf(layout, hasVisual(slide));
  const keep = area === null ? 0 : bulletsThatFit(slide, area);
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
export function layoutSlide(slide: PptxSlideSpec, index = 0): LaidOutSlide {
  const layout = resolveLayout(slide, index);
  const fitted = fitSlideText(slide, layout);
  // A comparison whose right side lost its points to the notes is no
  // longer two sides: it falls back to plain bullets, so what is drawn
  // and what is reported (`layouts`, the slide's progress) agree.
  if (!layoutFits(layout, fitted.slide)) {
    const plain = fitSlideText(slide, "bullets");
    return { layout: "bullets", moved: plain.moved, slide: { ...plain.slide, layout: "bullets" } };
  }
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
