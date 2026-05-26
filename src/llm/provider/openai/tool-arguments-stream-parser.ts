/**
 * Incrementally extracts `text` from a streaming `reply` tool-call
 * arguments JSON fragment.
 */
export function extractPartialReplyTextFromToolArguments(
  buffer: string,
): string {
  const textKey = buffer.indexOf('"text"');
  if (textKey < 0) return "";
  const colon = buffer.indexOf(":", textKey);
  if (colon < 0) return "";
  const startQuote = buffer.indexOf('"', colon + 1);
  if (startQuote < 0) return "";
  let i = startQuote + 1;
  let out = "";
  while (i < buffer.length) {
    const ch = buffer[i];
    if (ch === "\\" && i + 1 < buffer.length) {
      out += buffer[i + 1];
      i += 2;
      continue;
    }
    if (ch === '"') break;
    out += ch;
    i += 1;
  }
  return out;
}
