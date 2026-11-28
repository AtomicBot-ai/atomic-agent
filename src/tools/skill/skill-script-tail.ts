/**
 * The end of a skill script's log, cut to a budget (moved out of
 * `skill-run-script.ts` unchanged; see the comments there for the
 * budget itself).
 */
export interface TrimmedBody {
  text: string;
  /** Something was dropped, so the result must report itself truncated. */
  trimmed: boolean;
}

/**
 * The script body, trimmed to what the budget leaves under the header.
 * We keep the END of it: script output is a log, so the last lines (the
 * failure, the summary, the final state) carry the signal, while the
 * start is setup noise. The trim happens here and not in the compressor
 * because the compressor works on the whole text: its line pass keeps
 * the last N lines, which would eat the `# skill/script` + `exit:`
 * header, and its length pass keeps the head, which would eat a
 * trailing footer instead. Trimming the body first leaves the header
 * intact under either pass, so the exit code always survives.
 */
export function tailScriptBody(body: string, maxChars: number, maxLines: number): TrimmedBody {
  const budget = Math.max(1, maxChars);
  // Count and cut over the non-blank lines only. `extractTail` deletes
  // blank lines from whatever we hand it, right after this banner is
  // written, so counting them here would state a number the model
  // cannot reconcile with what it received, and it also disposes of
  // the empty element that output ending in a newline splits into.
  const lines = body.split("\n").filter((line) => line.trim().length > 0);
  const whole = lines.join("\n");
  const keptLines =
    lines.length > maxLines ? lines.slice(-maxLines) : lines;
  const kept = keptLines.join("\n");
  if (kept.length <= budget) {
    if (keptLines.length === lines.length) {
      return { text: body, trimmed: false };
    }
    const dropped = lines.length - keptLines.length;
    return {
      text: banner(dropped, whole.length - kept.length, kept),
      trimmed: true,
    };
  }
  // Cut on a line boundary: a body that starts mid-line reads as
  // corrupt output, and a half line would also have to be counted.
  const cut = kept.slice(kept.length - budget);
  const firstBreak = cut.indexOf("\n");
  if (firstBreak === -1) {
    // A single line longer than the whole budget: there is no boundary
    // to cut on, so the line-boundary promise above cannot be kept.
    // Say that, rather than report a cut through the middle of a token
    // as "0 earlier lines" of loss.
    const earlier = lines.length - 1;
    const lastLine = lines[lines.length - 1] ?? "";
    const also = earlier > 0 ? `, along with ${earlier} earlier lines` : "";
    return {
      text:
        `… [one line is longer than this result's budget: its first ` +
        `${lastLine.length - cut.length} characters are omitted${also}]\n${cut}`,
      trimmed: true,
    };
  }
  const tail = cut.slice(firstBreak + 1);
  // Count the lines actually gone, both passes together: the character
  // pass drops whole lines of its own, so a banner counting only the
  // line pass states a number that is not true.
  return {
    text: banner(
      lines.length - tail.split("\n").length,
      whole.length - tail.length,
      tail,
    ),
    trimmed: true,
  };
}

function banner(lines: number, chars: number, kept: string): string {
  return `… [omitted ${lines} earlier lines, ${chars} characters]\n${kept}`;
}
