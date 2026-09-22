const DIFF_MAX_LINES = 40;
const PREVIEW_MAX_LEN = 800;

/**
 * What `os.fs.edit` hands `compressToolResult` so the diff it just built
 * survives as built.
 *
 * `renderUnifiedDiff` emits two header lines plus at most
 * `DIFF_MAX_LINES` body lines and, when it clips, one
 * `… [diff truncated]` marker — 43 lines is everything this module can
 * produce. The compressor's 12-line default re-cuts that to its *tail*,
 * which for a diff throws away the `--- a/…` / `+++ b/…` headers that
 * say which file changed and keeps only the last few `+` lines: the one
 * result where both ends carry meaning is the one the default mangles
 * worst.
 */
export const DIFF_SUMMARY_MAX_LINES = DIFF_MAX_LINES + 3;

/**
 * The character budget for those 43 lines. Measured against this repo: a
 * full-length 43-line diff of its own TypeScript is ~1.7 KB, and its
 * lines are capped at 80 columns by the formatter, so 4000 leaves better
 * than 2× headroom for wider sources. It stays well under the 8000-char
 * `TOOL_RESULT_RENDER_CAP_CHARS` that `conversation-turn.ts` applies to
 * every tool result at render time — a cap above that would be dead on
 * arrival, and one anywhere near it would charge the packed transcript
 * ~2.2K tokens for a diff that costs ~480.
 */
export const DIFF_SUMMARY_MAX_CHARS = 4_000;

/**
 * Minimal unified diff, capped at DIFF_MAX_LINES total lines. We avoid a
 * full LCS algorithm: the edit is a single substring replacement, so the
 * diff is well approximated by a simple before/after line listing around
 * the changed region.
 */
export function renderUnifiedDiff(
  before: string,
  after: string,
  path: string,
): string {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const firstDiff = findFirstDiffLine(beforeLines, afterLines);
  if (firstDiff === -1) return "";
  const contextBefore = 2;
  const contextAfter = 2;
  const head = Math.max(0, firstDiff - contextBefore);
  const lastDiffBefore = findLastDiffLine(beforeLines, afterLines);
  const lastDiffAfter = findLastDiffLineFromEnd(beforeLines, afterLines);
  const tailBefore = Math.min(
    beforeLines.length - 1,
    lastDiffBefore + contextAfter,
  );

  const segments: string[] = [];
  segments.push(`--- a/${path}`);
  segments.push(`+++ b/${path}`);
  for (
    let i = head;
    i <= Math.min(beforeLines.length - 1, tailBefore) && i < firstDiff;
    i++
  ) {
    segments.push(` ${beforeLines[i]}`);
  }
  for (let i = firstDiff; i <= lastDiffBefore; i++) {
    segments.push(`-${beforeLines[i] ?? ""}`);
  }
  for (let i = firstDiff; i <= lastDiffAfter; i++) {
    segments.push(`+${afterLines[i] ?? ""}`);
  }
  for (
    let i = Math.max(lastDiffBefore + 1, firstDiff);
    i <= tailBefore && i < beforeLines.length;
    i++
  ) {
    segments.push(` ${beforeLines[i]}`);
  }
  if (segments.length > DIFF_MAX_LINES + 2) {
    return (
      segments.slice(0, DIFF_MAX_LINES + 2).join("\n") + "\n… [diff truncated]"
    );
  }
  return segments.join("\n");
}

function findFirstDiffLine(before: string[], after: string[]): number {
  const limit = Math.min(before.length, after.length);
  for (let i = 0; i < limit; i++) {
    if (before[i] !== after[i]) return i;
  }
  if (before.length !== after.length) return limit;
  return -1;
}

function findLastDiffLine(before: string[], after: string[]): number {
  // Returns the last index in `before` that differs from `after` (walking
  // from the end). Treats missing indices as different.
  const len = Math.max(before.length, after.length);
  for (
    let i = before.length - 1, j = after.length - 1;
    i >= 0 && j >= 0;
    i--, j--
  ) {
    if (before[i] !== after[j]) return i;
  }
  if (before.length < after.length) return -1;
  return before.length - 1 - (len - Math.max(before.length, after.length));
}

function findLastDiffLineFromEnd(before: string[], after: string[]): number {
  for (
    let i = after.length - 1, j = before.length - 1;
    i >= 0 && j >= 0;
    i--, j--
  ) {
    if (after[i] !== before[j]) return i;
  }
  if (after.length > before.length) return after.length - 1;
  return -1;
}

/** The approval-prompt preview: the diff, clipped. */
export function clampDiffPreview(text: string): string {
  if (text.length <= PREVIEW_MAX_LEN) return text;
  return text.slice(0, PREVIEW_MAX_LEN - 15) + "\n… [truncated]";
}
