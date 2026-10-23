/**
 * How an approval prompt fits a long preview onto a surface with a size
 * limit (ATO-434). A multi-line command used to be cut at 240 characters
 * in the TUI with a bare `…`, so the lines after the cut were silently
 * missing from the prompt the person approved; Telegram showed every
 * line but a message past its 4096-character limit failed to send and
 * the request was denied.
 *
 * The excerpt keeps whole lines from the top while they fit and then
 * says how many lines it left out, so nothing is hidden without saying
 * so. A single line longer than the whole budget is cut, ends in `…`,
 * and the note says how many characters of it are missing (a padded
 * `echo <1200 spaces>; rm -rf ~` must not read as a harmless echo).
 *
 * Control characters and bidi overrides are shown as escapes
 * (`\x1b`, `\u202e`), never passed to the terminal or chat: an ANSI
 * sequence in a command (conceal, erase line, cursor up) or a
 * right-to-left override could otherwise make the prompt display
 * something other than what runs.
 */

export interface PreviewExcerptLimits {
  /** Most lines shown, the note line not counted. */
  maxLines: number;
  /** Most characters (UTF-16 units) of preview shown, newlines included. */
  maxChars: number;
}

export interface PreviewExcerpt {
  /** The lines shown, without the note. */
  lines: string[];
  /** Lines of the preview that are not shown at all. */
  hiddenLines: number;
  /** Characters cut from the end of the one line shown, when it was cut. */
  cutChars: number;
}

/**
 * C0/C1 controls other than tab (newlines are split on before this),
 * DEL, and the bidi marks, embeddings, overrides and isolates.
 */
const UNSAFE_DISPLAY_CHARS =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** One line with every character that could rewrite the display escaped. */
export function visiblePreviewLine(line: string): string {
  return line.replace(UNSAFE_DISPLAY_CHARS, (ch) => {
    const code = ch.charCodeAt(0);
    return code <= 0xff
      ? `\\x${code.toString(16).padStart(2, "0")}`
      : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

/** Split a preview into the lines a person reads, controls escaped. */
export function previewLines(preview: string): string[] {
  return preview.replace(/\r\n?/g, "\n").split("\n").map(visiblePreviewLine);
}

export function excerptPreview(
  preview: string,
  limits: PreviewExcerptLimits,
): PreviewExcerpt {
  const all = previewLines(preview);
  const lines: string[] = [];
  let used = 0;
  let cutChars = 0;
  for (const line of all) {
    if (lines.length >= limits.maxLines) break;
    const cost = line.length + (lines.length > 0 ? 1 : 0);
    if (used + cost > limits.maxChars) {
      // Nothing shown yet: show the head of this line rather than an
      // empty preview.
      if (lines.length === 0) {
        const kept = Math.max(0, limits.maxChars - 1);
        lines.push(`${line.slice(0, kept)}…`);
        cutChars = line.length - kept;
      }
      break;
    }
    lines.push(line);
    used += cost;
  }
  return { lines, hiddenLines: all.length - lines.length, cutChars };
}

/**
 * The note under a cut preview, or `null` when all of it is shown:
 * characters cut from the one line shown, then lines not shown at all.
 */
export function hiddenLinesNote(
  hiddenLines: number,
  cutChars = 0,
): string | null {
  const parts: string[] = [];
  if (cutChars > 0) {
    parts.push(`+${cutChars} more ${cutChars === 1 ? "character" : "characters"}`);
  }
  if (hiddenLines > 0) {
    parts.push(`+${hiddenLines} more ${hiddenLines === 1 ? "line" : "lines"}`);
  }
  return parts.length === 0 ? null : `… ${parts.join(", ")}`;
}
