import { CfbError, openCfb } from "./cfb-reader.js";
import type { CfbEntry, CfbFile } from "./cfb-reader.js";
import { formatSize } from "./email-extractor.js";
import type { Extractor } from "./extractor-types.js";
import { htmlToMarkdown } from "./html-markdown.js";
import { decodeBytes, sniffHtmlCharset } from "./text-decode.js";

/**
 * Outlook `.msg` (MS-OXMSG): a compound file whose root storage holds one
 * stream per MAPI property, named `__substg1.0_<tag><type>`, plus a
 * `__properties_version1.0` stream with the fixed-size values (dates,
 * numbers), one `__recip_version1.0_#N` storage per recipient and one
 * `__attach_version1.0_#N` storage per attachment.
 *
 * The output has the same shape as the `.eml` reader: From/To/Cc/Date/
 * Subject, the body (plain text preferred, HTML rendered as markdown
 * otherwise), then attachments listed by name, type and size. Attached
 * Outlook items (forwards) are rendered recursively.
 */

const PT_LONG = 0x0003;
const PT_SYSTIME = 0x0040;
const PT_STRING8 = 0x001e;
const PT_UNICODE = 0x001f;
const PT_BINARY = 0x0102;
const PT_OBJECT = 0x000d;

const PR_SUBJECT = 0x0037;
const PR_CLIENT_SUBMIT_TIME = 0x0039;
const PR_SENT_REPRESENTING_NAME = 0x0042;
const PR_SENT_REPRESENTING_EMAIL = 0x0065;
const PR_TRANSPORT_MESSAGE_HEADERS = 0x007d;
const PR_SENDER_NAME = 0x0c1a;
const PR_SENDER_EMAIL = 0x0c1f;
const PR_RECIPIENT_TYPE = 0x0c15;
const PR_DISPLAY_CC = 0x0e03;
const PR_DISPLAY_TO = 0x0e04;
const PR_MESSAGE_DELIVERY_TIME = 0x0e06;
const PR_BODY = 0x1000;
const PR_RTF_COMPRESSED = 0x1009;
const PR_HTML = 0x1013;
const PR_DISPLAY_NAME = 0x3001;
const PR_EMAIL_ADDRESS = 0x3003;
const PR_ATTACH_DATA = 0x3701;
const PR_ATTACH_FILENAME = 0x3704;
const PR_ATTACH_METHOD = 0x3705;
const PR_ATTACH_LONG_FILENAME = 0x3707;
const PR_ATTACH_MIME_TAG = 0x370e;
const PR_SMTP_ADDRESS = 0x39fe;
const PR_INTERNET_CPID = 0x3fde;
const PR_MESSAGE_CODEPAGE = 0x3ffd;
const PR_SENDER_SMTP_ADDRESS = 0x5d01;
const PR_SENT_REPRESENTING_SMTP = 0x5d02;

const ATTACH_EMBEDDED_MSG = 5;
const MAX_DEPTH = 8;

/** Size of the `__properties_version1.0` header before the 16-byte rows. */
const HEADER_TOP = 32;
const HEADER_EMBEDDED = 24;
const HEADER_CHILD = 8;

export const msgExtractor: Extractor = async (input) => {
  const warnings: string[] = [];
  let cfb: CfbFile;
  try {
    cfb = openCfb(input.data);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `os.fs.read_document: ${input.sourcePath} is not a readable Outlook .msg file (${reason})`,
    );
  }
  const hasProps = [...cfb.root.children.keys()].some(
    (k) => k.startsWith("__SUBSTG1.0_") || k === "__PROPERTIES_VERSION1.0",
  );
  if (!hasProps) {
    warnings.push("no Outlook message properties found; this compound file may not be a .msg");
  }
  const text = renderMessage(cfb, cfb.root, HEADER_TOP, 0, warnings);
  return { format: "msg", text: text.trim(), warnings: [...new Set(warnings)] };
};

interface MessageCtx {
  cfb: CfbFile;
  storage: CfbEntry;
  props: Map<number, Buffer>;
  /** Charset for PT_STRING8 values. */
  ansi: string;
  warnings: string[];
}

function renderMessage(
  cfb: CfbFile,
  storage: CfbEntry,
  headerSize: number,
  depth: number,
  warnings: string[],
): string {
  const props = readFixedProps(cfb, storage, headerSize, warnings);
  const ansi =
    codepageLabel(getLong(props, PR_MESSAGE_CODEPAGE)) ??
    codepageLabel(getLong(props, PR_INTERNET_CPID)) ??
    "windows-1252";
  const ctx: MessageCtx = { cfb, storage, props, ansi, warnings };

  const recipients = readRecipients(ctx);
  const from = formatAddress(
    readString(ctx, PR_SENDER_NAME) ?? readString(ctx, PR_SENT_REPRESENTING_NAME),
    readString(ctx, PR_SENDER_SMTP_ADDRESS) ??
      readString(ctx, PR_SENT_REPRESENTING_SMTP) ??
      smtpOnly(readString(ctx, PR_SENDER_EMAIL)) ??
      smtpOnly(readString(ctx, PR_SENT_REPRESENTING_EMAIL)),
  );
  const to = recipients.to.length > 0 ? recipients.to.join(", ") : readString(ctx, PR_DISPLAY_TO);
  const cc = recipients.cc.length > 0 ? recipients.cc.join(", ") : readString(ctx, PR_DISPLAY_CC);

  const headerLines: string[] = [];
  const push = (name: string, value: string | undefined) => {
    if (value && value.trim().length > 0) headerLines.push(`${name}: ${value.trim()}`);
  };
  push("From", from);
  push("To", to);
  push("Cc", cc);
  push("Date", readDate(ctx));
  push("Subject", readString(ctx, PR_SUBJECT));

  const attachments: string[] = [];
  const nested: string[] = [];
  readAttachments(ctx, depth, attachments, nested);

  const out = [headerLines.join("\n"), readBody(ctx), ...nested];
  if (attachments.length > 0) {
    out.push(`Attachments:\n${attachments.map((a) => `- ${a}`).join("\n")}`);
  }
  return out.filter((s) => s.length > 0).join("\n\n");
}

// ------------------------------------------------------------ properties

function substgName(id: number, type: number): string {
  return `__substg1.0_${hex4(id)}${hex4(type)}`;
}

function hex4(n: number): string {
  return n.toString(16).toUpperCase().padStart(4, "0");
}

function readStream(ctx: MessageCtx, name: string): Buffer | undefined {
  const entry = ctx.cfb.child(ctx.storage, name);
  if (!entry || entry.type !== "stream") return undefined;
  try {
    return ctx.cfb.read(entry);
  } catch (err) {
    const reason = err instanceof CfbError ? err.message : String(err);
    ctx.warnings.push(`skipped unreadable property ${name}: ${reason}`);
    return undefined;
  }
}

function readString(ctx: MessageCtx, id: number): string | undefined {
  const unicode = readStream(ctx, substgName(id, PT_UNICODE));
  if (unicode) return clean(unicode.toString("utf16le"));
  const ansi = readStream(ctx, substgName(id, PT_STRING8));
  if (ansi) return clean(decodeBytes(ansi, ctx.ansi).text);
  return undefined;
}

function clean(value: string): string | undefined {
  const text = value.replace(/\0+$/, "");
  return text.length > 0 ? text : undefined;
}

/** Fixed-size values: 16-byte rows of tag, flags and an 8-byte value. */
function readFixedProps(
  cfb: CfbFile,
  storage: CfbEntry,
  headerSize: number,
  warnings: string[],
): Map<number, Buffer> {
  const props = new Map<number, Buffer>();
  const entry = cfb.child(storage, "__properties_version1.0");
  if (!entry || entry.type !== "stream") return props;
  let buf: Buffer;
  try {
    buf = cfb.read(entry);
  } catch (err) {
    warnings.push(`skipped unreadable property table: ${err instanceof Error ? err.message : String(err)}`);
    return props;
  }
  for (let off = headerSize; off + 16 <= buf.length; off += 16) {
    props.set(buf.readUInt32LE(off), buf.subarray(off + 8, off + 16));
  }
  return props;
}

function tag(id: number, type: number): number {
  return ((id << 16) | type) >>> 0;
}

function getLong(props: Map<number, Buffer>, id: number): number | undefined {
  return props.get(tag(id, PT_LONG))?.readUInt32LE(0);
}

function getTime(props: Map<number, Buffer>, id: number): Date | undefined {
  const value = props.get(tag(id, PT_SYSTIME));
  if (!value) return undefined;
  // FILETIME: 100 ns ticks since 1601-01-01 UTC.
  const ms = Number(value.readBigUInt64LE(0) / 10000n) - 11644473600000;
  if (!Number.isFinite(ms) || ms <= 0 || ms > 253402300799000) return undefined;
  return new Date(ms);
}

function readDate(ctx: MessageCtx): string | undefined {
  const time =
    getTime(ctx.props, PR_CLIENT_SUBMIT_TIME) ?? getTime(ctx.props, PR_MESSAGE_DELIVERY_TIME);
  if (time) return time.toUTCString();
  const headers = readString(ctx, PR_TRANSPORT_MESSAGE_HEADERS);
  return headers ? /^Date:[ \t]*(.+)$/im.exec(headers)?.[1]?.trim() : undefined;
}

// ---------------------------------------------------------------- people

function formatAddress(name: string | undefined, email: string | undefined): string | undefined {
  if (name && email && name !== email) return `${name} <${email}>`;
  return name ?? email;
}

/** Exchange stores internal senders as X.500 DNs (`/O=…/CN=…`): not an address. */
function smtpOnly(value: string | undefined): string | undefined {
  return value && value.includes("@") ? value : undefined;
}

function childStorages(ctx: MessageCtx, prefix: string): CfbEntry[] {
  return [...ctx.storage.children.entries()]
    .filter(([name]) => name.startsWith(prefix))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, idx]) => ctx.cfb.entry(idx))
    .filter((e) => e.type === "storage");
}

function subCtx(ctx: MessageCtx, storage: CfbEntry, headerSize: number): MessageCtx {
  return {
    ...ctx,
    storage,
    props: readFixedProps(ctx.cfb, storage, headerSize, ctx.warnings),
  };
}

function readRecipients(ctx: MessageCtx): { to: string[]; cc: string[] } {
  const to: string[] = [];
  const cc: string[] = [];
  for (const storage of childStorages(ctx, "__RECIP_VERSION1.0_#")) {
    const r = subCtx(ctx, storage, HEADER_CHILD);
    const address = formatAddress(
      readString(r, PR_DISPLAY_NAME),
      readString(r, PR_SMTP_ADDRESS) ?? smtpOnly(readString(r, PR_EMAIL_ADDRESS)),
    );
    if (!address) continue;
    // 1 = To, 2 = Cc, 3 = Bcc (not shown, like the .eml reader).
    const kind = getLong(r.props, PR_RECIPIENT_TYPE) ?? 1;
    if (kind === 1) to.push(address);
    else if (kind === 2) cc.push(address);
  }
  return { to, cc };
}

// ------------------------------------------------------------------ body

function readBody(ctx: MessageCtx): string {
  const plain = readString(ctx, PR_BODY);
  if (plain && plain.trim().length > 0) return plain.replace(/\r\n?/g, "\n").trim();

  const html = readHtml(ctx);
  if (html) return htmlToMarkdown(html).text;

  if (ctx.cfb.child(ctx.storage, substgName(PR_RTF_COMPRESSED, PT_BINARY))) {
    ctx.warnings.push("message body is stored only as compressed RTF, which is not read");
  }
  return "";
}

function readHtml(ctx: MessageCtx): string | undefined {
  const asString = readString(ctx, PR_HTML);
  if (asString) return asString;
  const bytes = readStream(ctx, substgName(PR_HTML, PT_BINARY));
  if (!bytes || bytes.length === 0) return undefined;
  const charset = codepageLabel(getLong(ctx.props, PR_INTERNET_CPID)) ?? sniffHtmlCharset(bytes);
  const decoded = decodeBytes(bytes, charset);
  if (decoded.warning) ctx.warnings.push(decoded.warning);
  return decoded.text;
}

// ----------------------------------------------------------- attachments

function readAttachments(
  ctx: MessageCtx,
  depth: number,
  attachments: string[],
  nested: string[],
): void {
  for (const storage of childStorages(ctx, "__ATTACH_VERSION1.0_#")) {
    const a = subCtx(ctx, storage, HEADER_CHILD);
    const method = getLong(a.props, PR_ATTACH_METHOD);
    const embedded = ctx.cfb.child(storage, substgName(PR_ATTACH_DATA, PT_OBJECT));
    if (method === ATTACH_EMBEDDED_MSG && embedded?.type === "storage") {
      if (depth + 1 > MAX_DEPTH) {
        ctx.warnings.push(`attached messages nested deeper than ${MAX_DEPTH} levels were cut`);
        continue;
      }
      const text = renderMessage(ctx.cfb, embedded, HEADER_EMBEDDED, depth + 1, ctx.warnings);
      nested.push(`--- attached message ---\n${text}`);
      continue;
    }
    const name =
      readString(a, PR_ATTACH_LONG_FILENAME) ??
      readString(a, PR_ATTACH_FILENAME) ??
      readString(a, PR_DISPLAY_NAME) ??
      "(unnamed)";
    const mime = readString(a, PR_ATTACH_MIME_TAG) ?? "application/octet-stream";
    // The size comes from the directory entry: the data is never read.
    const data = ctx.cfb.child(storage, substgName(PR_ATTACH_DATA, PT_BINARY));
    const size = data?.type === "stream" ? `, ${formatSize(data.size)}` : "";
    attachments.push(`${name} (${mime}${size})`);
  }
}

// -------------------------------------------------------------- charsets

/** Windows code page number → WHATWG encoding label for `TextDecoder`. */
function codepageLabel(cp: number | undefined): string | undefined {
  if (cp === undefined || cp === 0) return undefined;
  if (cp >= 1250 && cp <= 1258) return `windows-${cp}`;
  if (cp >= 28591 && cp <= 28606) return `iso-8859-${cp - 28590}`;
  const named: Record<number, string> = {
    866: "ibm866",
    874: "windows-874",
    932: "shift_jis",
    936: "gbk",
    949: "euc-kr",
    950: "big5",
    1200: "utf-16le",
    1201: "utf-16be",
    20127: "us-ascii",
    20866: "koi8-r",
    21866: "koi8-u",
    50220: "iso-2022-jp",
    51932: "euc-jp",
    54936: "gb18030",
    65001: "utf-8",
  };
  return named[cp];
}
