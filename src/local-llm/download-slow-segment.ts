import { StalledError } from "./download-errors.js";

/**
 * Pace check for one connection among several. The stall watchdog only
 * fires on silence and is re-armed by every chunk, so a connection the
 * CDN throttles to a few hundred bytes a second is never "stalled" —
 * and while the rest of the file is on disk, that one connection is the
 * whole download. Measured on a 2.7 GB GGUF: fifteen slices landed, the
 * sixteenth sat on a 116 MB remainder at ~400 B/s, while a fresh
 * connection to the same URL ran at 1.9 MB/s.
 *
 * A connection is slow when, over one window, it moved less than
 * `1 / SLOW_SEGMENT_RATIO` of the best rate any connection of this
 * download reached, and under `SLOW_SEGMENT_CEILING_BPS`. Both, so a
 * link that is slow everywhere (every connection equally slow) and a
 * connection that is merely slower than a very fast peer are left alone.
 * A window with no bytes at all is not judged: silence is the stall
 * watchdog's call, and an outage is not a slow connection. A slow
 * connection is dropped and its remainder asked for again on a new one —
 * the bytes it wrote stay.
 */
export const DEFAULT_SLOW_CHECK_MS = 30_000;
export const SLOW_SEGMENT_RATIO = 8;
export const SLOW_SEGMENT_CEILING_BPS = 256 * 1024;
/**
 * Reconnects in a row that did not help, after which a segment is no
 * longer judged. A reconnect helped when the new connection had at
 * least one window that was not slow before it slowed down again — a CDN
 * that throttles every connection after a fast start is then worked
 * around indefinitely, while a remainder that is slow on every new
 * connection (the link, or a peak no connection can reach again) costs
 * at most this many requests.
 */
export const MAX_SLOW_RECONNECTS = 3;

/** The best per-connection rate seen by one download attempt. */
export interface PaceRecord {
  peakBps: number;
}

export class SlowSegmentError extends StalledError {
  constructor(
    readonly bps: number,
    readonly peakBps: number,
    /** The connection had a window that was not slow before this one. */
    readonly helped: boolean,
  ) {
    super(0);
    this.name = "SlowSegmentError";
    this.message = `Download connection too slow: ${formatBps(bps)} against ${formatBps(peakBps)} on the fastest one; reconnecting`;
  }
}

function formatBps(bps: number): string {
  if (bps >= 1024 * 1024) return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
  if (bps >= 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${Math.round(bps)} B/s`;
}

/**
 * Fold one window into the record and say whether it was slow. The
 * window is recorded first, so a connection is never measured against
 * a peak it did not have the chance to set itself.
 */
export function judgeWindow(
  bytes: number,
  elapsedMs: number,
  pace: PaceRecord,
): { slow: boolean; bps: number } {
  if (bytes <= 0 || elapsedMs <= 0) return { slow: false, bps: 0 };
  const bps = (bytes * 1000) / elapsedMs;
  if (bps > pace.peakBps) pace.peakBps = bps;
  const slow =
    bps < SLOW_SEGMENT_CEILING_BPS && bps * SLOW_SEGMENT_RATIO < pace.peakBps;
  return { slow, bps };
}

/**
 * Watch `written()` every `windowMs` and call `onSlow` once when a
 * window is slow. Windows are measured on the clock, not assumed to be
 * `windowMs` long: a late timer on a busy event loop would otherwise
 * read as a burst and raise the peak. Returns the stop function; the
 * timer never holds the process open.
 *
 * Stopping folds the connection's average rate into the record. On a
 * fast link the healthy slices land before the first window closes, and
 * without this the one throttled connection left behind would only ever
 * be compared with itself. A run shorter than `min(windowMs, 1 s)` is too
 * short to say anything and is left out.
 */
export function watchSegmentPace(
  written: () => number,
  windowMs: number,
  pace: PaceRecord,
  onSlow: (error: SlowSegmentError) => void,
): () => void {
  const startedAt = Date.now();
  const startBytes = written();
  let lastAt = startedAt;
  let last = startBytes;
  let helped = false;
  const timer = setInterval(() => {
    const at = Date.now();
    const now = written();
    const { slow, bps } = judgeWindow(now - last, at - lastAt, pace);
    lastAt = at;
    last = now;
    if (!slow) {
      if (bps > 0) helped = true;
      return;
    }
    clearInterval(timer);
    onSlow(new SlowSegmentError(bps, pace.peakBps, helped));
  }, windowMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    const elapsed = Date.now() - startedAt;
    if (elapsed < Math.min(windowMs, 1_000)) return;
    const bps = ((written() - startBytes) * 1000) / elapsed;
    if (bps > pace.peakBps) pace.peakBps = bps;
  };
}
