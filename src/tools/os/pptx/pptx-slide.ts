import { BODY_BOX, GROUP_HEADER, TITLE_BOX } from "./pptx-parts.js";
import { chartReference } from "../ooxml/ooxml-chart.js";
import { resolveLayout } from "./pptx-layout.js";
import {
  bigNumberSlide,
  chartSlide,
  imageFullSlide,
  quoteSlide,
  twoColumnSlide,
} from "./pptx-layout-render.js";
import { comparisonSlide, sectionSlide, tableSlide, timelineSlide } from "./pptx-layout-render-extra.js";
import { tableShape } from "./pptx-table.js";
import {
  AUTOFIT,
  BODY_PH,
  GAP,
  TITLE_PH,
  bodyParagraphs,
  colour,
  graphicFrame,
  headerShapes,
  pictureShape,
  placeholderShape,
  run,
  runs,
  type PlacedImage,
} from "./pptx-shapes.js";
import type { PptxSlideSpec } from "./pptx-spec.js";
import type { PptxPalette } from "./pptx-theme.js";
import { PML_NS, XML_HEAD, escapeXml, type Box } from "./pptx-xml.js";

/**
 * One slide and its speaker notes. Text sits in the layout's title and
 * body placeholders (so it shows in the outline and survives a layout
 * change), with positions spelled out on the slide so every viewer
 * draws the same thing even if it ignores inheritance. The slide's
 * `layout` (or the one `pptx-layout.ts` picks) chooses the shape tree.
 */

export type { PlacedImage } from "./pptx-shapes.js";

export function isTitleSlide(slide: PptxSlideSpec): boolean {
  return (
    slide.bullets.length === 0 &&
    slide.image === undefined &&
    slide.table === undefined &&
    slide.chart === undefined
  );
}

function titleSlide(slide: PptxSlideSpec, palette: PptxPalette): string {
  const titleBox: Box = { x: TITLE_BOX.x, y: 2_057_400, cx: TITLE_BOX.cx, cy: 1_463_040 };
  const subBox: Box = { x: TITLE_BOX.x, y: 3_611_880, cx: TITLE_BOX.cx, cy: 1_188_720 };
  const title = placeholderShape(
    2,
    "Title 1",
    TITLE_PH,
    titleBox,
    `<a:bodyPr anchor="b">${AUTOFIT}</a:bodyPr>`,
    `<a:p><a:pPr algn="ctr"/>${runs(slide.title, ' sz="4800"')}</a:p>`,
  );
  if (slide.subtitle === undefined) return title;
  const subtitle = placeholderShape(
    3,
    "Subtitle 2",
    BODY_PH,
    subBox,
    `<a:bodyPr anchor="t">${AUTOFIT}</a:bodyPr>`,
    `<a:p><a:pPr marL="0" indent="0" algn="ctr"><a:buNone/></a:pPr><a:r><a:rPr lang="en-US" dirty="0" sz="2400">${colour(palette.muted)}</a:rPr><a:t>${escapeXml(slide.subtitle)}</a:t></a:r></a:p>`,
  );
  return title + subtitle;
}

/** The `bullets` layout: text full width, or the left half beside a picture, table or chart. */
function contentSlide(
  slide: PptxSlideSpec,
  palette: PptxPalette,
  image?: PlacedImage,
  chartRelId?: string,
): string {
  const shapes: string[] = [headerShapes(slide.title, palette)];
  const hasText = slide.bullets.length > 0 || slide.subtitle !== undefined;
  const half = (BODY_BOX.cx - GAP) / 2;
  const chart = slide.chart !== undefined && chartRelId !== undefined;
  const hasVisual = image !== undefined || slide.table !== undefined || chart;
  if (hasText) {
    const textBox: Box = hasVisual ? { ...BODY_BOX, cx: half } : BODY_BOX;
    shapes.push(
      placeholderShape(3, "Content 2", BODY_PH, textBox, `<a:bodyPr anchor="t">${AUTOFIT}</a:bodyPr>`, bodyParagraphs(slide.subtitle, slide.bullets, palette)),
    );
  }
  const area: Box = hasText ? { ...BODY_BOX, x: BODY_BOX.x + half + GAP, cx: half } : BODY_BOX;
  if (image) shapes.push(pictureShape(image, area));
  else if (slide.table !== undefined) shapes.push(tableShape(slide.table, area));
  else if (slide.chart !== undefined && chartRelId !== undefined) {
    shapes.push(graphicFrame(7, "Chart 6", area, chartReference(chartRelId)));
  }
  return shapes.join("");
}

function slideBody(
  slide: PptxSlideSpec,
  palette: PptxPalette,
  image?: PlacedImage,
  chartRelId?: string,
): string {
  // The builder stamps the layout it picked; a hand-built spec without
  // one, or with one that cannot show its content, gets the automatic one.
  switch (resolveLayout(slide)) {
    case "title":
      return titleSlide(slide, palette);
    case "quote":
      return quoteSlide(slide, palette);
    case "big-number":
      return bigNumberSlide(slide, palette);
    case "two-column":
      return twoColumnSlide(slide, palette);
    case "image-full":
      return imageFullSlide(slide, palette, image);
    case "chart":
      return chartSlide(slide, palette, chartRelId);
    case "section":
      return sectionSlide(slide, palette);
    case "comparison":
      return comparisonSlide(slide, palette);
    case "timeline":
      return timelineSlide(slide, palette);
    case "table":
      return tableSlide(slide, palette);
    case "bullets":
      return contentSlide(slide, palette, image, chartRelId);
  }
}

/** `chartRelId`: the slide's relationship to its chart part, when the slide has a chart. */
export function slideXml(
  slide: PptxSlideSpec,
  palette: PptxPalette,
  image?: PlacedImage,
  chartRelId?: string,
): string {
  return (
    XML_HEAD +
    `<p:sld ${PML_NS}>` +
    `<p:cSld><p:spTree>${GROUP_HEADER}${slideBody(slide, palette, image, chartRelId)}</p:spTree></p:cSld>` +
    "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>" +
    "</p:sld>"
  );
}

export function notesSlideXml(notes: string): string {
  const paragraphs = notes
    .split(/\r?\n/)
    .map((line) => (line.length > 0 ? `<a:p>${run(line)}</a:p>` : '<a:p><a:endParaRPr lang="en-US"/></a:p>'))
    .join("");
  return (
    XML_HEAD +
    `<p:notes ${PML_NS}>` +
    "<p:cSld><p:spTree>" +
    GROUP_HEADER +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>' +
    `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>` +
    "</p:spTree></p:cSld>" +
    "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>" +
    "</p:notes>"
  );
}
