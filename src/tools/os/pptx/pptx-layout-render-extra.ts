import { BODY_BOX, TITLE_BOX } from "./pptx-parts.js";
import {
  AUTOFIT,
  BODY_PH,
  GAP,
  TITLE_PH,
  bodyParagraphs,
  colour,
  colouredRun,
  explicitBullets,
  headerShapes,
  placeholderShape,
  plainParagraph,
  runs,
  textBoxShape,
} from "./pptx-shapes.js";
import type { PptxBullet, PptxSlideSpec } from "./pptx-spec.js";
import { tableShape } from "./pptx-table.js";
import { comparisonSides } from "./pptx-text-fit.js";
import type { PptxPalette } from "./pptx-theme.js";
import { SLIDE_HEIGHT, xfrm, type Box } from "./pptx-xml.js";

export { comparisonSides };

/**
 * The layouts ATO-2444 added: a section header, a two-sided comparison,
 * a timeline and a table-led slide. As in `pptx-layout-render.ts`, the
 * title stays in the title placeholder and the first text area in the
 * body placeholder, so the outline view and `os.fs.read_document` read
 * them back. Shape ids above 8 are this file's: 9.. for extra text
 * boxes, 30.. for the timeline's marks.
 */

function rect(id: number, name: string, box: Box, hex: string, geom = "rect"): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(box)}<a:prstGeom prst="${geom}"><a:avLst/></a:prstGeom>${colour(hex)}<a:ln><a:noFill/></a:ln></p:spPr></p:sp>`;
}

/** A section header: a tall accent bar, the title large and left, the subtitle under it. */
export function sectionSlide(slide: PptxSlideSpec, palette: PptxPalette): string {
  const bar: Box = { x: TITLE_BOX.x, y: 2_011_680, cx: 91_440, cy: 2_377_440 };
  const textX = bar.x + bar.cx + GAP;
  const titleBox: Box = { x: textX, y: bar.y, cx: TITLE_BOX.x + TITLE_BOX.cx - textX, cy: 1_463_040 };
  const shapes = [
    rect(4, "Accent 3", bar, palette.accent),
    placeholderShape(2, "Title 1", TITLE_PH, titleBox, `<a:bodyPr anchor="b">${AUTOFIT}</a:bodyPr>`, `<a:p>${runs(slide.title, ' sz="4400"')}</a:p>`),
  ];
  if (slide.subtitle !== undefined) {
    const subBox: Box = { ...titleBox, y: titleBox.y + titleBox.cy + 45_720, cy: bar.cy - titleBox.cy - 45_720 };
    shapes.push(
      placeholderShape(3, "Subtitle 2", BODY_PH, subBox, `<a:bodyPr anchor="t">${AUTOFIT}</a:bodyPr>`, plainParagraph(colouredRun(slide.subtitle, palette.muted, ' sz="2400"'))),
    );
  }
  return shapes.join("");
}

function sideParagraphs(side: readonly PptxBullet[], palette: PptxPalette): string {
  const [head, ...points] = side;
  if (head === undefined) return '<a:p><a:endParaRPr lang="en-US"/></a:p>';
  const heading = plainParagraph(colouredRun(head.text, palette.accent, ' sz="2400" b="1"'));
  const lifted = points.map((b) => ({ text: b.text, level: Math.max(0, b.level - 1) }));
  return heading + explicitBullets(lifted, palette);
}

/** Two columns side by side, each with its heading, a thin rule between them. */
export function comparisonSlide(slide: PptxSlideSpec, palette: PptxPalette): string {
  const half = (BODY_BOX.cx - GAP) / 2;
  const [left, right] = comparisonSides(slide.bullets);
  const divider: Box = { x: BODY_BOX.x + half + GAP / 2 - 6_350, y: BODY_BOX.y, cx: 12_700, cy: BODY_BOX.cy };
  const top = slide.subtitle === undefined ? 0 : 548_640;
  const shapes = [headerShapes(slide.title, palette)];
  if (slide.subtitle !== undefined) {
    shapes.push(textBoxShape(10, "Lead 9", { ...BODY_BOX, cy: top }, plainParagraph(colouredRun(slide.subtitle, palette.muted, ' sz="2000" i="1"'))));
  }
  const area: Box = { ...BODY_BOX, y: BODY_BOX.y + top, cy: BODY_BOX.cy - top, cx: half };
  shapes.push(
    placeholderShape(3, "Content 2", BODY_PH, area, `<a:bodyPr anchor="t">${AUTOFIT}</a:bodyPr>`, sideParagraphs(left, palette)),
    rect(9, "Divider 8", { ...divider, y: area.y, cy: area.cy }, palette.muted),
    textBoxShape(8, "Content 7", { ...area, x: BODY_BOX.x + half + GAP }, sideParagraphs(right, palette)),
  );
  return shapes.join("");
}

/** "2024: Launch" → ["2024", "Launch"]; a step without a marker keeps its text whole. */
export function timelineStep(text: string): [string, string] {
  const m = /^(.{1,24}?)\s*[:\-–—]\s*(.+)$/su.exec(text);
  return m ? [m[1]!.trim(), m[2]!.trim()] : ["", text];
}

/** Steps along a line: a dot per step, its marker above in the accent colour, its text below. */
export function timelineSlide(slide: PptxSlideSpec, palette: PptxPalette): string {
  const steps = slide.bullets;
  const n = Math.max(1, steps.length);
  const lineY = BODY_BOX.y + 1_371_600;
  const slot = BODY_BOX.cx / n;
  const dot = 228_600;
  const shapes = [headerShapes(slide.title, palette), rect(30, "Line 29", { x: BODY_BOX.x, y: lineY - 19_050, cx: BODY_BOX.cx, cy: 38_100 }, palette.muted)];
  const texts: string[] = [];
  steps.forEach((step, i) => {
    const [mark, body] = timelineStep(step.text);
    const cx = BODY_BOX.x + slot * i + slot / 2;
    shapes.push(rect(31 + i, `Step ${i + 1}`, { x: cx - dot / 2, y: lineY - dot / 2, cx: dot, cy: dot }, palette.accent, "ellipse"));
    const markBox: Box = { x: BODY_BOX.x + slot * i, y: lineY - 868_680, cx: slot, cy: 640_080 };
    const bodyBox: Box = { x: markBox.x + 45_720, y: lineY + 274_320, cx: slot - 91_440, cy: SLIDE_HEIGHT - lineY - 594_360 };
    if (mark.length > 0) {
      shapes.push(textBoxShape(40 + i, `Marker ${i + 1}`, markBox, plainParagraph(colouredRun(mark, palette.accent, ' sz="2000" b="1"'), "ctr")));
    }
    texts.push(plainParagraph(colouredRun(body, palette.text, ` sz="${n > 4 ? 1400 : 1600}"`), "ctr"));
    if (i > 0) shapes.push(textBoxShape(50 + i, `Step text ${i + 1}`, bodyBox, texts[i]!));
    else shapes.push(placeholderShape(3, "Content 2", BODY_PH, bodyBox, `<a:bodyPr anchor="t">${AUTOFIT}</a:bodyPr>`, texts[0]!));
  });
  if (slide.subtitle !== undefined) {
    shapes.push(textBoxShape(10, "Lead 9", { ...BODY_BOX, cy: 548_640 }, plainParagraph(colouredRun(slide.subtitle, palette.muted, ' sz="2000" i="1"'))));
  }
  return shapes.join("");
}

/** The table across the body; the subtitle and up to two bullets go under it as a short caption. */
export function tableSlide(slide: PptxSlideSpec, palette: PptxPalette): string {
  const hasText = slide.bullets.length > 0 || slide.subtitle !== undefined;
  const caption = hasText ? 1_188_720 : 0;
  const shapes = [headerShapes(slide.title, palette)];
  if (slide.table !== undefined) shapes.push(tableShape(slide.table, { ...BODY_BOX, cy: BODY_BOX.cy - caption - (hasText ? 91_440 : 0) }));
  if (hasText) {
    const box: Box = { ...BODY_BOX, y: BODY_BOX.y + BODY_BOX.cy - caption, cy: caption };
    shapes.push(placeholderShape(3, "Content 2", BODY_PH, box, `<a:bodyPr anchor="t">${AUTOFIT}</a:bodyPr>`, bodyParagraphs(slide.subtitle, slide.bullets, palette)));
  }
  return shapes.join("");
}
