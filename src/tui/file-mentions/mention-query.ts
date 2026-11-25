/**
 * Where the `@` the operator is typing sits in the composer buffer.
 *
 * The palette follows the token at the END of the buffer: that is where
 * the caret is while someone types `@src/ap`, and the app shell does not
 * see the editor's caret. A mention starts at the start of the buffer or
 * after whitespace, so `me@example.com` never opens the palette.
 */

export interface ActiveMention {
  /** Index of the `@` in the buffer. */
  start: number;
  /** What follows the `@`, up to the end of the buffer. */
  query: string;
}

const TRAILING_MENTION = /(^|\s)@([^\s@]*)$/;

/** The mention being typed at the end of `buffer`, or `null`. */
export function activeMention(buffer: string): ActiveMention | null {
  const match = TRAILING_MENTION.exec(buffer);
  if (!match) return null;
  const lead = match[1] ?? "";
  return { start: match.index + lead.length, query: match[2] ?? "" };
}

/**
 * Replace the trailing mention with the chosen path. The trailing space
 * closes the token, so the palette steps aside and the next word starts
 * clean.
 */
export function completeMention(
  buffer: string,
  mention: ActiveMention,
  path: string,
): string {
  return `${buffer.slice(0, mention.start)}@${path} `;
}
