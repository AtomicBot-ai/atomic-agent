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
 * so. A single line longer than the whole budget is cut and ends in `…`.
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
}

/** Split a preview into the lines a person reads. */
export function previewLines(preview: string): string[] {
  return preview.replace(/\r\n?/g, "\n").split("\n");
}

export function excerptPreview(
  preview: string,
  limits: PreviewExcerptLimits,
): PreviewExcerpt {
  const all = previewLines(preview);
  const lines: string[] = [];
  let used = 0;
  for (const line of all) {
    if (lines.length >= limits.maxLines) break;
    const cost = line.length + (lines.length > 0 ? 1 : 0);
    if (used + cost > limits.maxChars) {
      // Nothing shown yet: show the head of this line rather than an
      // empty preview.
      if (lines.length === 0) {
        lines.push(`${line.slice(0, Math.max(0, limits.maxChars - 1))}…`);
      }
      break;
    }
    lines.push(line);
    used += cost;
  }
  return { lines, hiddenLines: all.length - lines.length };
}

/** The note under a cut preview, or `null` when every line is shown. */
export function hiddenLinesNote(hiddenLines: number): string | null {
  if (hiddenLines <= 0) return null;
  return `… +${hiddenLines} more ${hiddenLines === 1 ? "line" : "lines"}`;
}
