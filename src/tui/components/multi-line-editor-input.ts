/**
 * Normalise a chunk of text before it is inserted into the editor
 * buffer. This runs on every keystroke and, crucially, on every paste
 * burst — where the real-world corruption comes from.
 *
 * Two problems a raw paste carries:
 *   1. Line endings. Terminals (and most clipboards) deliver line breaks
 *      as CRLF (`\r\n`) or a lone CR (`\r`). The editor splits logical
 *      lines on `\n` only, so a surviving `\r` stays *inside* a rendered
 *      line. A terminal interprets `\r` as a carriage return — the cursor
 *      jumps back to column 0 and the following text overprints the line,
 *      wiping the left border and indent. That is exactly the
 *      "two drafts stacked on top of each other" tear seen on paste but
 *      never on manual typing (typed input has no `\r`).
 *   2. Stray C0 control characters (NUL, ESC, backspace, form-feed, …)
 *      that a paste may smuggle in and that corrupt the rendered frame.
 *
 * We collapse every CRLF / CR into a single `\n`, keep `\n` and `\t`, and
 * drop the remaining C0 controls plus DEL.
 */
export function normalizeInsertText(text: string): string {
  const unified = text.replace(/\r\n?/g, "\n");
  let out = "";
  for (const ch of unified) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\n" || ch === "\t") {
      out += ch;
      continue;
    }
    // Drop C0 controls (0x00–0x1F) and DEL (0x7F); keep everything else.
    if (code < 0x20 || code === 0x7f) continue;
    out += ch;
  }
  return out;
}
