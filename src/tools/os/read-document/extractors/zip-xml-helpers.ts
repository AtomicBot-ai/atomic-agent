import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";

/**
 * Shared helpers for OOXML / OpenDocument containers (zip + XML inside).
 * Keeping a tiny XML parser wrapper + a recursive text walker here means
 * the per-format extractors (odt, pptx) stay focused on their own element
 * names and don't re-derive the Zip/XML boilerplate.
 */

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  preserveOrder: true,
  trimValues: false,
});

export type XmlNode = Record<string, unknown>;

export async function openZip(data: Buffer): Promise<JSZip> {
  return JSZip.loadAsync(data);
}

export async function readZipText(
  zip: JSZip,
  path: string,
): Promise<string | undefined> {
  const file = zip.file(path);
  if (!file) return undefined;
  return file.async("text");
}

export function parseXml(xml: string): XmlNode[] {
  return xmlParser.parse(xml) as XmlNode[];
}

/**
 * Recursively walk a fast-xml-parser preserved-order tree and collect all
 * text content under elements whose tag matches `isTextTag`. Paragraph-
 * level tags (`paragraphTags`) emit a newline after their text is
 * harvested so paragraph boundaries survive in the output.
 */
export function walkText(
  node: XmlNode[] | undefined,
  options: {
    isTextTag: (tag: string) => boolean;
    paragraphTags?: (tag: string) => boolean;
  },
  out: string[] = [],
): string[] {
  if (!node) return out;
  for (const item of node) {
    const tag = Object.keys(item).find((k) => k !== ":@");
    if (!tag) continue;
    const children = item[tag] as unknown;
    if (options.isTextTag(tag)) {
      // Leaf element containing text: children is a list like [{ "#text": "..." }].
      if (Array.isArray(children)) {
        for (const ch of children) {
          const text = (ch as { "#text"?: unknown })["#text"];
          if (typeof text === "string") out.push(text);
          else if (typeof text === "number") out.push(String(text));
        }
      }
      continue;
    }
    if (Array.isArray(children)) {
      walkText(children as XmlNode[], options, out);
    }
    if (options.paragraphTags?.(tag)) {
      out.push("\n");
    }
  }
  return out;
}

export function joinExtracted(parts: string[]): string {
  // Collapse consecutive newlines, trim lines, trim overall.
  const raw = parts.join("");
  return raw
    .replace(/[\t ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .trim();
}

/**
 * A second parser for formats where cell or paragraph text must survive
 * byte for byte. The default parser above has `parseTagValue` on, which
 * turns text like `007` into the number 7 and `1e5` into 100000; that is
 * harmless for prose but corrupts spreadsheet ids, zip codes and phone
 * numbers. ODS/ODP use this one.
 */
const rawXmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  preserveOrder: true,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
});

export function parseXmlRaw(xml: string): XmlNode[] {
  return rawXmlParser.parse(xml) as XmlNode[];
}

/** The tag name of a preserved-order node (its single non-`:@` key). */
export function nodeTag(item: XmlNode): string | undefined {
  return Object.keys(item).find((k) => k !== ":@");
}

export function nodeChildren(item: XmlNode, tag: string): XmlNode[] {
  const children = item[tag];
  return Array.isArray(children) ? (children as XmlNode[]) : [];
}

export function nodeAttr(item: XmlNode, name: string): string | undefined {
  const attrs = (item as { ":@"?: Record<string, unknown> })[":@"];
  const raw = attrs?.[`@_${name}`];
  if (typeof raw === "string") return raw;
  if (typeof raw === "number") return String(raw);
  return undefined;
}

/**
 * `text:c` is attacker-controlled: `<text:s text:c="400000000"/>` would
 * otherwise allocate hundreds of MB from a few bytes of XML. No real
 * document needs more than a handful of consecutive spaces.
 */
export const ODF_MAX_SPACE_RUN = 1000;
/**
 * Cap on the text of one inline element (one paragraph or cell). Far above
 * any real paragraph, small enough that a crafted file cannot blow up
 * memory before the dispatcher's own `maxBytes` cut applies.
 */
export const ODF_MAX_INLINE_CHARS = 100_000;

/**
 * Inline text of an OpenDocument paragraph-ish element. Handles the ODF
 * whitespace elements (`text:s` with its `text:c` count, `text:tab`,
 * `text:line-break`) and descends through spans, links and fields.
 * Annotations (comments) and change-tracking bodies are skipped: they are
 * not part of the visible text. Output is bounded by the two caps above.
 */
export function odfInlineText(nodes: XmlNode[]): string {
  const budget = { left: ODF_MAX_INLINE_CHARS };
  return collectOdfInline(nodes, budget);
}

function collectOdfInline(nodes: XmlNode[], budget: { left: number }): string {
  const parts: string[] = [];
  const push = (text: string): void => {
    if (budget.left <= 0 || text.length === 0) return;
    const piece = text.length > budget.left ? text.slice(0, budget.left) : text;
    budget.left -= piece.length;
    parts.push(piece);
  };
  for (const item of nodes) {
    if (budget.left <= 0) break;
    const tag = nodeTag(item);
    if (!tag) continue;
    if (tag === "#text") {
      const value = item[tag];
      if (typeof value === "string") push(value);
      else if (typeof value === "number") push(String(value));
      continue;
    }
    if (tag === "text:s") {
      const raw = parseInt(nodeAttr(item, "text:c") ?? "1", 10);
      const count = Number.isFinite(raw) && raw > 0 ? Math.min(raw, ODF_MAX_SPACE_RUN) : 1;
      push(" ".repeat(Math.min(count, Math.max(0, budget.left))));
      continue;
    }
    if (tag === "text:tab") {
      push("\t");
      continue;
    }
    if (tag === "text:line-break") {
      push("\n");
      continue;
    }
    if (tag === "office:annotation" || tag === "text:tracked-changes") continue;
    // Children draw from the same budget, so nesting cannot multiply it.
    parts.push(collectOdfInline(nodeChildren(item, tag), budget));
  }
  return parts.join("");
}
