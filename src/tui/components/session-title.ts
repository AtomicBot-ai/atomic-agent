/**
 * A session preview — the thread's first user prompt, stored verbatim —
 * rendered as one line of at most `max` cells.
 *
 * Verbatim is the point: the preview has to keep the prompt as it was
 * typed, because the session picker's search and the delete dialog's
 * "is this the thread I mean?" both read it. Every *display* of it,
 * though, sits in a fixed-height row, and Ink honours a `\n` inside a
 * `<Text>` by growing that row — a pasted prompt turns a one-row bar
 * into an N-row one and reflows everything below it.
 *
 * So the newlines collapse to spaces rather than being cut at the first
 * one: the rail already renders previews this way, and a title that
 * agrees with the rail is worth more than the handful of extra
 * characters a first-line-only rule would save.
 */
export function sessionTitleLine(preview: string, max: number): string {
  const oneLine = preview.replace(/\s+/g, " ").trim();
  if (max <= 0 || oneLine.length === 0) return "";
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, Math.max(1, max - 1))}…`;
}
