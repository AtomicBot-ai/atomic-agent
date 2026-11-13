import { BODY_BOX, GROUP_HEADER, TITLE_BOX } from "./pptx-parts.js";
import { fitInto, type PptxImageInfo } from "./pptx-image.js";
import type { PptxSlideSpec } from "./pptx-spec.js";
import type { PptxPalette } from "./pptx-theme.js";
import { PML_NS, XML_HEAD, escapeXml, xfrm, type Box } from "./pptx-xml.js";

/**
 * One slide and its speaker notes. Text sits in the layout's title and
 * body placeholders (so it shows in the outline and survives a layout
 * change), with positions spelled out on the slide so every viewer
 * draws the same thing even if it ignores inheritance.
 */

export interface PlacedImage {
  info: PptxImageInfo;
  /** Relationship id inside the slide's rels part. */
  relId: string;
  /** File name shown as the picture's alt text. */
  name: string;
}

const GAP = 304_800;

export function isTitleSlide(slide: PptxSlideSpec): boolean {
  return slide.bullets.length === 0 && slide.image === undefined;
}

function run(text: string, extra = ""): string {
  return `<a:r><a:rPr lang="en-US" dirty="0"${extra}/><a:t>${escapeXml(text)}</a:t></a:r>`;
}

/** Line breaks inside one paragraph stay soft breaks, not new bullets. */
function runs(text: string, extra = ""): string {
  return text
    .split(/\r?\n/)
    .map((line) => run(line, extra))
    .join('<a:br><a:rPr lang="en-US"/></a:br>');
}

function placeholderShape(
  id: number,
  name: string,
  ph: string,
  box: Box,
  bodyPr: string,
  paragraphs: string,
): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr>` +
    `<p:spPr>${xfrm(box)}</p:spPr>` +
    `<p:txBody>${bodyPr}<a:lstStyle/>${paragraphs}</p:txBody></p:sp>`
  );
}

const TITLE_PH = '<p:ph type="title"/>';
const BODY_PH = '<p:ph type="body" idx="1"/>';
const AUTOFIT = "<a:normAutofit/>";

function colour(hex: string): string {
  return `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`;
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

function bodyParagraphs(slide: PptxSlideSpec, palette: PptxPalette): string {
  const paragraphs: string[] = [];
  if (slide.subtitle !== undefined) {
    paragraphs.push(
      `<a:p><a:pPr marL="0" indent="0"><a:buNone/></a:pPr><a:r><a:rPr lang="en-US" dirty="0" i="1">${colour(palette.muted)}</a:rPr><a:t>${escapeXml(slide.subtitle)}</a:t></a:r></a:p>`,
    );
  }
  for (const bullet of slide.bullets) {
    const pPr = bullet.level > 0 ? `<a:pPr lvl="${bullet.level}"/>` : "";
    paragraphs.push(`<a:p>${pPr}${runs(bullet.text)}</a:p>`);
  }
  return paragraphs.length > 0 ? paragraphs.join("") : '<a:p><a:endParaRPr lang="en-US"/></a:p>';
}

function pictureShape(image: PlacedImage, area: Box): string {
  const box = fitInto(image.info, area);
  return (
    `<p:pic><p:nvPicPr><p:cNvPr id="5" name="Picture 4" descr="${escapeXml(image.name)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="${image.relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr>${xfrm(box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
  );
}

function contentSlide(slide: PptxSlideSpec, palette: PptxPalette, image?: PlacedImage): string {
  const shapes: string[] = [];
  shapes.push(
    placeholderShape(2, "Title 1", TITLE_PH, TITLE_BOX, `<a:bodyPr anchor="b">${AUTOFIT}</a:bodyPr>`, `<a:p>${runs(slide.title)}</a:p>`),
  );
  // A short accent rule under the title: the one decorative touch.
  const rule: Box = { x: TITLE_BOX.x, y: TITLE_BOX.y + TITLE_BOX.cy + 45_720, cx: 1_097_280, cy: 54_864 };
  shapes.push(
    `<p:sp><p:nvSpPr><p:cNvPr id="4" name="Accent 3"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(rule)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${colour(palette.accent)}<a:ln><a:noFill/></a:ln></p:spPr></p:sp>`,
  );
  const hasText = slide.bullets.length > 0 || slide.subtitle !== undefined;
  const half = (BODY_BOX.cx - GAP) / 2;
  if (hasText) {
    const textBox: Box = image ? { ...BODY_BOX, cx: half } : BODY_BOX;
    shapes.push(
      placeholderShape(3, "Content 2", BODY_PH, textBox, `<a:bodyPr anchor="t">${AUTOFIT}</a:bodyPr>`, bodyParagraphs(slide, palette)),
    );
  }
  if (image) {
    const area: Box = hasText ? { ...BODY_BOX, x: BODY_BOX.x + half + GAP, cx: half } : BODY_BOX;
    shapes.push(pictureShape(image, area));
  }
  return shapes.join("");
}

export function slideXml(slide: PptxSlideSpec, palette: PptxPalette, image?: PlacedImage): string {
  const body = isTitleSlide(slide) ? titleSlide(slide, palette) : contentSlide(slide, palette, image);
  return (
    XML_HEAD +
    `<p:sld ${PML_NS}>` +
    `<p:cSld><p:spTree>${GROUP_HEADER}${body}</p:spTree></p:cSld>` +
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
