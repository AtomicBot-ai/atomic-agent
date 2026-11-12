import { posix } from "node:path";

import type { Extractor } from "./extractor-types.js";
import { htmlToMarkdown } from "./html-markdown.js";
import { decodeBytes, sniffHtmlCharset } from "./text-decode.js";
import {
  nodeAttr,
  nodeChildren,
  nodeTag,
  openZip,
  parseXmlRaw,
  readZipText,
  type XmlNode,
} from "./zip-xml-helpers.js";

/**
 * EPUB extractor (EPUB 2 and 3). An EPUB is a Zip:
 *
 *   META-INF/container.xml  → points at the package file (OPF)
 *   <opf>                   → metadata, manifest (id → href) and spine
 *                             (reading order, a list of manifest ids)
 *   spine items             → XHTML chapters
 *
 * Chapters are read in spine order and rendered with the shared HTML →
 * markdown converter. Each spine item counts as one "page" for
 * `pagesFrom` / `pagesTo` / `maxPages`, with `--- chapter N ---`
 * separators, so a long book can be read in slices like a long PDF.
 *
 * DRM-protected books (an `META-INF/encryption.xml` listing the chapters)
 * cannot be decrypted; we say so instead of returning garbage silently.
 */
export const epubExtractor: Extractor = async (input) => {
  const warnings: string[] = [];
  const zip = await openZip(input.data);

  const opfPath = await findPackagePath(zip);
  if (!opfPath) {
    return { format: "epub", text: "", pageCount: 0, warnings: ["no OPF package file found (not an EPUB?)"] };
  }
  const opfXml = await readZipText(zip, opfPath);
  if (!opfXml) {
    return { format: "epub", text: "", pageCount: 0, warnings: [`package file ${opfPath} missing`] };
  }
  const pkg = parsePackage(parseXmlRaw(opfXml), posix.dirname(opfPath));
  if (zip.file("META-INF/encryption.xml")) {
    warnings.push("book has META-INF/encryption.xml: DRM-protected chapters cannot be read");
  }
  if (pkg.spine.length === 0) {
    return { format: "epub", text: "", pageCount: 0, warnings: [...warnings, "spine is empty"] };
  }

  const total = pkg.spine.length;
  const start = Math.max(1, input.pagesFrom ?? 1);
  const end = Math.min(total, input.pagesTo ?? total);
  const maxPages = input.maxPages ?? total;
  const separators = input.pageSeparators !== false;

  const chunks: string[] = [];
  const extracted: number[] = [];
  const head: string[] = [];
  if (start === 1) {
    if (pkg.title) head.push(`# ${pkg.title}`);
    if (pkg.creators.length > 0) head.push(`by ${pkg.creators.join(", ")}`);
  }

  let next = start;
  for (let n = start; n <= end; n++) {
    if (extracted.length >= maxPages) break;
    next = n + 1;
    const href = pkg.spine[n - 1]!;
    const file = zip.file(href);
    if (!file) {
      warnings.push(`chapter ${n}: ${href} missing from the archive`);
      continue;
    }
    try {
      const bytes = await file.async("uint8array");
      const decoded = decodeBytes(bytes, sniffHtmlCharset(bytes));
      if (decoded.warning) warnings.push(`chapter ${n}: ${decoded.warning}`);
      const { text } = htmlToMarkdown(decoded.text);
      if (separators) chunks.push(`--- chapter ${n} ---\n${text}`);
      else if (text.length > 0) chunks.push(text);
      extracted.push(n);
    } catch (err) {
      warnings.push(`chapter ${n}: failed to parse (${(err as Error).message})`);
    }
  }
  const remaining = end - next + 1;
  if (remaining > 0) {
    warnings.push(
      `stopped at maxPages=${maxPages}; ${remaining} more chapter(s) not read (use pagesFrom)`,
    );
  }

  return {
    format: "epub",
    text: [head.join("\n"), ...chunks].filter((c) => c.length > 0).join("\n\n").trim(),
    pageCount: total,
    pagesExtracted: extracted,
    warnings,
  };
};

async function findPackagePath(
  zip: Awaited<ReturnType<typeof openZip>>,
): Promise<string | undefined> {
  const container = await readZipText(zip, "META-INF/container.xml");
  if (container) {
    const rootfiles: XmlNode[] = [];
    findAll(parseXmlRaw(container), "rootfile", rootfiles);
    for (const rf of rootfiles) {
      const fullPath = nodeAttr(rf, "full-path");
      const mediaType = nodeAttr(rf, "media-type");
      if (fullPath && (!mediaType || mediaType === "application/oebps-package+xml")) {
        return fullPath;
      }
    }
  }
  // Broken container.xml: fall back to the first .opf in the archive.
  let found: string | undefined;
  zip.forEach((path) => {
    if (!found && path.toLowerCase().endsWith(".opf")) found = path;
  });
  return found;
}

interface EpubPackage {
  title?: string;
  creators: string[];
  /** Zip paths of the spine items, in reading order. */
  spine: string[];
}

function parsePackage(tree: XmlNode[], baseDir: string): EpubPackage {
  const manifest = new Map<string, { href: string; mediaType?: string }>();
  const items: XmlNode[] = [];
  findAll(tree, "item", items);
  for (const item of items) {
    const id = nodeAttr(item, "id");
    const href = nodeAttr(item, "href");
    if (id && href) manifest.set(id, { href, mediaType: nodeAttr(item, "media-type") });
  }

  const spine: string[] = [];
  const refs: XmlNode[] = [];
  findAll(tree, "itemref", refs);
  for (const ref of refs) {
    const entry = manifest.get(nodeAttr(ref, "idref") ?? "");
    if (!entry) continue;
    if (entry.mediaType && !/html|xml/i.test(entry.mediaType)) continue;
    spine.push(resolveHref(baseDir, entry.href));
  }

  const titles: XmlNode[] = [];
  findAll(tree, "title", titles);
  const creators: XmlNode[] = [];
  findAll(tree, "creator", creators);
  return {
    title: titles.map(textOf).find((t) => t.length > 0),
    creators: creators.map(textOf).filter((t) => t.length > 0),
    spine,
  };
}

function resolveHref(baseDir: string, href: string): string {
  const clean = href.split("#")[0] ?? href;
  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    // Keep the raw href if it is not valid percent-encoding.
  }
  const joined = baseDir === "." ? decoded : posix.join(baseDir, decoded);
  return posix.normalize(joined).replace(/^\.\//, "");
}

/** Collect elements by local name, ignoring the namespace prefix (`opf:item`, `dc:title`). */
function findAll(nodes: XmlNode[], localName: string, out: XmlNode[]): void {
  for (const item of nodes) {
    const tag = nodeTag(item);
    if (!tag || tag === "#text") continue;
    const local = tag.includes(":") ? tag.slice(tag.indexOf(":") + 1) : tag;
    if (local === localName) out.push(item);
    findAll(nodeChildren(item, tag), localName, out);
  }
}

function textOf(item: XmlNode): string {
  const tag = nodeTag(item);
  if (!tag) return "";
  const parts: string[] = [];
  for (const child of nodeChildren(item, tag)) {
    const childTag = nodeTag(child);
    if (childTag === "#text") parts.push(String(child[childTag]));
    else if (childTag) parts.push(textOf(child));
  }
  return parts.join("").trim();
}
