/**
 * Makes a still-streaming reply safe to lex as markdown: the unfinished
 * end of the text gets its open inline markup closed (or dropped), so the
 * renderer shows `bold` instead of a literal `**bold` that turns into
 * bold only when the turn ends, and the layout does not jump.
 *
 * Only the last block can still be growing, so only the text after the
 * last blank line (and after the last closed code fence) is touched. Inside an unclosed ``` fence nothing is
 * touched: the lexer already treats the rest of the text as code.
 *
 * What is repaired, at the end of that block:
 *   - an open code span: closed with the same number of backticks;
 *   - open `**`, `*` and `~~`: closed in reverse order of opening;
 *   - a half-written link, `[label` or `[label](https://par`: shown as
 *     the label until the link is complete.
 * An opener with nothing after it yet (`hello **`) is dropped rather
 * than closed, because an empty `****` would render literally.
 * Underscore emphasis is left alone: `snake_case` words are far more
 * common in agent replies than `_italic_`, and a wrong guess shows.
 *
 * Pure, and applied to the rendered copy only: the stored text is never
 * changed, and the final reply is rendered without it.
 */

const FENCE = /^ {0,3}(```|~~~)/gm;

export function closeStreamingMarkdown(text: string): string {
  if (text.length === 0) return text;
  const fences = [...text.matchAll(FENCE)];
  if (fences.length % 2 === 1) return text;
  const cut = text.lastIndexOf("\n\n");
  let start = cut === -1 ? 0 : cut + 2;
  // A closed fence above the last blank line must not leak into the
  // tail: its code (`*args`, `**kwargs`, the ``` lines) is not markup.
  const lastFence = fences[fences.length - 1];
  if (lastFence?.index !== undefined) {
    const eol = text.indexOf("\n", lastFence.index);
    start = Math.max(start, eol === -1 ? text.length : eol + 1);
  }
  const head = text.slice(0, start);
  const tail = text.slice(start);
  return head + repairTail(dropPartialLink(tail));
}

/** `[label` or `[label](partial-url` at the very end → `label`. */
function dropPartialLink(tail: string): string {
  return tail
    .replace(/!?\[([^\]\n]*)\]\([^)\s]*$/, "$1")
    .replace(/!?\[([^\]\n]*)$/, "$1");
}

interface Opener {
  readonly marker: string;
  readonly at: number;
}

const isSpace = (ch: string | undefined): boolean =>
  ch === undefined || /\s/.test(ch);

function repairTail(tail: string): string {
  const stack: Opener[] = [];
  let openCode: Opener | null = null;
  let i = 0;
  while (i < tail.length) {
    const ch = tail[i]!;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") {
      const run = runLength(tail, i, "`");
      const marker = "`".repeat(run);
      const close = tail.indexOf(marker, i + run);
      if (close === -1) {
        openCode = { marker, at: i };
        break;
      }
      i = close + run;
      continue;
    }
    if (ch === "*" || ch === "~") {
      const run = runLength(tail, i, ch);
      const atLineStart = i === 0 || tail[i - 1] === "\n";
      // `* item` is a list bullet, not emphasis.
      if (ch === "*" && run === 1 && atLineStart && tail[i + 1] === " ") {
        i += 1;
        continue;
      }
      // A `***` run is `**` plus `*`, each at its own offset so the drop
      // pass can remove them one by one; it closes whichever of the two
      // is innermost first.
      const markers: Opener[] =
        ch === "~"
          ? run >= 2
            ? [{ marker: "~~", at: i }]
            : []
          : run >= 3
            ? stack[stack.length - 1]?.marker === "*"
              ? [{ marker: "*", at: i }, { marker: "**", at: i + 1 }]
              : [{ marker: "**", at: i }, { marker: "*", at: i + 2 }]
            : [{ marker: ch.repeat(run), at: i }];
      for (const { marker, at } of markers) {
        const top = stack[stack.length - 1];
        if (top?.marker === marker && !isSpace(tail[i - 1])) {
          stack.pop();
        } else if (i + run === tail.length || !isSpace(tail[i + run])) {
          // At the very end it may still become an opener: keep it on
          // the stack so the drop pass below removes it.
          stack.push({ marker, at });
        }
      }
      i += run;
      continue;
    }
    i += 1;
  }
  let body = tail;
  const open: Opener[] = openCode === null ? [...stack] : [...stack, openCode];
  // Drop openers that nothing follows yet, newest first.
  while (open.length > 0) {
    const last = open[open.length - 1]!;
    if (body.slice(last.at + last.marker.length).trim().length > 0) break;
    body = body.slice(0, last.at);
    open.pop();
  }
  if (open.length === 0) return body;
  const trimmed = body.trimEnd();
  const closers = open
    .slice()
    .reverse()
    .map((o) => o.marker)
    .join("");
  return trimmed + closers;
}

function runLength(text: string, from: number, ch: string): number {
  let n = 0;
  while (text[from + n] === ch) n += 1;
  return n;
}
