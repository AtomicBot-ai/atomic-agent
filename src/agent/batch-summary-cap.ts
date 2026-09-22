import {
  capReadSummary,
  readStartLineOf,
} from "../session/conversation-turn.js";

/**
 * Smallest share any one result is cut to. A very wide batch would
 * otherwise leave each result a few dozen chars, so the cap is soft: past
 * `capChars / MIN_SHARE_CHARS` results the batch may exceed it rather than
 * hand the model unreadable stubs.
 */
const MIN_SHARE_CHARS = 600;

/**
 * Fit the summaries of one batched step into `capChars` without erasing
 * any of them. Every result gets an equal share, and results shorter than
 * their share hand the rest to the others (water-filling). A result over
 * its share keeps its head and says what was left out and how to get it;
 * a file read is cut on a line boundary and names the `offset` of the rest.
 *
 * The pass this replaces trimmed from the oldest result until the total
 * fitted, so a batch of file reads turned its first files into a bare
 * `[truncated]` — no path, no content, no way forward. A fusion worker
 * re-read the same five files three times in a row trying to see them.
 */
export function capBatchSummaries(
  results: readonly { tool: string; summary: string }[],
  calls: readonly { args?: Record<string, unknown> }[],
  capChars: number,
): string[] {
  const total = results.reduce((acc, r) => acc + r.summary.length, 0);
  if (total <= capChars) return results.map((r) => r.summary);
  const share = fairShare(
    results.map((r) => r.summary.length),
    capChars,
  );
  return results.map((r, i) => {
    if (r.summary.length <= share) return r.summary;
    if (r.tool === "os.fs.read") {
      return capReadSummary(
        r.summary,
        share,
        readStartLineOf(calls[i]?.args ?? {}),
      );
    }
    return clipToShare(r.summary, share, capChars);
  });
}

/**
 * Largest per-result allowance whose capped total fits `capChars`, never
 * below {@link MIN_SHARE_CHARS}.
 */
export function fairShare(
  lengths: readonly number[],
  capChars: number,
): number {
  const sorted = [...lengths].sort((a, b) => a - b);
  let remaining = capChars;
  for (let i = 0; i < sorted.length; i += 1) {
    const even = Math.floor(remaining / (sorted.length - i));
    if (sorted[i]! > even) return Math.max(MIN_SHARE_CHARS, even);
    remaining -= sorted[i]!;
  }
  return Math.max(MIN_SHARE_CHARS, sorted[sorted.length - 1] ?? 0);
}

/**
 * Clip one over-share result and say what was dropped and how to get it.
 *
 * The marker used to offer only "ask for less per step", which fits a wide
 * batch but not the case that actually hits this cap most often: a single
 * listing or search call returning far too much. There the number of calls
 * is already one and the only lever is the call's own bound, so the model
 * was pointed at a knob it could not turn. Name both levers instead, and
 * keep the sentence short — the marker is spent out of the same budget as
 * the result, so every char of advice is a char of content dropped.
 */
function clipToShare(summary: string, share: number, capChars: number): string {
  const marker = (hidden: number) =>
    `\n… [${hidden} more chars not shown: this step's results share a ${capChars}-char budget. To see more: fewer calls per step, or a tighter \`limit\`/narrower path on this call.]`;
  const keep = Math.max(1, share - marker(summary.length).length);
  return `${summary.slice(0, keep)}${marker(summary.length - keep)}`;
}
