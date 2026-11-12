/**
 * Deterministic clean-up of the final reply text before any surface
 * shows it (ATO-967). No model call: a fixed set of conservative,
 * line-based passes that fix the shapes small local models leave
 * behind and that a cloud model rarely produces at all.
 *
 * What it does, outside code only (fenced blocks and `inline code` are
 * never rewritten; a whole paragraph may still be dropped):
 *   - closes an unclosed ``` fence at the end, and open `**`, `~~` or
 *     backtick markup in the last block (`closeStreamingMarkdown`);
 *   - drops a known filler opener ("As an AI language model, ...",
 *     "Great question!", "Как ИИ, ...") and a closing pleasantry
 *     ("I hope this helps!", "Надеюсь, это поможет!"), at the very start
 *     or end only, and only when something else is left;
 *   - drops a first paragraph that only repeats the user's question;
 *   - small models only: drops a paragraph that repeats the one right
 *     before it (exactly or up to whitespace), and a reply whose second
 *     half repeats its first; a cloud model repeats only when asked to;
 *   - small models only: a line repeated three or more times in a row is
 *     kept once (a decoding loop, not content);
 *   - collapses runs of blank lines to one;
 *   - shortens a long absolute path under the home folder to `~/...`
 *     when it is plain prose (not code, not a link target), unless the
 *     user's message asks for the full or absolute path;
 *   - Telegram only: turns a markdown table into a list, since the chat
 *     has no tables and a pipe grid wraps into noise on a phone.
 *
 * Safety: pure, never throws (any error returns the input unchanged),
 * and never returns an empty string for a non-empty input.
 */

import { homedir } from "node:os";

import type { AnswerChannel } from "../prompt/answer-style.js";
import { closeStreamingMarkdown } from "./close-streaming-markdown.js";

export type ReplyChannel = "tui" | "desktop" | "telegram";

/**
 * The polish channel for a turn's `answerChannel` (ATO-966), the one
 * field that names the surface a person reads the reply on. Discord has
 * no tables either, so it gets Telegram's pass. Absent: no polish.
 */
export function replyChannelForAnswer(channel: AnswerChannel | undefined): ReplyChannel | undefined {
  switch (channel) {
    case "terminal":
      return "tui";
    case "desktop":
      return "desktop";
    case "telegram":
    case "discord":
      return "telegram";
    default:
      return undefined;
  }
}

export interface PolishReplyOptions {
  channel: ReplyChannel;
  /** Served by a local model: also apply the passes only small models need. */
  smallModel?: boolean;
  /** The user's message this reply answers, to spot an echoed question. */
  userMessage?: string | null;
  /** Home folder for the `~/` path shortening; defaults to `os.homedir()`. */
  homeDir?: string;
}

export function polishReply(text: string, options: PolishReplyOptions): string {
  if (typeof text !== "string" || text.trim().length === 0) return text;
  try {
    const out = polish(text, options);
    return out.trim().length === 0 ? text : out;
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// Segmentation: fenced code vs prose
// ---------------------------------------------------------------------------

interface Segment {
  kind: "code" | "prose";
  text: string;
}

// Any indent: a fence nested under a list item (`1. ` then a deeper
// bullet) sits four or more spaces in, and is still code.
const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})/;

/**
 * Split into prose and fenced-code segments, line by line. An unclosed
 * fence at the end is closed with its own marker, so the rest of the
 * reply renders as the code block it was meant to be.
 */
export function splitFences(text: string): Segment[] {
  const lines = text.split("\n");
  const segments: Segment[] = [];
  let prose: string[] = [];
  let i = 0;
  const flushProse = () => {
    if (prose.length > 0) segments.push({ kind: "prose", text: prose.join("\n") });
    prose = [];
  };
  while (i < lines.length) {
    const line = lines[i]!;
    const open = FENCE_OPEN.exec(line);
    if (open === null) {
      prose.push(line);
      i += 1;
      continue;
    }
    const marker = open[1]!;
    const ch = marker[0]!;
    const close = new RegExp(`^[ \\t]*${ch === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
    const body: string[] = [line];
    let j = i + 1;
    let closed = false;
    while (j < lines.length) {
      body.push(lines[j]!);
      if (close.test(lines[j]!)) {
        closed = true;
        break;
      }
      j += 1;
    }
    if (!closed) {
      while (body.length > 1 && body[body.length - 1]!.trim().length === 0) body.pop();
      body.push(marker);
    }
    flushProse();
    segments.push({ kind: "code", text: body.join("\n") });
    i = j + 1;
  }
  flushProse();
  return segments;
}

// ---------------------------------------------------------------------------
// Inline code protection
// ---------------------------------------------------------------------------

/** Apply `fn` to the parts of `line` outside `code spans`. */
function outsideInlineCode(line: string, fn: (part: string) => string): string {
  let out = "";
  let i = 0;
  let plainStart = 0;
  while (i < line.length) {
    if (line[i] === "\\") {
      i += 2;
      continue;
    }
    if (line[i] === "`") {
      let run = 0;
      while (line[i + run] === "`") run += 1;
      const marker = "`".repeat(run);
      const close = line.indexOf(marker, i + run);
      if (close === -1) {
        i += run;
        continue;
      }
      out += fn(line.slice(plainStart, i)) + line.slice(i, close + run);
      i = close + run;
      plainStart = i;
      continue;
    }
    i += 1;
  }
  return out + fn(line.slice(plainStart));
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

function polish(input: string, options: PolishReplyOptions): string {
  const text = input.replace(/\r\n?/g, "\n");
  let segments = splitFences(text);

  segments = segments.map((seg) => {
    if (seg.kind === "code") return seg;
    let body = seg.text;
    if (options.smallModel === true) body = collapseRepeatedLines(body);
    if (options.channel === "telegram") body = tablesToLists(body);
    if (!asksForFullPath(options.userMessage)) body = shortenHomePaths(body, options.homeDir ?? safeHomedir());
    body = collapseBlankLines(body);
    return { kind: "prose", text: body };
  });

  if (options.userMessage) segments = dropEchoedQuestion(segments, options.userMessage);
  segments = dropFillerAtEdges(segments);
  if (options.smallModel === true) segments = dropRepeatedParagraphs(segments);

  let out = segments
    .map((s) => s.text)
    .join("\n")
    .replace(/^\s*\n/, "")
    .trimEnd();
  out = collapseBlankLines(out, true);
  const last = segments.filter((s) => s.text.trim().length > 0).at(-1);
  if (last?.kind === "prose") out = closeOpenMarkup(out);
  return out;
}

function safeHomedir(): string {
  try {
    return homedir();
  } catch {
    return "";
  }
}

// --- blank lines -----------------------------------------------------------

/**
 * Two or more blank lines become one: markdown renders them the same,
 * and the terminal would otherwise print every one. With `outerOnly`,
 * only the joins between segments are touched (code keeps its own).
 */
function collapseBlankLines(text: string, outerOnly = false): string {
  if (!outerOnly) return text.replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, "\n\n");
  return splitFences(text)
    .map((s) => (s.kind === "code" ? s.text : s.text.replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, "\n\n")))
    .join("\n");
}

// --- open markup -----------------------------------------------------------

/**
 * Close what the last block left open. `closeStreamingMarkdown` was
 * written for a growing reply, so on a final one its result is kept only
 * when it is plainly a fix: closers appended (`**`, `~~`, backticks, never
 * a lone `*`, which is as likely a glob as emphasis), or a dangling opener
 * with nothing after it dropped. A rewritten half-link is not taken.
 */
function closeOpenMarkup(text: string): string {
  const fixed = closeStreamingMarkdown(text);
  if (fixed === text) return text;
  const base = text.trimEnd();
  if (fixed.startsWith(base)) {
    const suffix = fixed.slice(base.length);
    if (!/^(?:`+|\*\*|~~)+$/.test(suffix)) return text;
    // `x**2` or `a~~b`: a marker inside a word is maths or a name, not
    // an opener, so closing it would add stray stars.
    for (const marker of ["**", "~~"]) {
      if (suffix.includes(marker) && openerInsideWord(base, marker)) return text;
    }
    return fixed;
  }
  const kept = fixed.trimEnd();
  if (kept.length > 0 && base.startsWith(kept)) {
    // Only a spaced-off opener ("Done **"). `src/**` and `: *` end in a
    // glob, which is content and stays.
    const removed = base.slice(kept.length);
    return /^\s+(?:\*\*|~~|`+)+$/.test(removed) ? kept : text;
  }
  return text;
}

/** The last `marker` in `text` sits between two word characters. */
function openerInsideWord(text: string, marker: string): boolean {
  const at = text.lastIndexOf(marker);
  if (at <= 0) return false;
  return /[\p{L}\p{N}_]/u.test(text[at - 1]!);
}

// --- paragraphs ------------------------------------------------------------

function paragraphsOf(text: string): string[] {
  return text.split(/\n[ \t]*\n/);
}

function normalizeWs(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * A paragraph equal (up to whitespace) to the one right before it is
 * dropped, and so is a second half that repeats the first: small models
 * often restate the whole answer. Code segments split prose runs, so a
 * paragraph is compared only with its prose neighbour.
 */
function dropRepeatedParagraphs(segments: Segment[]): Segment[] {
  const deduped = segments.map((seg) => {
    if (seg.kind === "code") return seg;
    const paras = paragraphsOf(seg.text);
    const kept: string[] = [];
    for (const p of paras) {
      const prev = kept[kept.length - 1];
      if (prev !== undefined && normalizeWs(p).length > 0 && normalizeWs(p) === normalizeWs(prev)) continue;
      kept.push(p);
    }
    return { kind: "prose" as const, text: dropRepeatedHalf(kept).join("\n\n") };
  });
  // The whole reply repeated around a code block: [A, code, A, code].
  const keys = deduped.map((s) => `${s.kind}:${normalizeWs(s.text)}`);
  const n = keys.length;
  if (n >= 2 && n % 2 === 0) {
    const half = n / 2;
    let same = true;
    for (let i = 0; i < half; i += 1) {
      if (keys[i] !== keys[i + half]) {
        same = false;
        break;
      }
    }
    if (same && deduped.slice(0, half).some((s) => s.kind === "prose" && normalizeWs(s.text).length > 0)) {
      return deduped.slice(0, half);
    }
  }
  return deduped;
}

function dropRepeatedHalf(paras: string[]): string[] {
  const nonEmpty = paras.filter((p) => normalizeWs(p).length > 0);
  if (nonEmpty.length < 4 || nonEmpty.length % 2 !== 0) return paras;
  const half = nonEmpty.length / 2;
  for (let i = 0; i < half; i += 1) {
    if (normalizeWs(nonEmpty[i]!) !== normalizeWs(nonEmpty[i + half]!)) return paras;
  }
  return nonEmpty.slice(0, half);
}

// --- repeated lines (small models) -----------------------------------------

/** Three or more identical non-blank lines in a row are kept once. */
function collapseRepeatedLines(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    let j = i + 1;
    while (j < lines.length && lines[j] === line) j += 1;
    const run = j - i;
    if (run >= 3 && line.trim().length > 0 && !/^\s*\|/.test(line)) {
      out.push(line);
    } else {
      for (let k = i; k < j; k += 1) out.push(lines[k]!);
    }
    i = j;
  }
  return out.join("\n");
}

// --- filler at the edges ---------------------------------------------------

/** A leading clause that is dropped while the sentence it starts is kept. */
const OPENING_CLAUSES: readonly RegExp[] = [
  /^as an ai(?: (?:language )?model| assistant| model)?(?: developed by [^,]{1,40})?,\s*/i,
  /^being an ai(?: (?:language )?model| assistant)?,\s*/i,
  /^как (?:ии|ai|искусственный интеллект|языковая модель|ии-ассистент|ассистент на основе ии)(?:[- ]ассистент)?,\s*/i,
  /^будучи (?:ии|языковой моделью|искусственным интеллектом),\s*/i,
];

/** A whole opening sentence that carries nothing. */
const OPENING_SENTENCES: readonly RegExp[] = [
  /^(?:that'?s an? |what an? )?(?:great|good|excellent) question[!.]\s*/i,
  /^(?:certainly|sure|of course|absolutely)[!.]\s*/i,
  /^(?:отличный|хороший|прекрасный) вопрос[!.]\s*/i,
  /^(?:конечно|разумеется)[!.]\s*/i,
];

/** A whole closing sentence that carries nothing. */
const CLOSING_SENTENCES: readonly RegExp[] = [
  /\s*(?:i )?hope (?:this|that|it) helps(?: you)?[!.]?\s*(?:😊|🙂)?$/i,
  /\s*(?:please )?(?:let me know|feel free to (?:ask|reach out)) if you have any (?:other |more |further |additional )?questions[!.]?\s*(?:😊|🙂)?$/i,
  /\s*if you have any (?:other |more |further |additional )?questions,? (?:feel free to ask|let me know|don'?t hesitate to ask)[!.]?\s*(?:😊|🙂)?$/i,
  /\s*надеюсь,? (?:это|мой ответ) (?:поможет|помог|был[оа]? полезн(?:о|ым|а))[!.]?\s*(?:😊|🙂)?$/i,
  /\s*если у вас (?:есть|появятся|возникнут) (?:ещё |еще |другие |дополнительные )?вопросы,? (?:не стесняйтесь (?:спрашивать|обращаться)|обращайтесь|спрашивайте)[!.]?\s*(?:😊|🙂)?$/i,
];

function dropFillerAtEdges(segments: Segment[]): Segment[] {
  const out = segments.slice();
  const firstIdx = out.findIndex((s) => s.text.trim().length > 0);
  if (firstIdx !== -1 && out[firstIdx]!.kind === "prose") {
    const seg = out[firstIdx]!;
    const lead = /^\s*/.exec(seg.text)![0];
    let body = seg.text.slice(lead.length);
    for (const re of OPENING_SENTENCES) {
      const m = re.exec(body);
      if (m && hasContentAfter(out, firstIdx, body.slice(m[0].length))) {
        body = body.slice(m[0].length);
        break;
      }
    }
    for (const re of OPENING_CLAUSES) {
      const m = re.exec(body);
      if (m && body.slice(m[0].length).trim().length > 0) {
        body = capitalizeFirst(body.slice(m[0].length));
        break;
      }
    }
    out[firstIdx] = { kind: "prose", text: lead + body.replace(/^\s*\n/, "") };
  }
  const lastIdx = findLastIndex(out, (s) => s.text.trim().length > 0);
  if (lastIdx !== -1 && out[lastIdx]!.kind === "prose") {
    let body = out[lastIdx]!.text.trimEnd();
    for (let pass = 0; pass < 2; pass += 1) {
      let changed = false;
      for (const re of CLOSING_SENTENCES) {
        const m = re.exec(body);
        if (m === null) continue;
        const before = body.slice(0, m.index);
        // Only a whole sentence: on its own line, or after one that ended.
        const ownLine = /^[ \t]*\n/.test(m[0]);
        if (before.length > 0 && !ownLine && !/[.!?:)\]`*]\s*$/.test(before)) continue;
        if (before.trim().length === 0 && !hasContentBefore(out, lastIdx)) continue;
        body = before.trimEnd();
        changed = true;
        break;
      }
      if (!changed) break;
    }
    out[lastIdx] = { kind: "prose", text: body };
  }
  return out;
}

function hasContentAfter(segments: Segment[], idx: number, rest: string): boolean {
  if (rest.trim().length > 0) return true;
  return segments.slice(idx + 1).some((s) => s.text.trim().length > 0);
}

function hasContentBefore(segments: Segment[], idx: number): boolean {
  return segments.slice(0, idx).some((s) => s.text.trim().length > 0);
}

function capitalizeFirst(text: string): string {
  const ch = text[0];
  if (ch === undefined) return text;
  // `iPhone`, `npm`, a path: leave words that are lowercase on purpose.
  if (/^[a-zа-яё]+[A-Z0-9_./-]/.test(text)) return text;
  return ch.toLocaleUpperCase() + text.slice(1);
}

function findLastIndex<T>(list: readonly T[], pred: (item: T) => boolean): number {
  for (let i = list.length - 1; i >= 0; i -= 1) if (pred(list[i]!)) return i;
  return -1;
}

// --- echoed question -------------------------------------------------------

const ECHO_PREFIX =
  /^(?:#{1,6}\s+|>\s*|\*\*)?(?:(?:you asked|your question|question|the question is|вы спросили|ваш вопрос|вопрос)\s*[:：]\s*(?:\*\*)?\s*)?/i;

function comparable(text: string): string {
  return text
    .toLocaleLowerCase()
    .replace(/[*_`"'«»“”„#>]/g, "")
    .replace(/[\s.,!?;:…-]+/g, " ")
    .trim();
}

/**
 * The first paragraph is dropped when it only restates the user's
 * message ("You asked: how do I ...", a heading or quote of it). Short
 * messages are never matched: "hi" answered with "Hi!" is a greeting.
 */
function dropEchoedQuestion(segments: Segment[], userMessage: string): Segment[] {
  const asked = comparable(userMessage);
  if (asked.split(" ").length < 3 || asked.length < 12) return segments;
  const idx = segments.findIndex((s) => s.text.trim().length > 0);
  if (idx === -1 || segments[idx]!.kind !== "prose") return segments;
  const paras = paragraphsOf(segments[idx]!.text.replace(/^\s*\n/, ""));
  const first = paras[0] ?? "";
  if (comparable(first.trim().replace(ECHO_PREFIX, "")) !== asked) return segments;
  const rest = paras.slice(1).join("\n\n");
  if (!hasContentAfter(segments, idx, rest)) return segments;
  const out = segments.slice();
  out[idx] = { kind: "prose", text: rest };
  return out;
}

// --- home paths ------------------------------------------------------------

/** The user asked for the path as it is: "full path", "абсолютный путь". */
const FULL_PATH_ASK =
  /\b(?:full|absolute|complete|whole|exact)\s+(?:file\s+)?path|\bpath\s+in\s+full\b|(?:полн|абсолютн|цельн|точн)\S*\s+(?:\S+\s+)?пут|пут\S*\s+(?:целиком|полностью)/iu;

function asksForFullPath(userMessage: string | null | undefined): boolean {
  return typeof userMessage === "string" && FULL_PATH_ASK.test(userMessage);
}

/** Paths shorter than this are left alone: they already read fine. */
const LONG_PATH = 40;

/**
 * `/Users/me/projects/app/src/very/deep/file.ts` → `~/projects/app/...`.
 * Only plain prose: never inside `code` (the TUI and desktop draw those
 * as path chips and copy them as written), never a link target or URL.
 */
function shortenHomePaths(text: string, home: string): string {
  const root = home.replace(/[\\/]+$/, "");
  if (!/^\/(?:Users|home)\/[^/]+$/.test(root)) return text;
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[\\s(])${escaped}(/[^\\s\`'"<>)\\]]*)`, "g");
  return text
    .split("\n")
    .map((line) =>
      outsideInlineCode(line, (part) =>
        part.replace(re, (match: string, lead: string, rest: string, offset: number, whole: string) => {
          if (root.length + rest.length < LONG_PATH) return match;
          if (lead === "(" && whole[offset - 1] === "]") return match;
          return `${lead}~${rest}`;
        }),
      ),
    )
    .join("\n");
}

// --- tables → lists (Telegram) ---------------------------------------------

const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  const masked: string[] = [];
  const hidden = line.replace(/(`+)[^`]*?\1/g, (m) => {
    masked.push(m);
    return `\u0000${masked.length - 1}\u0000`;
  });
  let row = hidden.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  return row
    .split(/(?<!\\)\|/)
    .map((cell) =>
      cell
        .trim()
        .replace(/\\\|/g, "|")
        .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => masked[Number(i)] ?? ""),
    );
}

function isRowLine(line: string): boolean {
  return line.includes("|") && line.trim().length > 0;
}

/**
 * A GFM table (header row, `---` separator, body rows) becomes one list
 * item per row: the first cell in bold, the rest as `Header: value`.
 */
export function tablesToLists(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const header = lines[i]!;
    const sep = lines[i + 1];
    if (
      isRowLine(header) &&
      sep !== undefined &&
      sep.includes("|") &&
      TABLE_SEPARATOR.test(sep) &&
      splitRow(sep).length === splitRow(header).length
    ) {
      const heads = splitRow(header);
      let j = i + 2;
      const items: string[] = [];
      while (j < lines.length && isRowLine(lines[j]!)) {
        items.push(rowToItem(heads, splitRow(lines[j]!)));
        j += 1;
      }
      if (items.length === 0) {
        out.push(header, sep);
        i += 2;
        continue;
      }
      out.push(...items);
      i = j;
      continue;
    }
    out.push(header);
    i += 1;
  }
  return out.join("\n");
}

function rowToItem(heads: string[], cells: string[]): string {
  const [first = "", ...rest] = cells;
  const lead = first.length === 0 ? "" : /^\*\*.*\*\*$/.test(first) ? first : `**${first}**`;
  const parts: string[] = [];
  rest.forEach((cell, k) => {
    if (cell.length === 0) return;
    const head = heads[k + 1] ?? "";
    parts.push(head.length > 0 && rest.length > 1 ? `${head}: ${cell}` : cell);
  });
  if (lead.length === 0) return `- ${parts.join("; ")}`;
  return parts.length === 0 ? `- ${lead}` : `- ${lead}: ${parts.join("; ")}`;
}
