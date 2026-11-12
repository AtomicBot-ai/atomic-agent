/**
 * Reads only the bytes appended to a watched log since the last look
 * (ATO-441), so a `contains` trigger matches new lines and never fires
 * again on old ones.
 *
 * Per file it keeps the byte offset just past the last complete line it
 * has seen. A partial last line stays unread until its newline arrives.
 * A file that got shorter was truncated or rotated: reading restarts at
 * 0. More than `maxReadBytes` of new data only reads the tail end (the
 * first, cut line is dropped), so a log that jumped by a gigabyte costs
 * one bounded read.
 */
export interface FileTriggerReader {
  /** Bytes `[start, end)` of the file. */
  readRange(path: string, start: number, end: number): Promise<Buffer>;
}

export const TAIL_MAX_READ_BYTES = 1024 * 1024;
export const TAIL_MAX_LINES = 20;
export const TAIL_MAX_LINE_CHARS = 500;

export class LogTail {
  private readonly offsets = new Map<string, number>();

  constructor(
    private readonly reader: FileTriggerReader,
    private readonly maxReadBytes: number = TAIL_MAX_READ_BYTES,
  ) {}

  /** Remember a file's current size: what is there now counts as seen. */
  seed(path: string, size: number): void {
    this.offsets.set(path, size);
  }

  forget(path: string): void {
    this.offsets.delete(path);
  }

  has(path: string): boolean {
    return this.offsets.has(path);
  }

  /**
   * New complete lines containing `contains`, at most `TAIL_MAX_LINES`,
   * each cut to `TAIL_MAX_LINE_CHARS`. A file never seen before is read
   * from the start (it appeared after the watcher did).
   */
  async readNewMatches(path: string, size: number, contains: string): Promise<string[]> {
    let start = this.offsets.get(path) ?? 0;
    if (size < start) start = 0;
    if (size === start) {
      this.offsets.set(path, start);
      return [];
    }
    const skipped = size - start > this.maxReadBytes;
    const from = skipped ? size - this.maxReadBytes : start;
    const buf = await this.reader.readRange(path, from, size);
    const lastNewline = buf.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      // No complete line yet; past the read cap there never will be one
      // worth waiting for, so skip what is there.
      this.offsets.set(path, skipped ? size : start);
      return [];
    }
    this.offsets.set(path, from + lastNewline + 1);
    const lines = buf.subarray(0, lastNewline).toString("utf8").split("\n");
    if (skipped) lines.shift();
    const matches: string[] = [];
    for (const raw of lines) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (!line.includes(contains)) continue;
      matches.push(line.length > TAIL_MAX_LINE_CHARS ? `${line.slice(0, TAIL_MAX_LINE_CHARS)}…` : line);
      if (matches.length >= TAIL_MAX_LINES) break;
    }
    return matches;
  }
}
