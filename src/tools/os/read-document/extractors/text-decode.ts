/**
 * Charset-aware decoding for the text-based formats (HTML, email). Node's
 * `TextDecoder` ships with full ICU, so the labels mail clients and old web
 * pages actually use (windows-1251, koi8-r, iso-8859-*, shift_jis, gb18030…)
 * decode without an extra dependency. An unknown label falls back to UTF-8,
 * and UTF-8 that yields replacement characters falls back to windows-1252,
 * mirroring the plain-text extractor.
 */
export interface DecodedText {
  text: string;
  /** Set when the declared or default charset could not be honoured. */
  warning?: string;
}

export function decodeBytes(
  data: Uint8Array,
  charset?: string,
): DecodedText {
  const label = normaliseCharset(charset);
  if (label && label !== "utf-8") {
    try {
      return { text: new TextDecoder(label).decode(data) };
    } catch {
      // Unknown label: fall through to the UTF-8 path and say so.
      const utf = decodeUtf8WithFallback(data);
      return {
        text: utf.text,
        warning: `unknown charset "${charset}", decoded as ${utf.used}`,
      };
    }
  }
  const utf = decodeUtf8WithFallback(data);
  return utf.used === "utf-8"
    ? { text: utf.text }
    : {
        text: utf.text,
        warning: "UTF-8 decode produced replacement characters, used windows-1252",
      };
}

function decodeUtf8WithFallback(data: Uint8Array): {
  text: string;
  used: "utf-8" | "windows-1252";
} {
  const text = new TextDecoder("utf-8").decode(data);
  if (!text.includes("�")) return { text, used: "utf-8" };
  return { text: new TextDecoder("windows-1252").decode(data), used: "windows-1252" };
}

function normaliseCharset(charset: string | undefined): string | undefined {
  if (!charset) return undefined;
  const trimmed = charset.trim().replace(/^["']|["']$/g, "").toLowerCase();
  if (trimmed.length === 0) return undefined;
  if (trimmed === "utf8") return "utf-8";
  // `us-ascii` is a strict subset in theory and windows-1252 in practice
  // (mailers label 8-bit Latin text as ascii all the time).
  if (trimmed === "us-ascii" || trimmed === "ascii") return "windows-1252";
  return trimmed;
}

/**
 * Pick the charset an HTML file declares: a BOM first, then a
 * `<meta charset>` / `http-equiv` declaration in the first few KB.
 */
export function sniffHtmlCharset(data: Uint8Array): string | undefined {
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return "utf-8";
  if (data[0] === 0xff && data[1] === 0xfe) return "utf-16le";
  if (data[0] === 0xfe && data[1] === 0xff) return "utf-16be";
  const head = Buffer.from(data.subarray(0, 4096)).toString("latin1");
  const meta =
    /<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_\-:.]+)/i.exec(head) ??
    undefined;
  return meta?.[1];
}
