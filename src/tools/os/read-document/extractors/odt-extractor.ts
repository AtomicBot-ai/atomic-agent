import type { Extractor } from "./extractor-types.js";
import {
  joinExtracted,
  openZip,
  parseXml,
  readZipText,
  walkText,
} from "./zip-xml-helpers.js";

/**
 * ODT extractor: an ODT file is a Zip container with `content.xml` holding
 * the body text. We pull paragraphs (`text:p`) and headings (`text:h`);
 * headings emit a `#`/`##` prefix based on their outline level to keep
 * some structure for local LLMs.
 */
export const odtExtractor: Extractor = async (input) => {
  const warnings: string[] = [];
  const zip = await openZip(input.data);
  const contentXml = await readZipText(zip, "content.xml");
  if (!contentXml) {
    return { format: "odt", text: "", warnings: ["content.xml missing"] };
  }
  const tree = parseXml(contentXml);
  const parts = renderOdt(tree, warnings);
  return {
    format: "odt",
    text: joinExtracted(parts),
    warnings,
  };
};

function renderOdt(
  tree: ReturnType<typeof parseXml>,
  _warnings: string[],
): string[] {
  const out: string[] = [];
  visit(tree, out);
  return out;
}

function visit(nodes: ReturnType<typeof parseXml>, out: string[]): void {
  for (const item of nodes) {
    const tag = Object.keys(item).find((k) => k !== ":@");
    if (!tag) continue;
    const children = item[tag] as unknown;
    const attrs = (item as { ":@"?: Record<string, unknown> })[":@"];

    if (tag === "text:h") {
      const level = parseOutlineLevel(attrs);
      const inline: string[] = [];
      walkText(children as ReturnType<typeof parseXml>, {
        isTextTag: () => false,
        paragraphTags: () => false,
      }, inline);
      // Harvest plain text too (headings contain spans).
      const text = collectInlineText(children as ReturnType<typeof parseXml>);
      if (text.trim().length > 0) {
        const prefix = "#".repeat(Math.min(level, 6));
        out.push(`${prefix} ${text.trim()}\n\n`);
      }
      continue;
    }
    if (tag === "text:p") {
      const text = collectInlineText(children as ReturnType<typeof parseXml>);
      if (text.trim().length > 0) out.push(`${text.trim()}\n\n`);
      continue;
    }
    if (Array.isArray(children)) {
      visit(children as ReturnType<typeof parseXml>, out);
    }
  }
}

function collectInlineText(
  nodes: ReturnType<typeof parseXml> | undefined,
): string {
  if (!nodes) return "";
  const parts: string[] = [];
  for (const item of nodes) {
    const tag = Object.keys(item).find((k) => k !== ":@");
    if (!tag) continue;
    const children = item[tag] as unknown;
    if (tag === "#text") {
      if (typeof children === "string") parts.push(children);
      else if (typeof children === "number") parts.push(String(children));
      continue;
    }
    if (Array.isArray(children)) {
      parts.push(collectInlineText(children as ReturnType<typeof parseXml>));
    }
  }
  return parts.join("");
}

function parseOutlineLevel(attrs: Record<string, unknown> | undefined): number {
  if (!attrs) return 1;
  const raw = attrs["@_text:outline-level"];
  if (typeof raw === "string") {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 1;
}
