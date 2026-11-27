/**
 * A byte-capped capture of one stream that keeps the head and the tail.
 *
 * A command that runs for an hour writes more than any tool result can
 * carry; what the model needs is how it started (the command echo, the
 * first error) and how it is going (the last lines). So the first
 * `headShare` of the cap is kept verbatim, the rest is a window over
 * the newest bytes, and the middle is dropped with a marker saying how
 * much. Used by `startCommandJob` for a job's stdout and stderr.
 *
 * A secret resolved from a reference (ATO-476) that straddles the cut
 * would leave a piece on each side, and a piece is not matched by the
 * exact-value masking applied to the result later; so those pieces are
 * replaced here.
 */
import { resolvedSecretValues } from "./resolved-secret-values.js";

/** Shortest piece of a secret worth hiding at the cut. */
const MIN_CUT_FRAGMENT = 4;

/**
 * `head` and `tail` with a trailing start of a known secret (in `head`)
 * and a leading end of one (in `tail`) replaced by a marker. Whole
 * secrets are left to the later masking.
 */
export function hideSecretPiecesAtCut(
  head: string,
  tail: string,
  secrets: readonly { label: string; value: string }[] = resolvedSecretValues(),
): [string, string] {
  let h = head;
  let t = tail;
  for (const { label, value } of secrets) {
    const marker = `[redacted:${label.replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 64) || "secret"}]`;
    for (let n = value.length - 1; n >= MIN_CUT_FRAGMENT; n--) {
      if (h.endsWith(value.slice(0, n))) {
        h = h.slice(0, h.length - n) + marker;
        break;
      }
    }
    for (let n = value.length - 1; n >= MIN_CUT_FRAGMENT; n--) {
      if (t.startsWith(value.slice(value.length - n))) {
        t = marker + t.slice(n);
        break;
      }
    }
  }
  return [h, t];
}

export interface CappedOutputSnapshot {
  /** Head, a drop marker when anything was dropped, then the tail. */
  text: string;
  /** Every byte the stream produced, dropped ones included. */
  bytes: number;
  droppedBytes: number;
  /** `droppedBytes > 0`. */
  truncated: boolean;
}

export class CappedOutput {
  private readonly headCap: number;
  private readonly tailCap: number;
  private readonly head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private droppedBytes = 0;
  private totalBytes = 0;

  /**
   * `maxBytes` bounds head + tail together; `headShare` (default a
   * quarter) is the part of it kept from the start of the stream.
   */
  constructor(maxBytes: number, headShare = 0.25) {
    const cap = Math.max(0, Math.floor(maxBytes));
    this.headCap = Math.floor(cap * Math.min(1, Math.max(0, headShare)));
    this.tailCap = cap - this.headCap;
  }

  append(chunk: Buffer): void {
    this.totalBytes += chunk.length;
    let rest = chunk;
    if (this.headBytes < this.headCap) {
      const take = Math.min(rest.length, this.headCap - this.headBytes);
      this.head.push(rest.subarray(0, take));
      this.headBytes += take;
      rest = rest.subarray(take);
    }
    if (rest.length === 0) return;
    this.tail.push(rest);
    this.tailBytes += rest.length;
    // Drop from the front of the tail until it fits: whole chunks while
    // they are wholly over, then a slice of the first survivor.
    while (this.tailBytes > this.tailCap && this.tail.length > 0) {
      const first = this.tail[0]!;
      const over = this.tailBytes - this.tailCap;
      if (first.length <= over) {
        this.tail.shift();
        this.tailBytes -= first.length;
        this.droppedBytes += first.length;
      } else {
        this.tail[0] = first.subarray(over);
        this.tailBytes -= over;
        this.droppedBytes += over;
      }
    }
  }

  snapshot(): CappedOutputSnapshot {
    let headText = Buffer.concat(this.head).toString("utf8");
    let tailText = Buffer.concat(this.tail).toString("utf8");
    if (this.droppedBytes > 0) [headText, tailText] = hideSecretPiecesAtCut(headText, tailText);
    const text =
      this.droppedBytes > 0
        ? `${headText}\n… [${this.droppedBytes.toLocaleString("en-US")} bytes dropped]\n${tailText}`
        : headText + tailText;
    return {
      text,
      bytes: this.totalBytes,
      droppedBytes: this.droppedBytes,
      truncated: this.droppedBytes > 0,
    };
  }
}
