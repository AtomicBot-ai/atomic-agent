import { TITLE_BOX } from "./pptx-parts.js";
import { fitInto, type PptxImageInfo } from "./pptx-image.js";
import type { PptxBullet } from "./pptx-spec.js";
import type { PptxPalette } from "./pptx-theme.js";
import { escapeXml, xfrm, type Box } from "./pptx-xml.js";

/**
 * Shape-level XML shared by every slide layout: text runs, placeholders,
 * the title band, pictures and graphic frames. Shape ids are fixed per
 * role (2 title, 3 body, 4 accent rule, 5 picture, 6 table, 7 chart,
 * 8 second column), so no two shapes on a slide share one.
 */

export interface PlacedImage {
  info: PptxImageInfo;
  /** Relationship id inside the slide's rels part. */
  relId: string;
  /** File name shown as the picture's alt text. */
  name: string;
}

export const GAP = 304_800;
export const TITLE_PH = '<p:ph type="title"/>';
export const BODY_PH = '<p:ph type="body" idx="1"/>';
export const AUTOFIT = "<a:normAutofit/>";

export function colour(hex: string): string {
  return `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`;
}

export function run(text: string, extra = ""): string {
  return `<a:r><a:rPr lang="en-US" dirty="0"${extra}/><a:t>${escapeXml(text)}</a:t></a:r>`;
}

/** Line breaks inside one paragraph stay soft breaks, not new bullets. */
export function runs(text: string, extra = ""): string {
  return text
    .split(/\r?\n/)
    .map((line) => run(line, extra))
    .join('<a:br><a:rPr lang="en-US"/></a:br>');
}

/** One run with its own colour (and attributes such as `sz` or `i`). */
export function colouredRun(text: string, hex: string, attrs = ""): string {
  return `<a:r><a:rPr lang="en-US" dirty="0"${attrs}>${colour(hex)}</a:rPr><a:t>${escapeXml(text)}</a:t></a:r>`;
}

/** A paragraph with no bullet, aligned `algn` (l, ctr, r). */
export function plainParagraph(content: string, algn = "l"): string {
  return `<a:p><a:pPr marL="0" indent="0" algn="${algn}"><a:buNone/></a:pPr>${content}</a:p>`;
}

export function placeholderShape(
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

/** A plain text box (not a placeholder), for a second text area on one slide. */
export function textBoxShape(id: number, name: string, box: Box, paragraphs: string): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr>${xfrm(box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square" anchor="t">${AUTOFIT}</a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`
  );
}

const LEVEL_SIZES = [2400, 2000, 1800, 1600, 1600];

/**
 * Bullets spelled out paragraph by paragraph (indent, bullet glyph,
 * size, colour), matching the master's body style, for a text box that
 * does not inherit it.
 */
export function explicitBullets(bullets: readonly PptxBullet[], palette: PptxPalette): string {
  return bullets
    .map((b) => {
      const marL = 342_900 + b.level * 457_200;
      const size = LEVEL_SIZES[b.level] ?? 1600;
      const pPr =
        `<a:pPr marL="${marL}" indent="-342900"><a:spcBef><a:spcPts val="1000"/></a:spcBef>` +
        `<a:buClr><a:srgbClr val="${palette.accent}"/></a:buClr><a:buFont typeface="Arial"/><a:buChar char="${b.level === 0 ? "•" : "–"}"/></a:pPr>`;
      const lines = b.text
        .split(/\r?\n/)
        .map((line) => colouredRun(line, palette.text, ` sz="${size}"`))
        .join('<a:br><a:rPr lang="en-US"/></a:br>');
      return `<a:p>${pPr}${lines}</a:p>`;
    })
    .join("");
}

/** A body placeholder's text: the subtitle as an unbulleted italic lead-in, then the bullets. */
export function bodyParagraphs(
  subtitle: string | undefined,
  bullets: readonly PptxBullet[],
  palette: PptxPalette,
): string {
  const paragraphs: string[] = [];
  if (subtitle !== undefined) paragraphs.push(plainParagraph(colouredRun(subtitle, palette.muted, ' i="1"')));
  for (const bullet of bullets) {
    const pPr = bullet.level > 0 ? `<a:pPr lvl="${bullet.level}"/>` : "";
    paragraphs.push(`<a:p>${pPr}${runs(bullet.text)}</a:p>`);
  }
  return paragraphs.length > 0 ? paragraphs.join("") : '<a:p><a:endParaRPr lang="en-US"/></a:p>';
}

/** The title placeholder at the top and the short accent rule under it. */
export function headerShapes(title: string, palette: PptxPalette): string {
  const rule: Box = { x: TITLE_BOX.x, y: TITLE_BOX.y + TITLE_BOX.cy + 45_720, cx: 1_097_280, cy: 54_864 };
  return (
    placeholderShape(2, "Title 1", TITLE_PH, TITLE_BOX, `<a:bodyPr anchor="b">${AUTOFIT}</a:bodyPr>`, `<a:p>${runs(title)}</a:p>`) +
    // The one decorative touch.
    `<p:sp><p:nvSpPr><p:cNvPr id="4" name="Accent 3"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(rule)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${colour(palette.accent)}<a:ln><a:noFill/></a:ln></p:spPr></p:sp>`
  );
}

export function graphicFrame(id: number, name: string, box: Box, graphic: string): string {
  const r = (n: number) => Math.round(n);
  return (
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${name}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm><a:off x="${r(box.x)}" y="${r(box.y)}"/><a:ext cx="${r(box.cx)}" cy="${r(box.cy)}"/></p:xfrm>` +
    graphic +
    "</p:graphicFrame>"
  );
}

export function pictureShape(image: PlacedImage, area: Box): string {
  const box = fitInto(image.info, area);
  return (
    `<p:pic><p:nvPicPr><p:cNvPr id="5" name="Picture 4" descr="${escapeXml(image.name)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="${image.relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr>${xfrm(box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
  );
}
