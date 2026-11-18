import JSZip from "jszip";

/**
 * The zip-and-XML plumbing every Office writer shares (`os.fs.write_pptx`,
 * `os.fs.docx`, `os.fs.xlsx`): escaping, relationship parts, content
 * types, and adding a part to a package someone else wrote without
 * clobbering what is there. An Office file is an OPC package (ECMA-376
 * part 2): a zip whose `[Content_Types].xml` types every part and whose
 * `_rels/*.rels` parts wire them together.
 *
 * Built on JSZip, which the document readers already ship: no new
 * dependency, no Python. Shaped after python-pptx / python-docx's
 * `opc` package (part names, `_rels` paths, next free `rId`).
 */

export const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
export const NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
export const NS_CONTENT_TYPES = "http://schemas.openxmlformats.org/package/2006/content-types";
/** Base of the officeDocument relationship types (`.../relationships/chart`, …). */
export const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/**
 * Escape text for an XML element or attribute, dropping the control
 * characters XML 1.0 forbids (a stray \u0007 from a scraped page would
 * otherwise make the Office app refuse the whole file as corrupt).
 */
export function escapeXml(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export interface Relationship {
  id: string;
  /** A short officeDocument name (`chart`, `image`) or a full type URI. */
  type: string;
  target: string;
  /** `External` for a hyperlink; omitted for a part inside the package. */
  targetMode?: "External";
}

function relType(type: string): string {
  return type.startsWith("http") ? type : `${REL}/${type}`;
}

function relationshipXml(rel: Relationship): string {
  const mode = rel.targetMode === undefined ? "" : ` TargetMode="${rel.targetMode}"`;
  return `<Relationship Id="${escapeXml(rel.id)}" Type="${relType(rel.type)}" Target="${escapeXml(rel.target)}"${mode}/>`;
}

/** A whole `.rels` part. */
export function relationshipsXml(rels: readonly Relationship[]): string {
  return XML_HEAD + `<Relationships xmlns="${NS_PKG_REL}">` + rels.map(relationshipXml).join("") + "</Relationships>";
}

/** `ppt/slides/slide1.xml` → `ppt/slides/_rels/slide1.xml.rels`. */
export function relsPathOf(partPath: string): string {
  const slash = partPath.lastIndexOf("/");
  const dir = slash < 0 ? "" : partPath.slice(0, slash + 1);
  return `${dir}_rels/${partPath.slice(slash + 1)}.rels`;
}

/** Resolve a relationship target against the part that owns it: `../charts/chart1.xml` from `ppt/slides/slide1.xml`. */
export function resolveTarget(partPath: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = partPath.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== "." && segment !== "") parts.push(segment);
  }
  return parts.join("/");
}

/** The opposite of {@link resolveTarget}: the target `to` is written as from `from`'s rels. */
export function relativeTarget(from: string, to: string): string {
  const a = from.split("/").slice(0, -1);
  const b = to.split("/");
  let common = 0;
  while (common < a.length && common < b.length - 1 && a[common] === b[common]) common += 1;
  return [...Array(a.length - common).fill(".."), ...b.slice(common)].join("/");
}

/** Text of a part, or undefined when the package has none by that name. */
export async function readPart(zip: JSZip, path: string): Promise<string | undefined> {
  return zip.file(path)?.async("text");
}

/** First `n` from 1 up for which `name(n)` is not a part yet: `xl/charts/chart3.xml`. */
export function nextFreePartName(zip: JSZip, name: (n: number) => string): string {
  for (let n = 1; ; n += 1) {
    const candidate = name(n);
    if (zip.file(candidate) === null) return candidate;
  }
}

/**
 * Add a relationship to `partPath`'s rels part (created when missing)
 * and return its id. An identical relationship already there is reused,
 * so calling it twice does not wire a part twice. The id is the first
 * free `rIdN`, as Office and python-pptx pick it.
 */
export async function addRelationship(
  zip: JSZip,
  partPath: string,
  type: string,
  target: string,
): Promise<string> {
  const relsPath = relsPathOf(partPath);
  const existing = await readPart(zip, relsPath);
  const full = relType(type);
  if (existing === undefined) {
    zip.file(relsPath, relationshipsXml([{ id: "rId1", type: full, target }]));
    return "rId1";
  }
  const ids = new Set<string>();
  for (const match of existing.matchAll(/<Relationship\b[^>]*>/g)) {
    const tag = match[0];
    const id = /\bId="([^"]+)"/.exec(tag)?.[1];
    if (id !== undefined) ids.add(id);
    if (tag.includes(`Type="${full}"`) && tag.includes(`Target="${escapeXml(target)}"`) && id !== undefined) {
      return id;
    }
  }
  let n = 1;
  while (ids.has(`rId${n}`)) n += 1;
  const id = `rId${n}`;
  const end = existing.lastIndexOf("</Relationships>");
  const rel = relationshipXml({ id, type: full, target });
  zip.file(
    relsPath,
    end < 0
      ? relationshipsXml([{ id, type: full, target }])
      : existing.slice(0, end) + rel + existing.slice(end),
  );
  return id;
}

async function editContentTypes(zip: JSZip, has: (types: string) => boolean, entry: string): Promise<void> {
  const types = await readPart(zip, "[Content_Types].xml");
  if (types === undefined) {
    zip.file("[Content_Types].xml", `${XML_HEAD}<Types xmlns="${NS_CONTENT_TYPES}">${entry}</Types>`);
    return;
  }
  if (has(types)) return;
  const end = types.lastIndexOf("</Types>");
  if (end < 0) throw new Error("not an Office package: [Content_Types].xml has no </Types>");
  zip.file("[Content_Types].xml", types.slice(0, end) + entry + types.slice(end));
}

/** Type one part by name (`/xl/charts/chart1.xml`). A part already typed is left as it is. */
export async function addOverride(zip: JSZip, partPath: string, contentType: string): Promise<void> {
  const name = `/${partPath.replace(/^\//, "")}`;
  await editContentTypes(
    zip,
    (types) => types.includes(`PartName="${name}"`),
    `<Override PartName="${escapeXml(name)}" ContentType="${contentType}"/>`,
  );
}

/** Type every part with an extension (`png`, `xlsx`). An extension already typed is left as it is. */
export async function addDefault(zip: JSZip, extension: string, contentType: string): Promise<void> {
  const ext = extension.replace(/^\./, "").toLowerCase();
  await editContentTypes(
    zip,
    (types) => new RegExp(`<Default\\b[^>]*Extension="${ext}"`, "i").test(types),
    `<Default Extension="${ext}" ContentType="${contentType}"/>`,
  );
}

/** Zip the package the way every writer here does: DEFLATE, level 6. */
export async function packZip(zip: JSZip): Promise<Buffer> {
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

/** Common content types. */
export const CT = {
  rels: "application/vnd.openxmlformats-package.relationships+xml",
  xml: "application/xml",
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  chart: "application/vnd.openxmlformats-officedocument.drawingml.chart+xml",
  drawing: "application/vnd.openxmlformats-officedocument.drawing+xml",
  xlsxPackage: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
} as const;
