import type { DocumentFormat, Extractor, ExtractResult } from "./extractor-types.js";
import { htmlToMarkdown } from "./html-markdown.js";
import { decodeBytes } from "./text-decode.js";

/**
 * Email extractors: a single RFC 5322 / MIME message (`.eml`) and a Unix
 * mailbox of many messages (`.mbox`). Plain MIME text, so this is a small
 * self-contained parser rather than a dependency:
 *
 * - headers are unfolded and RFC 2047 encoded words (`=?utf-8?B?…?=`) are
 *   decoded, so subjects and names in any script come out readable;
 * - bodies honour `Content-Transfer-Encoding` (base64, quoted-printable,
 *   7bit/8bit) and the part's `charset`;
 * - `multipart/alternative` shows one body, preferring text/plain and
 *   falling back to the HTML part rendered as markdown;
 * - `multipart/mixed` / `related` show every text part in order;
 * - attachments are listed by name, type and size, never inlined;
 * - attached messages (`message/rfc822`, i.e. forwards) are rendered
 *   recursively.
 *
 * Outlook `.msg` is a different, binary (OLE2) container and is not
 * handled here.
 */
const SHOWN_HEADERS = ["from", "to", "cc", "date", "subject"] as const;
const MAX_DEPTH = 8;

export const emlExtractor: Extractor = async (input) => {
  const warnings: string[] = [];
  const raw = input.data.toString("latin1");
  const text = renderMessage(raw, 0, warnings);
  return { format: "eml", text: text.trim(), warnings: dedupe(warnings) };
};

export const mboxExtractor: Extractor = async (input) => {
  const warnings: string[] = [];
  const messages = splitMbox(input.data.toString("latin1"));
  const total = messages.length;
  const result = (text: string, extracted: number[]): ExtractResult => ({
    format: "mbox" satisfies DocumentFormat,
    text,
    pageCount: total,
    pagesExtracted: extracted,
    warnings: dedupe(warnings),
  });
  if (total === 0) {
    warnings.push("no messages found (expected lines starting with \"From \")");
    return result("", []);
  }

  const start = Math.max(1, input.pagesFrom ?? 1);
  const end = Math.min(total, input.pagesTo ?? total);
  const maxPages = input.maxPages ?? total;
  const separators = input.pageSeparators !== false;
  const chunks: string[] = [];
  const extracted: number[] = [];
  for (let n = start; n <= end; n++) {
    if (extracted.length >= maxPages) break;
    const text = renderMessage(messages[n - 1]!, 0, warnings).trim();
    chunks.push(separators ? `--- message ${n} ---\n${text}` : text);
    extracted.push(n);
  }
  const remaining = end - start + 1 - extracted.length;
  if (remaining > 0) {
    warnings.push(
      `stopped at maxPages=${maxPages}; ${remaining} more message(s) not read (use pagesFrom)`,
    );
  }
  return result(chunks.join("\n\n").trim(), extracted);
};

/**
 * mboxo/mboxrd: a message starts at a `From ` line at the top of the file
 * or right after a blank line. Body lines that began with `From ` were
 * escaped as `>From ` (mboxrd adds one `>` per level); undo one level.
 */
function splitMbox(raw: string): string[] {
  const lines = raw.split(/\r?\n/);
  const messages: string[] = [];
  let current: string[] | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("From ") && (i === 0 || lines[i - 1] === "")) {
      if (current) messages.push(current.join("\n"));
      current = [];
      continue;
    }
    if (current) current.push(line.replace(/^>(>*From )/, "$1"));
  }
  if (current) messages.push(current.join("\n"));
  return messages.filter((m) => m.trim().length > 0);
}

// ---------------------------------------------------------------- parsing

interface Part {
  headers: Map<string, string>;
  /** Body as a latin1 "binary" string: one char per byte, still encoded. */
  body: string;
}

function splitPart(raw: string): Part {
  const firstLine = /^[^\r\n]*/.exec(raw)?.[0] ?? "";
  // A file that does not open with a header line is treated as a bare
  // text body (some tools save just the message text with a .eml name).
  if (!/^[!-9;-~]+:/.test(firstLine)) {
    return { headers: new Map(), body: raw };
  }
  const gap = /\r?\n\r?\n/.exec(raw);
  const headerText = gap ? raw.slice(0, gap.index) : raw;
  const body = gap ? raw.slice(gap.index + gap[0].length) : "";
  const headers = new Map<string, string>();
  for (const line of headerText.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    // First occurrence wins: that is the one a mail client shows.
    if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
  }
  return { headers, body };
}

interface HeaderValue {
  value: string;
  params: Record<string, string>;
}

function parseStructuredHeader(raw: string | undefined): HeaderValue {
  if (!raw) return { value: "", params: {} };
  const semi = raw.indexOf(";");
  const value = (semi === -1 ? raw : raw.slice(0, semi)).trim().toLowerCase();
  const params: Record<string, string> = {};
  const continued: Record<string, string[]> = {};
  const re = /;\s*([^=\s;]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const key = m[1]!.toLowerCase();
    let val = m[2]!.trim();
    if (val.startsWith('"')) val = val.slice(1, -1).replace(/\\(.)/g, "$1");
    // RFC 2231: `filename*=utf-8''na%C3%AFve.pdf` and the split form
    // `filename*0*=…; filename*1*=…`.
    const split = /^(.+?)\*(\d+)\*?$/.exec(key);
    if (split) {
      (continued[split[1]!] ??= [])[Number(split[2])] = val;
      continue;
    }
    if (key.endsWith("*")) {
      params[key.slice(0, -1)] = decodeRfc2231(val);
      continue;
    }
    params[key] = val;
  }
  for (const [key, pieces] of Object.entries(continued)) {
    if (params[key]) continue;
    params[key] = decodeRfc2231(pieces.join(""));
  }
  return { value, params };
}

function decodeRfc2231(value: string): string {
  const m = /^([^']*)'[^']*'(.*)$/.exec(value);
  if (!m) return value;
  const bytes = percentBytes(m[2]!);
  return decodeBytes(bytes, m[1] || "utf-8").text;
}

function percentBytes(value: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "%" && /^[0-9a-fA-F]{2}$/.test(value.slice(i + 1, i + 3))) {
      out.push(parseInt(value.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(value.charCodeAt(i) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** RFC 2047 encoded words in header values. */
export function decodeHeaderWords(value: string): string {
  // Whitespace between two adjacent encoded words is not displayed.
  const joined = value.replace(/(\?=)\s+(?==\?)/g, "$1");
  const decoded = joined.replace(
    /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
    (_all, charset: string, enc: string, text: string) => {
      const bytes =
        enc.toUpperCase() === "B"
          ? Buffer.from(text, "base64")
          : qpBytes(text.replace(/_/g, " "));
      return decodeBytes(bytes, charset.split("*")[0]).text;
    },
  );
  // Raw 8-bit headers (no encoded words) are usually UTF-8 these days.
  return decoded === joined &&
    /[\x80-\xff]/.test(decoded) &&
    !/[^\x00-\xff]/.test(decoded)
    ? decodeBytes(Buffer.from(decoded, "latin1")).text
    : decoded;
}

function qpBytes(value: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === "=" && /^[0-9a-fA-F]{2}$/.test(value.slice(i + 1, i + 3))) {
      out.push(parseInt(value.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(ch.charCodeAt(0) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

function decodeTransfer(body: string, encoding: string | undefined): Uint8Array {
  const enc = (encoding ?? "").trim().toLowerCase();
  if (enc === "base64") return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  if (enc === "quoted-printable") return qpBytes(body.replace(/=\r?\n/g, ""));
  return Buffer.from(body, "latin1");
}

// -------------------------------------------------------------- rendering

function renderMessage(raw: string, depth: number, warnings: string[]): string {
  const part = splitPart(raw);
  const lines: string[] = [];
  for (const name of SHOWN_HEADERS) {
    const value = part.headers.get(name);
    if (value) lines.push(`${capitalise(name)}: ${decodeHeaderWords(value)}`);
  }
  const attachments: string[] = [];
  const body = renderPart(part, depth, warnings, attachments).trim();
  const out = [lines.join("\n"), body];
  if (attachments.length > 0) {
    out.push(`Attachments:\n${attachments.map((a) => `- ${a}`).join("\n")}`);
  }
  return out.filter((s) => s.length > 0).join("\n\n");
}

function renderPart(
  part: Part,
  depth: number,
  warnings: string[],
  attachments: string[],
): string {
  if (depth > MAX_DEPTH) {
    warnings.push(`MIME nesting deeper than ${MAX_DEPTH} levels was cut`);
    return "";
  }
  const type = parseStructuredHeader(part.headers.get("content-type") ?? "text/plain");
  const mime = type.value || "text/plain";
  const disposition = parseStructuredHeader(part.headers.get("content-disposition"));
  const filename = decodeHeaderWords(
    disposition.params.filename ?? type.params.name ?? "",
  );

  if (mime.startsWith("multipart/")) {
    const boundary = type.params.boundary;
    if (!boundary) {
      warnings.push(`${mime} without a boundary; shown as text`);
      return decodeBytes(Buffer.from(part.body, "latin1")).text;
    }
    const children = splitMultipart(part.body, boundary).map(splitPart);
    if (mime === "multipart/alternative") {
      const pick =
        children.find((c) => partMime(c) === "text/plain" && !isAttachment(c)) ??
        children.find((c) => partMime(c) === "text/html" && !isAttachment(c)) ??
        children[children.length - 1];
      return pick ? renderPart(pick, depth + 1, warnings, attachments) : "";
    }
    return children
      .map((c) => renderPart(c, depth + 1, warnings, attachments).trim())
      .filter((t) => t.length > 0)
      .join("\n\n");
  }

  const bytes = decodeTransfer(part.body, part.headers.get("content-transfer-encoding"));

  if (mime === "message/rfc822" && disposition.value !== "attachment") {
    const nested = renderMessage(Buffer.from(bytes).toString("latin1"), depth + 1, warnings);
    return `--- attached message ---\n${nested}`;
  }

  const isText = mime === "text/plain" || mime === "text/html";
  if (!isText || disposition.value === "attachment") {
    const label = filename || "(unnamed)";
    attachments.push(`${label} (${mime}, ${formatSize(bytes.byteLength)})`);
    return "";
  }

  const decoded = decodeBytes(bytes, type.params.charset);
  if (decoded.warning) warnings.push(decoded.warning);
  const text = decoded.text.replace(/\r\n?/g, "\n");
  return mime === "text/html" ? htmlToMarkdown(text).text : text;
}

function partMime(part: Part): string {
  return parseStructuredHeader(part.headers.get("content-type") ?? "text/plain").value || "text/plain";
}

function isAttachment(part: Part): boolean {
  return parseStructuredHeader(part.headers.get("content-disposition")).value === "attachment";
}

function splitMultipart(body: string, boundary: string): string[] {
  const delimiter = `--${boundary}`;
  const parts: string[] = [];
  let current: string[] | null = null;
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trimEnd();
    if (trimmed === `${delimiter}--`) {
      if (current) parts.push(current.join("\n"));
      current = null;
      break;
    }
    if (trimmed === delimiter) {
      if (current) parts.push(current.join("\n"));
      current = [];
      continue;
    }
    // Lines before the first delimiter are the MIME preamble: ignored.
    current?.push(line);
  }
  // Truncated message without a closing delimiter: keep the last part.
  if (current) parts.push(current.join("\n"));
  return parts;
}

function capitalise(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}
