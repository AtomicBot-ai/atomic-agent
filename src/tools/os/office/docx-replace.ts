import JSZip from "jszip";

import { mainDocumentPath } from "./docx-package.js";
import { decodeXmlText, escapeXmlText } from "./docx-xml.js";

/**
 * Find-and-replace inside a `.docx`, keeping the formatting.
 *
 * Word splits a sentence into runs wherever formatting, spell-check or
 * revision marks change, so "quarterly report" is often `quar` + `terly
 * report` in two `<w:t>` elements. Matching is done on the joined text of
 * each paragraph; the replacement lands in the run where the match
 * starts (so it takes that run's formatting) and the matched characters
 * are cut out of the following runs. A match never crosses a paragraph.
 * Body, headers, footers, footnotes and endnotes are all searched.
 */

export interface ReplaceOutcome {
  data: Buffer;
  count: number;
  parts: string[];
}

interface TextNode {
  /** Offsets of the whole `<w:t …>…</w:t>` element in the part. */
  start: number;
  end: number;
  attrs: string;
  text: string;
}

const TOKEN =
  /<w:p\b[^>]*\/>|<w:p\b[^>]*>|<\/w:p>|<w:t\b([^>]*)>([^<]*)<\/w:t>/g;

const EXTRA_PARTS = /^word\/(header|footer)\d*\.xml$|^word\/(footnotes|endnotes)\.xml$/;

export async function replaceInDocx(
  data: Buffer,
  find: string,
  replaceWith: string,
  options: { all: boolean },
): Promise<ReplaceOutcome> {
  if (find.length === 0) throw new Error("`find` must not be empty");
  const zip = await JSZip.loadAsync(data);
  const main = await mainDocumentPath(zip);
  const paths = [
    main,
    ...Object.keys(zip.files)
      .filter((name) => name !== main && EXTRA_PARTS.test(name))
      .sort(),
  ];
  let count = 0;
  const changed: string[] = [];
  for (const path of paths) {
    if (!options.all && count > 0) break;
    const xml = await zip.file(path)!.async("text");
    const result = replaceInPartXml(xml, find, replaceWith, options.all ? Infinity : 1 - count);
    if (result.count > 0) {
      zip.file(path, result.xml);
      count += result.count;
      changed.push(path);
    }
  }
  if (count === 0) return { data, count: 0, parts: [] };
  const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return { data: out, count, parts: changed };
}

/** Replace in one XML part, at most `limit` times. Exported for tests. */
export function replaceInPartXml(
  xml: string,
  find: string,
  replaceWith: string,
  limit: number,
): { xml: string; count: number } {
  const segments = collectSegments(xml);
  const edits: Array<{ node: TextNode; text: string }> = [];
  let count = 0;
  for (const nodes of segments) {
    if (count >= limit) break;
    const texts = nodes.map((node) => node.text);
    const joined = texts.join("");
    const starts: number[] = [];
    let offset = 0;
    for (const text of texts) {
      starts.push(offset);
      offset += text.length;
    }
    const matches: number[] = [];
    let from = 0;
    while (count + matches.length < limit) {
      const at = joined.indexOf(find, from);
      if (at < 0) break;
      matches.push(at);
      from = at + find.length;
    }
    if (matches.length === 0) continue;
    count += matches.length;
    // Right to left: an edit only touches text at or after its own start,
    // so the node offsets of the earlier matches stay valid.
    for (const at of matches.reverse()) {
      const end = at + find.length;
      const first = nodeAt(starts, at);
      const last = nodeAt(starts, end - 1);
      const head = texts[first]!.slice(0, at - starts[first]!);
      if (first === last) {
        texts[first] = head + replaceWith + texts[first]!.slice(end - starts[first]!);
        continue;
      }
      texts[first] = head + replaceWith;
      for (let i = first + 1; i < last; i += 1) texts[i] = "";
      texts[last] = texts[last]!.slice(end - starts[last]!);
    }
    nodes.forEach((node, i) => {
      if (texts[i] !== node.text) edits.push({ node, text: texts[i]! });
    });
  }
  let out = xml;
  edits.sort((a, b) => b.node.start - a.node.start);
  for (const { node, text } of edits) {
    out = out.slice(0, node.start) + textElement(node.attrs, text) + out.slice(node.end);
  }
  return { xml: out, count };
}

/** The `<w:t>` nodes of each paragraph (a nested paragraph is its own segment). */
function collectSegments(xml: string): TextNode[][] {
  const segments: TextNode[][] = [];
  let current: TextNode[] = [];
  const flush = (): void => {
    if (current.length > 0) segments.push(current);
    current = [];
  };
  for (const match of xml.matchAll(TOKEN)) {
    const token = match[0];
    if (!token.startsWith("<w:t")) {
      flush();
      continue;
    }
    const start = match.index ?? 0;
    current.push({
      start,
      end: start + token.length,
      attrs: match[1] ?? "",
      text: decodeXmlText(match[2] ?? ""),
    });
  }
  flush();
  return segments;
}

function nodeAt(starts: readonly number[], position: number): number {
  let index = 0;
  for (let i = 0; i < starts.length; i += 1) {
    if (starts[i]! <= position) index = i;
    else break;
  }
  return index;
}

/** Leading or trailing spaces vanish in Word without `xml:space="preserve"`. */
function textElement(attrs: string, text: string): string {
  const keep = /xml:space=/.test(attrs) ? attrs : `${attrs} xml:space="preserve"`;
  return `<w:t${keep}>${escapeXmlText(text)}</w:t>`;
}
