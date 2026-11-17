import type { PptxPalette } from "./pptx-theme.js";
import {
  NOTES_HEIGHT,
  NOTES_WIDTH,
  PML_NS,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  XML_HEAD,
  escapeXml,
  xfrm,
  type Box,
} from "./pptx-xml.js";

/**
 * The package parts every deck carries regardless of its slides: content
 * types, presentation, one slide master with one layout, a notes master,
 * document properties. Kept to what PowerPoint, Keynote, Google Slides
 * and LibreOffice need to open the file as an ordinary editable deck.
 */

const MARGIN_X = 609_600;
export const TITLE_BOX: Box = { x: MARGIN_X, y: 365_760, cx: SLIDE_WIDTH - 2 * MARGIN_X, cy: 1_143_000 };
export const BODY_BOX: Box = { x: MARGIN_X, y: 1_600_200, cx: SLIDE_WIDTH - 2 * MARGIN_X, cy: 4_754_880 };

const CT = "application/vnd.openxmlformats-officedocument";
const PML_CT = `${CT}.presentationml`;

export function contentTypesXml(slideCount: number, notesSlides: readonly number[]): string {
  const override = (part: string, type: string) => `<Override PartName="${part}" ContentType="${type}"/>`;
  const slides = Array.from({ length: slideCount }, (_, i) =>
    override(`/ppt/slides/slide${i + 1}.xml`, `${PML_CT}.slide+xml`),
  ).join("");
  const notes = notesSlides
    .map((n) => override(`/ppt/notesSlides/notesSlide${n}.xml`, `${PML_CT}.notesSlide+xml`))
    .join("");
  return (
    XML_HEAD +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    '<Default Extension="jpeg" ContentType="image/jpeg"/>' +
    '<Default Extension="gif" ContentType="image/gif"/>' +
    override("/ppt/presentation.xml", `${PML_CT}.presentation.main+xml`) +
    override("/ppt/slideMasters/slideMaster1.xml", `${PML_CT}.slideMaster+xml`) +
    override("/ppt/slideLayouts/slideLayout1.xml", `${PML_CT}.slideLayout+xml`) +
    override("/ppt/notesMasters/notesMaster1.xml", `${PML_CT}.notesMaster+xml`) +
    override("/ppt/theme/theme1.xml", `${CT}.theme+xml`) +
    override("/ppt/theme/theme2.xml", `${CT}.theme+xml`) +
    override("/ppt/presProps.xml", `${PML_CT}.presProps+xml`) +
    override("/ppt/viewProps.xml", `${PML_CT}.viewProps+xml`) +
    override("/ppt/tableStyles.xml", `${PML_CT}.tableStyles+xml`) +
    slides +
    notes +
    override("/docProps/core.xml", "application/vnd.openxmlformats-package.core-properties+xml") +
    override("/docProps/app.xml", `${CT}.extended-properties+xml`) +
    "</Types>"
  );
}

/** Relationship ids of `ppt/_rels/presentation.xml.rels`; slides start after these. */
export const PRESENTATION_FIXED_RELS = 6;

export function presentationXml(slideCount: number): string {
  const ids = Array.from(
    { length: slideCount },
    (_, i) => `<p:sldId id="${256 + i}" r:id="rId${PRESENTATION_FIXED_RELS + 1 + i}"/>`,
  ).join("");
  return (
    XML_HEAD +
    `<p:presentation ${PML_NS} saveSubsetFonts="1">` +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    '<p:notesMasterIdLst><p:notesMasterId r:id="rId6"/></p:notesMasterIdLst>' +
    `<p:sldIdLst>${ids}</p:sldIdLst>` +
    `<p:sldSz cx="${SLIDE_WIDTH}" cy="${SLIDE_HEIGHT}"/>` +
    `<p:notesSz cx="${NOTES_WIDTH}" cy="${NOTES_HEIGHT}"/>` +
    "</p:presentation>"
  );
}

export function presentationRels(slideCount: number): { id: string; type: string; target: string }[] {
  return [
    { id: "rId1", type: "slideMaster", target: "slideMasters/slideMaster1.xml" },
    { id: "rId2", type: "theme", target: "theme/theme1.xml" },
    { id: "rId3", type: "presProps", target: "presProps.xml" },
    { id: "rId4", type: "viewProps", target: "viewProps.xml" },
    { id: "rId5", type: "tableStyles", target: "tableStyles.xml" },
    { id: "rId6", type: "notesMaster", target: "notesMasters/notesMaster1.xml" },
    ...Array.from({ length: slideCount }, (_, i) => ({
      id: `rId${PRESENTATION_FIXED_RELS + 1 + i}`,
      type: "slide",
      target: `slides/slide${i + 1}.xml`,
    })),
  ];
}

export const GROUP_HEADER =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

function placeholder(id: number, name: string, ph: string, box: Box, anchor: string): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr>` +
    `<p:spPr>${xfrm(box)}</p:spPr>` +
    `<p:txBody><a:bodyPr anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`
  );
}

const MASTER_PLACEHOLDERS =
  placeholder(2, "Title Placeholder 1", '<p:ph type="title"/>', TITLE_BOX, "b") +
  placeholder(3, "Text Placeholder 2", '<p:ph type="body" idx="1"/>', BODY_BOX, "t");

const CLR_MAP =
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';

function runProps(size: number, color: string, font: string, bold = false): string {
  return `<a:defRPr sz="${size}"${bold ? ' b="1"' : ""}><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="${font}"/></a:defRPr>`;
}

const BODY_SIZES = [2400, 2000, 1800, 1600, 1600];

export function slideMasterXml(palette: PptxPalette): string {
  const font = escapeXml(palette.font);
  const bodyLevels = BODY_SIZES.map((size, level) => {
    const n = level + 1;
    const marL = 342_900 + level * 457_200;
    return (
      `<a:lvl${n}pPr marL="${marL}" indent="-342900" algn="l">` +
      '<a:spcBef><a:spcPts val="1000"/></a:spcBef>' +
      `<a:buClr><a:srgbClr val="${palette.accent}"/></a:buClr><a:buFont typeface="Arial"/><a:buChar char="${level === 0 ? "•" : "–"}"/>` +
      runProps(size, palette.text, font) +
      `</a:lvl${n}pPr>`
    );
  }).join("");
  return (
    XML_HEAD +
    `<p:sldMaster ${PML_NS}>` +
    `<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${palette.background}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>` +
    `<p:spTree>${GROUP_HEADER}${MASTER_PLACEHOLDERS}</p:spTree></p:cSld>` +
    CLR_MAP +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
    "<p:txStyles>" +
    `<p:titleStyle><a:lvl1pPr algn="l"><a:buNone/>${runProps(4000, palette.title, font, true)}</a:lvl1pPr></p:titleStyle>` +
    `<p:bodyStyle>${bodyLevels}</p:bodyStyle>` +
    `<p:otherStyle><a:lvl1pPr>${runProps(1800, palette.text, font)}</a:lvl1pPr></p:otherStyle>` +
    "</p:txStyles>" +
    "</p:sldMaster>"
  );
}

export function slideLayoutXml(): string {
  return (
    XML_HEAD +
    `<p:sldLayout ${PML_NS} type="obj" preserve="1">` +
    `<p:cSld name="Title and Content"><p:spTree>${GROUP_HEADER}${MASTER_PLACEHOLDERS}</p:spTree></p:cSld>` +
    "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>" +
    "</p:sldLayout>"
  );
}

export function notesMasterXml(): string {
  const image: Box = { x: 1_143_000, y: 685_800, cx: 4_572_000, cy: 2_571_750 };
  const body: Box = { x: 685_800, y: 3_429_000, cx: 5_486_400, cy: 4_114_800 };
  return (
    XML_HEAD +
    `<p:notesMaster ${PML_NS}>` +
    "<p:cSld><p:spTree>" +
    GROUP_HEADER +
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr>${xfrm(image)}</p:spPr></p:sp>` +
    placeholder(3, "Notes Placeholder 2", '<p:ph type="body" idx="1"/>', body, "t") +
    "</p:spTree></p:cSld>" +
    CLR_MAP +
    '<p:notesStyle><a:lvl1pPr><a:defRPr sz="1200"/></a:lvl1pPr></p:notesStyle>' +
    "</p:notesMaster>"
  );
}

export const PRES_PROPS_XML = `${XML_HEAD}<p:presentationPr ${PML_NS}/>`;
export const VIEW_PROPS_XML = `${XML_HEAD}<p:viewPr ${PML_NS}/>`;
export const TABLE_STYLES_XML = `${XML_HEAD}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`;

export function corePropsXml(title: string, author: string, now: Date): string {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  return (
    XML_HEAD +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${escapeXml(title)}</dc:title>` +
    `<dc:creator>${escapeXml(author)}</dc:creator>` +
    `<cp:lastModifiedBy>${escapeXml(author)}</cp:lastModifiedBy>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified>` +
    "</cp:coreProperties>"
  );
}

export function appPropsXml(slideCount: number, notesCount: number): string {
  return (
    XML_HEAD +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    "<Application>Atomic Agent</Application>" +
    "<PresentationFormat>Widescreen</PresentationFormat>" +
    `<Slides>${slideCount}</Slides><Notes>${notesCount}</Notes>` +
    "</Properties>"
  );
}
