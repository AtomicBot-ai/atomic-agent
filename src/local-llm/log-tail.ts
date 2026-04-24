import { closeSync, openSync, readSync, statSync } from "node:fs";

/**
 * Read the tail of a file up to `maxBytes` from the end. Returns the raw
 * bytes decoded as UTF-8 (partial first line is acceptable — callers are
 * expected to display the tail verbatim as `llama-server` log output).
 *
 * Designed to be cheap enough to call on a 1s polling loop: a single
 * `stat` + `open` + `read` pair with a bounded buffer, no streams.
 */
export interface LogTailResult {
  text: string;
  size: number;
  truncated: boolean;
}

export function readLogTail(path: string, maxBytes = 16_384): LogTailResult {
  const s = statSync(path);
  const size = s.size;
  const start = Math.max(0, size - maxBytes);
  const len = size - start;
  if (len <= 0) {
    return { text: "", size, truncated: false };
  }
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    return {
      text: buf.toString("utf-8"),
      size,
      truncated: start > 0,
    };
  } finally {
    closeSync(fd);
  }
}
