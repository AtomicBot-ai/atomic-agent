import JSZip from "jszip";

import { packZip } from "../ooxml/ooxml-package.js";
import { maxAttr, type Revision } from "./docx-blocks.js";
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
  options: { all: boolean; revision?: Revision },
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
  const revision = options.revision;
  if (revision !== undefined) {
    // Revision ids are unique across the document's parts: start past all of them.
    for (const path of paths) {
      const xml = await zip.file(path)!.async("text");
      revision.nextId = Math.max(revision.nextId, maxAttr(xml, /\bw:id="(\d+)"/g) + 1);
    }
  }
  for (const path of paths) {
    if (!options.all && count > 0) break;
    const xml = await zip.file(path)!.async("text");
    const limit = options.all ? Infinity : 1 - count;
    const result =
      revision === undefined
        ? replaceInPartXml(xml, find, replaceWith, limit)
        : trackedReplaceInPartXml(xml, find, replaceWith, limit, revision);
    if (result.count > 0) {
      zip.file(path, result.xml);
      count += result.count;
      changed.push(path);
    }
  }
  if (count === 0) return { data, count: 0, parts: [] };
  const out = await packZip(zip);
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

/** Where each match cuts a text node: `[from, to)` of its text, and what goes in at `from`. */
interface Cut {
  from: number;
  to: number;
  insert: string;
}

/** The matches of one paragraph, as cuts per text node (index into `nodes`). */
function matchCuts(
  nodes: readonly TextNode[],
  find: string,
  replaceWith: string,
  limit: number,
): { cuts: Map<number, Cut[]>; found: number } {
  const texts = nodes.map((node) => node.text);
  const joined = texts.join("");
  const starts: number[] = [];
  let offset = 0;
  for (const text of texts) {
    starts.push(offset);
    offset += text.length;
  }
  const cuts = new Map<number, Cut[]>();
  const add = (index: number, cut: Cut) => {
    const list = cuts.get(index) ?? [];
    list.push(cut);
    cuts.set(index, list);
  };
  let from = 0;
  let found = 0;
  while (found < limit) {
    const at = joined.indexOf(find, from);
    if (at < 0) break;
    found += 1;
    const end = at + find.length;
    const first = nodeAt(starts, at);
    const last = nodeAt(starts, end - 1);
    for (let i = first; i <= last; i += 1) {
      const start = starts[i]!;
      add(i, {
        from: Math.max(at, start) - start,
        to: Math.min(end, start + texts[i]!.length) - start,
        insert: i === first ? replaceWith : "",
      });
    }
    from = end;
  }
  return { cuts, found };
}

/**
 * The same matching as {@link replaceInPartXml}, written as tracked
 * changes: the matched text becomes a `w:del` (its runs keep their
 * formatting, text in `w:delText`), the replacement a `w:ins` run with
 * the formatting of the run the match starts in, so Word shows the edit
 * in Track Changes for the author to accept or reject. Exported for tests.
 */
export function trackedReplaceInPartXml(
  xml: string,
  find: string,
  replaceWith: string,
  limit: number,
  revision: Revision,
): { xml: string; count: number } {
  let count = 0;
  /** Per run (by its start offset): its bounds and the cuts of its text nodes. */
  const runs = new Map<number, { start: number; end: number; nodes: Map<TextNode, Cut[]> }>();
  for (const nodes of collectSegments(xml)) {
    if (count >= limit) break;
    const { cuts, found } = matchCuts(nodes, find, replaceWith, limit - count);
    if (found === 0) continue;
    count += found;
    for (const [index, list] of cuts) {
      const node = nodes[index]!;
      const run = enclosingRun(xml, node);
      if (run === null) throw new Error("a matched text is not inside a run; cannot track the change");
      const entry = runs.get(run.start) ?? { ...run, nodes: new Map<TextNode, Cut[]>() };
      entry.nodes.set(node, list);
      runs.set(run.start, entry);
    }
  }
  let out = xml;
  for (const run of [...runs.values()].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, run.start) + splitRun(xml.slice(run.start, run.end), run.start, run.nodes, revision) + out.slice(run.end);
  }
  return { xml: out, count };
}

function enclosingRun(xml: string, node: TextNode): { start: number; end: number } | null {
  const open = Math.max(xml.lastIndexOf("<w:r>", node.start), xml.lastIndexOf("<w:r ", node.start));
  const close = xml.indexOf("</w:r>", node.end);
  if (open < 0 || close < 0) return null;
  // A closing tag between the opening and the text means the text is not in that run.
  if (xml.lastIndexOf("</w:r>", node.start) > open) return null;
  return { start: open, end: close + "</w:r>".length };
}

/**
 * Rewrite one run with its cuts: the kept text stays in runs with the
 * original properties, each cut becomes a deleted run plus, where the
 * match starts, an inserted one.
 */
function splitRun(
  runXml: string,
  runStart: number,
  nodes: Map<TextNode, Cut[]>,
  revision: Revision,
): string {
  const openEnd = runXml.indexOf(">") + 1;
  const openTag = runXml.slice(0, openEnd);
  const inner = runXml.slice(openEnd, runXml.length - "</w:r>".length);
  const rPr = /^<w:rPr\b[^>]*\/>|^<w:rPr\b[\s\S]*?<\/w:rPr>/.exec(inner)?.[0] ?? "";
  const content = inner.slice(rPr.length);
  const contentStart = runStart + openEnd + rPr.length;
  const attrs = () => {
    const id = revision.nextId;
    revision.nextId += 1;
    const date = revision.date.toISOString().replace(/\.\d{3}Z$/, "Z");
    return `w:id="${id}" w:author="${escapeXmlText(revision.author)}" w:date="${date}"`;
  };
  const pieces: string[] = [];
  let kept = "";
  const flush = () => {
    if (kept.length > 0) pieces.push(`${openTag}${rPr}${kept}</w:r>`);
    kept = "";
  };
  let cursor = 0;
  const ordered = [...nodes.entries()].sort((a, b) => a[0].start - b[0].start);
  for (const [node, cuts] of ordered) {
    const nodeStart = node.start - contentStart;
    kept += content.slice(cursor, nodeStart);
    cursor = node.end - contentStart;
    let at = 0;
    for (const cut of [...cuts].sort((a, b) => a.from - b.from)) {
      if (cut.from > at) kept += textElement(node.attrs, node.text.slice(at, cut.from));
      flush();
      const removed = node.text.slice(cut.from, cut.to);
      if (removed.length > 0) {
        pieces.push(
          `<w:del ${attrs()}>${openTag}${rPr}<w:delText xml:space="preserve">${escapeXmlText(removed)}</w:delText></w:r></w:del>`,
        );
      }
      if (cut.insert.length > 0) {
        pieces.push(`<w:ins ${attrs()}>${openTag}${rPr}${textElement("", cut.insert)}</w:r></w:ins>`);
      }
      at = cut.to;
    }
    if (at < node.text.length) kept += textElement(node.attrs, node.text.slice(at));
  }
  kept += content.slice(cursor);
  flush();
  return pieces.join("");
}
