import { createHash } from "node:crypto";

/**
 * Snapshot of a single executed step, fed into the detector after the
 * tool result has been compressed and any side-effects applied to the
 * session (so `worldDigest` reflects the post-step world).
 *
 * For a batched step (N > 1 tool calls in one inference), pass the
 * synthetic call-tuple form: `tool` is the canonical synthetic label
 * `"<batch>"`, and `batchCalls` carries the (tool, args, summary)
 * tuples in batch-index order. Permuting the batch produces a
 * different digest by design — the model may legitimately reorder a
 * set after re-thinking, so we do not flag that as a loop.
 */
export interface LoopObservation {
  tool: string;
  args: unknown;
  resultSummary: string;
  /**
   * Digest of the browser world snapshot after the step. `null` for
   * sessions that have never captured a world (e.g. pure OS sessions).
   * When `null` the detector treats the world as "not changing" — repeats
   * of non-browser tools with identical args and output will still fire.
   */
  worldDigest: string | null;
  /**
   * Optional ordered tuples for a batched step. When set, `tool`/`args`/
   * `resultSummary` are ignored in favour of a composite hash of the
   * full batch (preserving the model's emit order). When unset, the
   * single-call path is used.
   */
  batchCalls?: ReadonlyArray<{
    tool: string;
    args: unknown;
    resultSummary: string;
  }>;
}

/** Synthetic tool name used for the `repeat` verdict on batched steps. */
export const BATCH_LOOP_LABEL = "<batch>";

export type LoopVerdict =
  | { kind: "ok" }
  | {
      kind: "repeat";
      /** How many identical consecutive observations have been seen, including this one. */
      count: number;
      tool: string;
    };

export interface LoopDetectorOptions {
  /**
   * Minimum number of consecutive identical observations that trigger a
   * `repeat` verdict. 3 is the sweet spot: low enough to catch genuine
   * loops early (ref-click spam on GitHub expanded dropdowns), high
   * enough that "click, read_aria, click again" is not flagged.
   */
  threshold?: number;
  /**
   * Upper bound on the ring buffer. Keeps memory predictable during long
   * turns. Default comfortably exceeds the threshold.
   */
  windowSize?: number;
}

interface Entry {
  tool: string;
  argsHash: string;
  resultHash: string;
  worldDigest: string | null;
}

/**
 * Detect "no-progress" loops in an agent turn.
 *
 * A step is considered a *repeat* of the previous step when all of:
 *  - same tool name,
 *  - same canonicalised args (stable JSON → sha1),
 *  - same compressed result summary,
 *  - same browser world digest (or both `null`).
 *
 * When the run of consecutive repeats reaches `threshold`, the detector
 * emits a single `repeat` verdict and resets its run counter. This gives
 * the caller a clear "now inject the hint" signal and avoids re-firing on
 * every subsequent identical step unless the loop breaks and reforms.
 */
export class LoopDetector {
  private readonly threshold: number;
  private readonly windowSize: number;
  private readonly ring: Entry[] = [];
  private runLength = 0;

  constructor(options: LoopDetectorOptions = {}) {
    this.threshold = Math.max(2, options.threshold ?? 3);
    this.windowSize = Math.max(this.threshold, options.windowSize ?? 8);
  }

  observe(step: LoopObservation): LoopVerdict {
    const entry: Entry = step.batchCalls
      ? {
          tool: BATCH_LOOP_LABEL,
          argsHash: hashCanonical(
            step.batchCalls.map((c) => [c.tool, c.args]),
          ),
          resultHash: hashCanonical(
            step.batchCalls.map((c) => c.resultSummary),
          ),
          worldDigest: step.worldDigest,
        }
      : {
          tool: step.tool,
          argsHash: hashCanonical(step.args),
          resultHash: hashString(step.resultSummary),
          worldDigest: step.worldDigest,
        };
    const last = this.ring.at(-1);
    const isRepeat = last !== undefined && entriesEqual(last, entry);
    this.ring.push(entry);
    if (this.ring.length > this.windowSize) {
      this.ring.shift();
    }
    if (!isRepeat) {
      this.runLength = 1;
      return { kind: "ok" };
    }
    this.runLength += 1;
    if (this.runLength >= this.threshold) {
      const count = this.runLength;
      // Full reset: the caller only sees one "fire" per detected run,
      // and the next identical step starts a brand new run from zero.
      // This matches the `inject_hint` policy — one nudge at a time,
      // no rapid re-firing until the model has been given a chance to
      // react.
      this.runLength = 0;
      return { kind: "repeat", count, tool: entry.tool };
    }
    return { kind: "ok" };
  }
}

function entriesEqual(a: Entry, b: Entry): boolean {
  return (
    a.tool === b.tool &&
    a.argsHash === b.argsHash &&
    a.resultHash === b.resultHash &&
    a.worldDigest === b.worldDigest
  );
}

function hashString(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

function hashCanonical(value: unknown): string {
  return hashString(canonicalJson(value));
}

/**
 * Deterministic JSON serialisation: object keys sorted, arrays preserved
 * in order (order is semantically significant for tool args like
 * `modifiers: ["Alt", "Shift"]`), `undefined` omitted.
 */
function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const body = entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(",");
  return `{${body}}`;
}

/**
 * Format a human-readable notice to inject into the next prompt's
 * `### notice` section. Kept here so UI and agent-loop agree on wording.
 */
export function formatRepeatNotice(verdict: {
  count: number;
  tool: string;
}): string {
  return [
    `You called \`${verdict.tool}\` with the same arguments ${verdict.count} times in a row and neither the result nor the world snapshot changed.`,
    `This is a no-progress loop. Change strategy BEFORE calling any tool again:`,
    `- Re-read \`### world\` carefully — the answer may already be on the page.`,
    `- If an element is tagged \`[expanded]\`, it is already open; clicking it again will toggle it closed.`,
    `- Consider a different element, \`browser.scroll\`, or \`browser.navigate\` to a more direct URL (e.g. raw file).`,
    `- If you have enough information already, end the turn with \`reply\`.`,
  ].join("\n");
}
