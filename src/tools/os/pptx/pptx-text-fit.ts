import { BODY_BOX } from "./pptx-parts.js";
import type { PptxBullet, PptxSlideSpec } from "./pptx-spec.js";
import { wrappedLines } from "./pptx-text-measure.js";

/**
 * How many of a slide's bullets its layout holds (ATO-2444), by the
 * room their text takes in the layout's text area: wrapped at the area's
 * width at each level's size and indent, stacked with the master's
 * paragraph spacing, against the area's height. The bullet counts stay
 * as the upper bound (the 6x6 rule of thumb), so short lines never
 * crowd a slide either.
 */

const EMU_PER_PT = 12_700;
const GAP = 304_800;
/** The master's body sizes per level, in points (pptx-shapes.ts LEVEL_SIZES). */
const LEVEL_PT = [24, 20, 18, 16, 16];
/** Space before each paragraph after the first, in points. */
const SPACE_BEFORE_PT = 10;
const HANGING = 342_900;
const PER_LEVEL = 457_200;

export interface TextArea {
  widthEmu: number;
  heightEmu: number;
  /** Most bullets (any level), whatever their length. */
  maxBullets: number;
  /** Scale on the level sizes (a caption is set smaller than the body). */
  scale?: number;
}

const HALF = (BODY_BOX.cx - GAP) / 2;

/**
 * Each layout's text area, or null for a layout that shows no bullets
 * or fits its text another way (a comparison: `comparisonBulletsThatFit`).
 * Two columns are one area as wide as a column and twice as tall: the
 * split lands near the middle, so either column holds about half.
 */
export function textAreaOf(layout: string, hasVisual: boolean): TextArea | null {
  switch (layout) {
    case "bullets":
      return hasVisual
        ? { widthEmu: HALF, heightEmu: BODY_BOX.cy, maxBullets: 5 }
        : { widthEmu: BODY_BOX.cx, heightEmu: BODY_BOX.cy, maxBullets: 6 };
    case "two-column":
      return { widthEmu: HALF, heightEmu: BODY_BOX.cy * 2, maxBullets: 12 };
    case "chart":
      return { widthEmu: (BODY_BOX.cx - GAP) / 3, heightEmu: BODY_BOX.cy, maxBullets: 3 };
    case "big-number":
      return { widthEmu: BODY_BOX.cx, heightEmu: 1_645_920, maxBullets: 1 };
    case "timeline":
      // Each step gets its own box under the line; only the count binds.
      return { widthEmu: BODY_BOX.cx, heightEmu: Number.POSITIVE_INFINITY, maxBullets: 6 };
    case "table":
      return { widthEmu: BODY_BOX.cx, heightEmu: 1_188_720, maxBullets: 2, scale: 0.75 };
    default:
      return null;
  }
}

function levelPt(level: number, scale: number): number {
  return (LEVEL_PT[level] ?? 16) * scale;
}

/** Height one paragraph takes in an area, in EMU (its spacing before included unless it is first). */
export function paragraphHeight(text: string, level: number, area: TextArea, first: boolean): number {
  const scale = area.scale ?? 1;
  const pt = levelPt(level, scale);
  const width = area.widthEmu - (level === 0 ? 0 : HANGING + level * PER_LEVEL);
  const lines = wrappedLines(text, width, pt);
  return lines * pt * 1.2 * EMU_PER_PT + (first ? 0 : SPACE_BEFORE_PT * EMU_PER_PT);
}

/**
 * How many leading bullets fit, the subtitle's lead-in counted first.
 * The first bullet stays whenever the area shows bullets at all (the
 * body's autofit shrinks one long line rather than leave it empty).
 */
export function bulletsThatFit(
  slide: Pick<PptxSlideSpec, "subtitle"> & { bullets: readonly PptxBullet[] },
  area: TextArea,
): number {
  const room = Number.isFinite(area.heightEmu) ? area.heightEmu * 0.92 : Number.POSITIVE_INFINITY;
  let used = slide.subtitle === undefined ? 0 : paragraphHeight(slide.subtitle, 0, area, true);
  let keep = 0;
  for (const bullet of slide.bullets) {
    if (keep >= area.maxBullets) break;
    const height = paragraphHeight(bullet.text, bullet.level, area, keep === 0 && slide.subtitle === undefined);
    if (keep > 0 && used + height > room) break;
    used += height;
    keep += 1;
  }
  return keep;
}


/** The two sides of a comparison: each top-level bullet is a side's heading, its sub-points the list under it. */
export function comparisonSides(bullets: readonly PptxBullet[]): [PptxBullet[], PptxBullet[]] {
  const second = bullets.findIndex((b, i) => i > 0 && b.level === 0);
  return second < 0 ? [bullets.slice(), []] : [bullets.slice(0, second), bullets.slice(second)];
}

/** The comparison's lead-in box above the columns (`comparisonSlide`). */
const COMPARISON_LEAD_EMU = 548_640;
/** A side's heading plus six points: the 6x6 rule per column. */
const COMPARISON_SIDE_MAX = 7;
/** Bold letters run wider than the regular widths `wrappedLines` assumes. */
const BOLD_WIDEN = 1.08;

/**
 * How many bullets of each comparison side fit, heading included
 * (ATO-2444 review). The sides are not one area: each is drawn in its
 * own column (`comparisonSlide`), as wide as half the body and as tall
 * as the body less the lead-in, the heading at 24 pt bold and the
 * sub-points lifted one level with explicit bullet indents. A side keeps
 * its heading and the leading points that fit; the split is fixed at
 * the second heading, so one long side cannot borrow the other's room.
 */
export function comparisonBulletsThatFit(
  slide: Pick<PptxSlideSpec, "subtitle"> & { bullets: readonly PptxBullet[] },
): [number, number] {
  const top = slide.subtitle === undefined ? 0 : COMPARISON_LEAD_EMU;
  const room = (BODY_BOX.cy - top) * 0.92;
  const fitSide = (side: readonly PptxBullet[]): number => {
    const [head, ...points] = side;
    if (head === undefined) return 0;
    let used = wrappedLines(head.text, HALF / BOLD_WIDEN, LEVEL_PT[0]!) * LEVEL_PT[0]! * 1.2 * EMU_PER_PT;
    let keep = 1;
    for (const point of points) {
      if (keep >= COMPARISON_SIDE_MAX) break;
      const level = Math.max(0, point.level - 1);
      const pt = levelPt(level, 1);
      const lines = wrappedLines(point.text, HALF - (HANGING + level * PER_LEVEL), pt);
      const height = lines * pt * 1.2 * EMU_PER_PT + SPACE_BEFORE_PT * EMU_PER_PT;
      if (used + height > room) break;
      used += height;
      keep += 1;
    }
    return keep;
  };
  const [left, right] = comparisonSides(slide.bullets);
  return [fitSide(left), fitSide(right)];
}
