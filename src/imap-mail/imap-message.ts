import type { TriggerMail } from "../atomic-mail/atomic-mail-trigger-batches.js";
import {
  decodeHeaderWords,
  decodeTransfer,
  parseStructuredHeader,
  splitMultipart,
  splitPart,
  type Part,
} from "../tools/os/read-document/extractors/email-extractor.js";
import { htmlToMarkdown } from "../tools/os/read-document/extractors/html-markdown.js";
import { decodeBytes } from "../tools/os/read-document/extractors/text-decode.js";

/**
 * An IMAP message (raw RFC 5322 bytes) as the mail trigger sees it
 * (ATO-601): the same {@link TriggerMail} the Atomic Mail source hands
 * on, plus the files it carries. Reuses the `.eml` reader's MIME
 * helpers (`read_document`), so headers, encodings and charsets are
 * decoded one way across the agent.
 */

export interface MailAttachmentPart {
  /** Filename as the sender wrote it (decoded), `""` when none. */
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface ParsedImapMail {
  mail: TriggerMail;
  attachments: MailAttachmentPart[];
}

const MAX_DEPTH = 8;

/** An RFC 2047 encoded word, `=?charset?B|Q?text?=`. */
const ENCODED_WORD_RE = /=\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=/g;

/**
 * Blank out encoded words, quoted strings and comments in a raw header
 * value, keeping every other character at its position, so an address
 * can only be found where RFC 5322 puts it (outside quotes and
 * comments) and never inside a display name that encodes one
 * (`=?utf-8?q?=3Cme@gmail.com=3E?= <attacker@gmail.com>`).
 */
function maskQuotesAndComments(raw: string): string {
  const value = raw.replace(ENCODED_WORD_RE, (word) => " ".repeat(word.length));
  let out = "";
  let inQuote = false;
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]!;
    if ((inQuote || depth > 0) && ch === "\\") {
      out += "  ";
      i += 1;
      continue;
    }
    if (inQuote) {
      if (ch === '"') inQuote = false;
      out += " ";
    } else if (depth > 0) {
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      out += " ";
    } else if (ch === '"') {
      inQuote = true;
      out += " ";
    } else if (ch === "(") {
      depth = 1;
      out += " ";
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * `Name <a@b>`, `"Name" <a@b>`, `a@b`, `a@b (Name)` → address and name.
 *
 * The address is read from the RAW header with quoted strings and
 * comments masked, before any encoded words are decoded, so a display
 * name like `"<me@x.com>" <evil@x.com>` or `=?utf-8?q?=3Cme@x.com=3E?=
 * <evil@x.com>` yields `evil@x.com`. A From with more than one address
 * (or an unbalanced one) yields no address, so the mail is refused.
 */
export function parseFromHeader(raw: string | undefined): { email: string; name: string } {
  const value = (raw ?? "").trim();
  const masked = maskQuotesAndComments(value);
  const none = { email: "", name: "" };
  if ((masked.match(/@/g) ?? []).length !== 1) return none;
  const opens = (masked.match(/</g) ?? []).length;
  const closes = (masked.match(/>/g) ?? []).length;
  if (opens !== closes || opens > 1) return none;
  if (opens === 1) {
    const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(masked);
    if (!angle) return none;
    const rest = (masked.slice(0, angle.index) + masked.slice(angle.index + angle[0].length)).trim();
    if (/[,;:]/.test(rest)) return none;
    const name = decodeHeaderWords(value.slice(0, angle.index)).trim().replace(/^"(.*)"$/, "$1").trim();
    return { email: angle[1]!.trim().toLowerCase(), name };
  }
  const bare = /[^\s<>(),;:"]+@[^\s<>(),;:"]+/.exec(masked);
  if (!bare) return none;
  const others = (masked.slice(0, bare.index) + masked.slice(bare.index + bare[0].length)).trim();
  if (others !== "") return none;
  const comment = /\(([^)]*)\)/.exec(value);
  return { email: bare[0].toLowerCase(), name: decodeHeaderWords(comment?.[1] ?? "").trim() };
}

function receivedAt(dateHeader: string | undefined, fallback: Date): string {
  const parsed = dateHeader ? Date.parse(dateHeader) : Number.NaN;
  return new Date(Number.isFinite(parsed) ? parsed : fallback.getTime()).toISOString();
}

interface Collected {
  text: string[];
  attachments: MailAttachmentPart[];
}

function collect(part: Part, depth: number, out: Collected): void {
  if (depth > MAX_DEPTH) return;
  const type = parseStructuredHeader(part.headers.get("content-type") ?? "text/plain");
  const mime = type.value || "text/plain";
  const disposition = parseStructuredHeader(part.headers.get("content-disposition"));
  const name = decodeHeaderWords(disposition.params.filename ?? type.params.name ?? "").trim();

  if (mime.startsWith("multipart/")) {
    const boundary = type.params.boundary;
    if (!boundary) {
      out.text.push(decodeBytes(Buffer.from(part.body, "latin1")).text);
      return;
    }
    const children = splitMultipart(part.body, boundary).map(splitPart);
    if (mime === "multipart/alternative") {
      const isBody = (c: Part, want: string) =>
        (parseStructuredHeader(c.headers.get("content-type") ?? "text/plain").value || "text/plain") === want &&
        parseStructuredHeader(c.headers.get("content-disposition")).value !== "attachment";
      const pick =
        children.find((c) => isBody(c, "text/plain")) ??
        children.find((c) => isBody(c, "text/html")) ??
        children[children.length - 1];
      if (pick) collect(pick, depth + 1, out);
      return;
    }
    for (const child of children) collect(child, depth + 1, out);
    return;
  }

  const bytes = decodeTransfer(part.body, part.headers.get("content-transfer-encoding"));
  if (mime === "message/rfc822" && disposition.value !== "attachment") {
    // A forward: its text joins the body, its files join the list.
    const inner = splitPart(Buffer.from(bytes).toString("latin1"));
    const from = decodeHeaderWords(inner.headers.get("from") ?? "");
    const subject = decodeHeaderWords(inner.headers.get("subject") ?? "");
    out.text.push(`--- forwarded message ---\nFrom: ${from}\nSubject: ${subject}`);
    collect(inner, depth + 1, out);
    return;
  }
  const isText = mime === "text/plain" || mime === "text/html";
  if (isText && disposition.value !== "attachment" && !(disposition.value === "inline" && name)) {
    const decoded = decodeBytes(bytes, type.params.charset).text.replace(/\r\n?/g, "\n");
    out.text.push(mime === "text/html" ? htmlToMarkdown(decoded).text : decoded);
    return;
  }
  // An unnamed inline part (a logo the HTML points at) is not a file the sender attached.
  if (!name && disposition.value !== "attachment") return;
  out.attachments.push({ name, mimeType: mime, bytes });
}

/**
 * Reads a whole message. `raw` may also be the header block alone
 * (`BODY.PEEK[HEADER]`), which gives an empty text and no files.
 */
export function parseImapMessage(
  raw: Buffer,
  id: string,
  now: Date = new Date(),
): ParsedImapMail {
  const part = splitPart(raw.toString("latin1"));
  const from = parseFromHeader(part.headers.get("from"));
  const out: Collected = { text: [], attachments: [] };
  if (part.body.length > 0) collect(part, 0, out);
  return {
    mail: {
      id,
      fromEmail: from.email,
      fromName: from.name,
      subject: decodeHeaderWords(part.headers.get("subject") ?? "").trim(),
      receivedAt: receivedAt(part.headers.get("date"), now),
      text: out.text.map((t) => t.trim()).filter((t) => t.length > 0).join("\n\n"),
      // `splitPart` keeps the first of each header: the topmost, which the
      // receiving server wrote above anything the sender put in.
      authResults: part.headers.get("authentication-results")?.replace(/[\r\n]+/g, " ").trim() || null,
    },
    attachments: out.attachments,
  };
}

/** The authserv-id of an `Authentication-Results` value (RFC 8601), lower-case. */
export function authservIdOf(header: string | null): string {
  if (!header) return "";
  let depth = 0;
  let plain = "";
  for (const ch of header) {
    if (ch === "(") depth += 1;
    else if (ch === ")" && depth > 0) depth -= 1;
    else if (depth === 0) plain += ch;
  }
  return (plain.split(";", 1)[0] ?? "").trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
}
