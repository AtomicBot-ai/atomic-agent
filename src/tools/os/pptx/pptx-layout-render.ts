import { chartReference } from "../ooxml/ooxml-chart.js";
import { splitColumns } from "./pptx-layout.js";
import { BODY_BOX, TITLE_BOX } from "./pptx-parts.js";
import {
  AUTOFIT,
  BODY_PH,
  GAP,
  TITLE_PH,
  bodyParagraphs,
  colouredRun,
  explicitBullets,
  graphicFrame,
  headerShapes,
  pictureShape,
  placeholderShape,
  plainParagraph,
  runs,
  textBoxShape,
  type PlacedImage,
} from "./pptx-shapes.js";
import type { PptxSlideSpec } from "./pptx-spec.js";
import type { PptxPalette } from "./pptx-theme.js";
import { SLIDE_HEIGHT, SLIDE_WIDTH, xfrm, type Box } from "./pptx-xml.js";

/**
 * The shape trees of the layouts beyond the plain title and bullets
 * slides (those stay in `pptx-slide.ts`): quote, big number, two
 * columns, a full-width picture and a chart-led slide. Text still sits
 * in the title and body placeholders where a layout has one, so the
 * outline view and `os.fs.read_document` read it back.
 */

/** A quotation set large and centred; the subtitle is its attribution. */
export function quoteSlide(slide: PptxSlideSpec, palette: PptxPalette): string {
  const inset = 609_600;
  const quoteBox: Box = { x: TITLE_BOX.x + inset, y: 1_371_600, cx: TITLE_BOX.cx - 2 * inset, cy: 3_200_400 };
  const rule: Box = { x: SLIDE_WIDTH / 2 - 548_640, y: 1_143_000, cx: 1_097_280, cy: 54_864 };
  const shapes = [
    `<p:sp><p:nvSpPr><p:cNvPr id="4" name="Accent 3"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(rule)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${palette.accent}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>`,
    placeholderShape(
      2,
      "Title 1",
      TITLE_PH,
      quoteBox,
      `<a:bodyPr anchor="ctr">${AUTOFIT}</a:bodyPr>`,
      `<a:p><a:pPr algn="ctr"/>${runs(slide.title, ' sz="4000" i="1" b="0"')}</a:p>`,
    ),
  ];
  if (slide.subtitle !== undefined) {
    const byBox: Box = { x: quoteBox.x, y: quoteBox.y + quoteBox.cy + 91_440, cx: quoteBox.cx, cy: 914_400 };
    shapes.push(
      placeholderShape(
        3,
        "Attribution 2",
        BODY_PH,
        byBox,
        `<a:bodyPr anchor="t">${AUTOFIT}</a:bodyPr>`,
        plainParagraph(colouredRun(slide.subtitle, palette.muted, ' sz="2000"'), "ctr"),
      ),
    );
  }
  return shapes.join("");
}

/** One figure as the headline, in the accent colour; subtitle and one bullet are its caption. */
export function bigNumberSlide(slide: PptxSlideSpec, palette: PptxPalette): string {
  const numberBox: Box = { x: TITLE_BOX.x, y: 1_280_160, cx: TITLE_BOX.cx, cy: 2_743_200 };
  const captionBox: Box = { x: TITLE_BOX.x, y: 4_206_240, cx: TITLE_BOX.cx, cy: 1_645_920 };
  const shapes = [
    placeholderShape(
      2,
      "Title 1",
      TITLE_PH,
      numberBox,
      `<a:bodyPr anchor="b">${AUTOFIT}</a:bodyPr>`,
      plainParagraph(colouredRun(slide.title, palette.accent, ' sz="11500" b="1"'), "ctr"),
    ),
  ];
  const caption: string[] = [];
  if (slide.subtitle !== undefined) caption.push(plainParagraph(colouredRun(slide.subtitle, palette.muted, ' sz="2800"'), "ctr"));
  for (const bullet of slide.bullets) caption.push(plainParagraph(colouredRun(bullet.text, palette.text, ' sz="2400"'), "ctr"));
  if (caption.length > 0) {
    shapes.push(
      placeholderShape(3, "Caption 2", BODY_PH, captionBox, `<a:bodyPr anchor="t">${AUTOFIT}</a:bodyPr>`, caption.join("")),
    );
  }
  return shapes.join("");
}

/**
 * Bullets in two columns: the left in the body placeholder (so the
 * outline keeps them), the right in a text box styled like it.
 */
export function twoColumnSlide(slide: PptxSlideSpec, palette: PptxPalette): string {
  const half = (BODY_BOX.cx - GAP) / 2;
  const [left, right] = splitColumns(slide.bullets);
  const shapes = [
    headerShapes(slide.title, palette),
    placeholderShape(
      3,
      "Content 2",
      BODY_PH,
      { ...BODY_BOX, cx: half },
      `<a:bodyPr anchor="t">${AUTOFIT}</a:bodyPr>`,
      bodyParagraphs(slide.subtitle, left, palette),
    ),
  ];
  if (right.length > 0) {
    shapes.push(textBoxShape(8, "Content 7", { ...BODY_BOX, x: BODY_BOX.x + half + GAP, cx: half }, explicitBullets(right, palette)));
  }
  return shapes.join("");
}

/** The picture across the slide's full width under the title; the subtitle is a caption. */
export function imageFullSlide(slide: PptxSlideSpec, palette: PptxPalette, image?: PlacedImage): string {
  const side = 304_800;
  const captionHeight = slide.subtitle === undefined ? 0 : 640_080;
  const area: Box = {
    x: side,
    y: BODY_BOX.y,
    cx: SLIDE_WIDTH - 2 * side,
    cy: SLIDE_HEIGHT - BODY_BOX.y - 228_600 - captionHeight,
  };
  const shapes = [headerShapes(slide.title, palette)];
  if (image) shapes.push(pictureShape(image, area));
  if (slide.subtitle !== undefined) {
    const captionBox: Box = { x: BODY_BOX.x, y: area.y + area.cy + 45_720, cx: BODY_BOX.cx, cy: captionHeight - 45_720 };
    shapes.push(
      placeholderShape(
        3,
        "Caption 2",
        BODY_PH,
        captionBox,
        `<a:bodyPr anchor="t">${AUTOFIT}</a:bodyPr>`,
        plainParagraph(colouredRun(slide.subtitle, palette.muted, ' sz="1600"'), "ctr"),
      ),
    );
  }
  return shapes.join("");
}

/** The chart leads: the whole body, or two thirds of it with up to three bullets beside it. */
export function chartSlide(slide: PptxSlideSpec, palette: PptxPalette, chartRelId?: string): string {
  const hasText = slide.bullets.length > 0 || slide.subtitle !== undefined;
  const chartWidth = hasText ? ((BODY_BOX.cx - GAP) * 2) / 3 : BODY_BOX.cx;
  const shapes = [headerShapes(slide.title, palette)];
  if (chartRelId !== undefined) {
    shapes.push(graphicFrame(7, "Chart 6", { ...BODY_BOX, cx: chartWidth }, chartReference(chartRelId)));
  }
  if (hasText) {
    const textBox: Box = { ...BODY_BOX, x: BODY_BOX.x + chartWidth + GAP, cx: BODY_BOX.cx - chartWidth - GAP };
    shapes.push(
      placeholderShape(3, "Content 2", BODY_PH, textBox, `<a:bodyPr anchor="t">${AUTOFIT}</a:bodyPr>`, bodyParagraphs(slide.subtitle, slide.bullets, palette)),
    );
  }
  return shapes.join("");
}
