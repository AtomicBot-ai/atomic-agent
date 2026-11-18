import type JSZip from "jszip";

import {
  addDefault,
  addOverride,
  addRelationship,
  nextFreePartName,
  readPart,
  relsPathOf,
  resolveTarget,
} from "../ooxml/ooxml-package.js";
import type { PptxImageInfo } from "../pptx/pptx-image.js";
import { W_NS, escapeXmlText, paragraphXml, runsXml, type DocBlock } from "./docx-xml.js";

/**
 * Turning parsed blocks into body XML inside a real package: list items
 * get Word numbering (`word/numbering.xml`, added or extended), tables
 * become `w:tbl`, pictures become inline drawings with their media part
 * and relationship, and with `revision` every inserted thing is marked
 * as a tracked insertion. Shaped after what Word writes when you press
 * the list buttons, insert a table or a picture with Track Changes on,
 * and after python-docx's `new_pic_inline`.
 */

export interface DocImageInput {
  data: Buffer;
  info: PptxImageInfo;
  /** File name, kept as the picture's name and alt text fallback. */
  name: string;
}

/** A tracked change's author and time: who Word shows in the balloon. */
export interface Revision {
  author: string;
  date: Date;
  /** Next free `w:id` for a revision mark. */
  nextId: number;
}

export const REVISION_AUTHOR = "Atomic Agent";

export interface RenderOptions {
  /** Pictures by the path the block wrote. */
  images?: ReadonlyMap<string, DocImageInput>;
  revision?: Revision;
}

const NUMBERING_REL = "numbering";
const NUMBERING_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml";
const IMAGE_CT: Record<PptxImageInfo["kind"], string> = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif" };

/** EMU per pixel at 96 dpi, and the room on an A4 page with 2 cm margins. */
const EMU_PER_PX = 9525;
const MAX_IMAGE_CX = 6_120_000;
const MAX_IMAGE_CY = 8_500_000;
/** Text width of that page in twentieths of a point, for table columns. */
const TEXT_WIDTH_TWIPS = 9638;

function revisionStamp(rev: Revision): string {
  return rev.date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function revisionAttrs(rev: Revision): string {
  const id = rev.nextId;
  rev.nextId += 1;
  return `w:id="${id}" w:author="${escapeXmlText(rev.author)}" w:date="${revisionStamp(rev)}"`;
}

/** The largest number in `attr="N"` across `xml`, or 0. */
export function maxAttr(xml: string, attr: RegExp): number {
  let max = 0;
  for (const match of xml.matchAll(attr)) max = Math.max(max, Number(match[1]));
  return max;
}

const BULLETS = ["•", "◦", "▪"];
const NUMBER_FORMATS = ["decimal", "lowerLetter", "lowerRoman"];

function abstractNumXml(id: number, ordered: boolean): string {
  const levels = Array.from({ length: 9 }, (_, ilvl) => {
    const left = 720 * (ilvl + 1);
    const format = ordered ? NUMBER_FORMATS[ilvl % 3]! : "bullet";
    const text = ordered ? `%${ilvl + 1}.` : BULLETS[ilvl % 3]!;
    return (
      `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/>` +
      `<w:pPr><w:ind w:left="${left}" w:hanging="360"/></w:pPr></w:lvl>`
    );
  }).join("");
  return `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="hybridMultilevel"/>${levels}</w:abstractNum>`;
}

interface ListPlan {
  /** numId per block index, for list items. */
  numIds: Map<number, number>;
  abstractNums: string;
  nums: string;
}

/**
 * One `w:num` for all bullets, and one per run of consecutive list
 * items that contains numbered ones, the way Word starts a new list
 * after a paragraph. Each run starts at the number its first item was
 * typed with, so `4. Results` after a paragraph stays 4 (Markdown
 * renderers do the same).
 */
function planLists(blocks: readonly DocBlock[], abstractBase: number, numBase: number): ListPlan | null {
  const numIds = new Map<number, number>();
  const isItem = (b: DocBlock) => b.kind === "bullet" || b.kind === "numbered";
  if (!blocks.some(isItem)) return null;
  const bulletAbstract = abstractBase;
  const orderedAbstract = abstractBase + 1;
  let nextNum = numBase;
  const bulletNum = nextNum++;
  const nums: string[] = [`<w:num w:numId="${bulletNum}"><w:abstractNumId w:val="${bulletAbstract}"/></w:num>`];
  let listNum: number | undefined;
  blocks.forEach((block, index) => {
    if (!isItem(block)) {
      listNum = undefined;
      return;
    }
    if (block.kind === "bullet") {
      numIds.set(index, bulletNum);
      return;
    }
    if (listNum === undefined) {
      listNum = nextNum++;
      const start = Math.max(1, block.start ?? 1);
      nums.push(
        `<w:num w:numId="${listNum}"><w:abstractNumId w:val="${orderedAbstract}"/>` +
          `<w:lvlOverride w:ilvl="${block.level ?? 0}"><w:startOverride w:val="${start}"/></w:lvlOverride></w:num>`,
      );
    }
    numIds.set(index, listNum);
  });
  return {
    numIds,
    abstractNums: abstractNumXml(bulletAbstract, false) + abstractNumXml(orderedAbstract, true),
    nums: nums.join(""),
  };
}

/** Where the main part's numbering lives, if it has one. */
async function numberingPartOf(zip: JSZip, main: string): Promise<string | null> {
  const rels = await readPart(zip, relsPathOf(main));
  const tag = rels?.match(/<Relationship\b[^>]*Type="[^"]*\/numbering"[^>]*>/)?.[0];
  const target = tag?.match(/Target="([^"]+)"/)?.[1];
  if (target === undefined) return null;
  const path = resolveTarget(main, target);
  return zip.file(path) === null ? null : path;
}

/**
 * Add the lists' definitions to the package: into the existing numbering
 * part (ids after the ones there, abstract definitions before the first
 * `w:num` as the schema orders them), or a new one wired to the main part.
 */
async function writeNumbering(zip: JSZip, main: string, blocks: readonly DocBlock[]): Promise<Map<number, number>> {
  const existingPath = await numberingPartOf(zip, main);
  const existing = existingPath === null ? undefined : await readPart(zip, existingPath);
  const abstractBase = existing === undefined ? 0 : maxAttr(existing, /w:abstractNumId="(\d+)"/g) + 1;
  const numBase = existing === undefined ? 1 : maxAttr(existing, /w:numId="(\d+)"/g) + 1;
  const plan = planLists(blocks, abstractBase, numBase);
  if (plan === null) return new Map();
  if (existingPath !== null && existing !== undefined) {
    const firstNum = existing.search(/<w:num\b/);
    const end = existing.lastIndexOf("</w:numbering>");
    if (end < 0) throw new Error("the numbering part is not well formed");
    const at = firstNum >= 0 ? firstNum : end;
    const withAbstract = existing.slice(0, at) + plan.abstractNums + existing.slice(at);
    const newEnd = withAbstract.lastIndexOf("</w:numbering>");
    zip.file(existingPath, withAbstract.slice(0, newEnd) + plan.nums + withAbstract.slice(newEnd));
    return plan.numIds;
  }
  const dir = main.includes("/") ? main.slice(0, main.lastIndexOf("/") + 1) : "";
  const path = `${dir}numbering.xml`;
  zip.file(
    path,
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="${W_NS}">${plan.abstractNums}${plan.nums}</w:numbering>`,
  );
  await addRelationship(zip, main, NUMBERING_REL, "numbering.xml");
  await addOverride(zip, path, NUMBERING_CT);
  return plan.numIds;
}

function tableXml(rows: readonly string[][]): string {
  const cols = rows[0]?.length ?? 1;
  const width = Math.floor(TEXT_WIDTH_TWIPS / cols);
  const border = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`;
  const borders = ["top", "left", "bottom", "right", "insideH", "insideV"].map(border).join("");
  const grid = Array.from({ length: cols }, () => `<w:gridCol w:w="${width}"/>`).join("");
  const body = rows
    .map((row, r) => {
      const header = r === 0 ? "<w:trPr><w:tblHeader/></w:trPr>" : "";
      const cells = row
        .map((value) => {
          // The header row is bold, like Word's "Header Row" table option.
          const text = r === 0 && value.length > 0 ? `**${value.replace(/\*\*/g, "")}**` : value;
          return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr><w:p>${runsXml(text)}</w:p></w:tc>`;
        })
        .join("");
      return `<w:tr>${header}${cells}</w:tr>`;
    })
    .join("");
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${borders}</w:tblBorders>` +
    '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>' +
    `<w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>`
  );
}

const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_PIC = "http://schemas.openxmlformats.org/drawingml/2006/picture";
const NS_WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";

/** Native size at 96 dpi, scaled down to fit the page, aspect kept. */
export function imageExtent(info: PptxImageInfo): { cx: number; cy: number } {
  let cx = Math.max(1, info.width) * EMU_PER_PX;
  let cy = Math.max(1, info.height) * EMU_PER_PX;
  const scale = Math.min(1, MAX_IMAGE_CX / cx, MAX_IMAGE_CY / cy);
  cx = Math.round(cx * scale);
  cy = Math.round(cy * scale);
  return { cx, cy };
}

function pictureXml(relId: string, docPrId: number, name: string, alt: string, info: PptxImageInfo): string {
  const { cx, cy } = imageExtent(info);
  return (
    `<w:p><w:r><w:drawing><wp:inline xmlns:wp="${NS_WP}" distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:docPr id="${docPrId}" name="Picture ${docPrId}" descr="${escapeXmlText(alt).replace(/"/g, "&quot;")}"/>` +
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${NS_A}" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic xmlns:a="${NS_A}"><a:graphicData uri="${NS_PIC}"><pic:pic xmlns:pic="${NS_PIC}">` +
    `<pic:nvPicPr><pic:cNvPr id="0" name="${escapeXmlText(name).replace(/"/g, "&quot;")}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    "</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>"
  );
}

/**
 * Mark generated body XML as one tracked insertion: each run wrapped in
 * `w:ins`, each paragraph mark and table row flagged inserted, so
 * "Reject All" in Word takes the whole addition back out.
 */
export function trackInserted(xml: string, rev: Revision): string {
  const mark = () => `<w:ins ${revisionAttrs(rev)}/>`;
  let out = xml.replace(/<w:r>[\s\S]*?<\/w:r>/g, (run) => `<w:ins ${revisionAttrs(rev)}>${run}</w:ins>`);
  // Paragraph marks: the inserted flag goes last in w:pPr (its w:rPr).
  out = out.replace(/<w:p\/>|<w:p>(<w:pPr>[\s\S]*?<\/w:pPr>)?/g, (whole, pPr: string | undefined) => {
    if (whole === "<w:p/>") return `<w:p><w:pPr><w:rPr>${mark()}</w:rPr></w:pPr></w:p>`;
    if (pPr === undefined) return `<w:p><w:pPr><w:rPr>${mark()}</w:rPr></w:pPr>`;
    return `<w:p>${pPr.slice(0, -"</w:pPr>".length)}<w:rPr>${mark()}</w:rPr></w:pPr>`;
  });
  out = out.replace(/<w:tr>(<w:trPr>[\s\S]*?<\/w:trPr>)?/g, (_whole, trPr: string | undefined) =>
    trPr === undefined
      ? `<w:tr><w:trPr>${mark()}</w:trPr>`
      : `<w:tr>${trPr.slice(0, -"</w:trPr>".length)}${mark()}</w:trPr>`,
  );
  return out;
}

/**
 * Render `blocks` as body XML for the package's main part `main`, adding
 * the numbering, media and relationships they need to `zip`. `bodyXml`
 * is the main part as it is now (to pick unused picture ids).
 */
export async function renderBlocks(
  zip: JSZip,
  main: string,
  bodyXml: string,
  blocks: readonly DocBlock[],
  options: RenderOptions = {},
): Promise<string> {
  const numIds = await writeNumbering(zip, main, blocks);
  let docPrId = maxAttr(bodyXml, /<wp:docPr\b[^>]*\bid="(\d+)"/g) + 1;
  const media = new Map<string, string>();
  const parts: string[] = [];
  for (const [index, block] of blocks.entries()) {
    if (block.kind === "table" && block.rows !== undefined) {
      parts.push(tableXml(block.rows));
      continue;
    }
    if (block.kind === "image" && block.path !== undefined) {
      const image = options.images?.get(block.path);
      if (image === undefined) throw new Error(`no picture was loaded for ${block.path}`);
      let relId = media.get(block.path);
      if (relId === undefined) {
        const ext = image.info.kind === "jpeg" ? "jpeg" : image.info.kind;
        const dir = main.includes("/") ? main.slice(0, main.lastIndexOf("/") + 1) : "";
        const part = nextFreePartName(zip, (n) => `${dir}media/image${n}.${ext}`);
        zip.file(part, image.data);
        await addDefault(zip, ext, IMAGE_CT[image.info.kind]);
        relId = await addRelationship(zip, main, "image", part.slice(dir.length));
        media.set(block.path, relId);
      }
      parts.push(pictureXml(relId, docPrId, image.name, block.text || image.name, image.info));
      docPrId += 1;
      continue;
    }
    parts.push(paragraphXml(block, numIds.get(index)));
  }
  // Word wants a paragraph after a table that ends the body.
  if (blocks[blocks.length - 1]?.kind === "table") parts.push("<w:p/>");
  const xml = parts.join("");
  return options.revision === undefined ? xml : trackInserted(xml, options.revision);
}

