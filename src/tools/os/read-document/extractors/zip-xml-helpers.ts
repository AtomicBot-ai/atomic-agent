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
