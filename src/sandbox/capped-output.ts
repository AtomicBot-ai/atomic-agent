/**
 * A byte-capped capture of one stream that keeps the head and the tail.
 *
 * A command that runs for an hour writes more than any tool result can
 * carry; what the model needs is how it started (the command echo, the
 * first error) and how it is going (the last lines). So the first
 * `headShare` of the cap is kept verbatim, the rest is a window over
 * the newest bytes, and the middle is dropped with a marker saying how
 * much. Used by `startCommandJob` for a job's stdout and stderr.
 */

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
    const headText = Buffer.concat(this.head).toString("utf8");
    const tailText = Buffer.concat(this.tail).toString("utf8");
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
