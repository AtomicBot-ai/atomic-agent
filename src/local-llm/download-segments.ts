import type { FileHandle } from "node:fs/promises";

import {
  createAbortError,
  DownloadHttpError,
  isRetryableDownloadError,
  parseContentRange,
  RangeRejectedError,
  RangesUnsupportedError,
  sleep,
  StalledError,
  validatorsMatch,
} from "./download-errors.js";
import { sumRanges, type ByteRange } from "./download-partial.js";

/**
 * One slice of the file a single connection is responsible for. `end`
 * is exclusive and `Infinity` when the server declared no length (one
 * open-ended stream). `written` counts bytes on disk from `start`.
 */
export interface Segment {
  start: number;
  end: number;
  written: number;
}

export interface SegmentRetryInfo {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  error: Error;
}

/** Everything a segment worker needs; owned by the attempt. */
export interface SegmentContext {
  url: string;
  /** Base request headers (User-Agent, Authorization). */
  headers: Record<string, string>;
  /** What the lead response reported; every segment must match it. */
  validators: { etag: string | null; lastModified: string | null };
  total: number;
  handle: FileHandle;
  /** Fires when the attempt as a whole is over — cancel or fatal error. */
  attemptSignal: AbortSignal;
  /**
   * Whether a failed segment may re-request its remainder on its own.
   * `false` for the one-stream case, where the attempt-level retry keeps
   * the long-standing semantics (one retry per attempt).
   */
  retryInPlace: boolean;
  stallTimeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
  maxRetryDelayMs: number;
  onBytes: () => void;
  onRetry?: (info: SegmentRetryInfo) => void;
}

/**
 * Split the missing byte ranges into up to `connections` pieces of at
 * least `minSegmentBytes`. Small remainders stay one stream: the
 * per-request overhead would eat the gain, and a segment plan that
 * starts at the first hole keeps the lead request usable as piece 0.
 */
export function planSegments(
  holes: readonly ByteRange[],
  connections: number,
  minSegmentBytes: number,
): Segment[] {
  const asSegment = ([start, end]: ByteRange): Segment => ({ start, end, written: 0 });
  const finite = holes.every(([, end]) => Number.isFinite(end));
  if (connections <= 1 || !finite) return holes.map(asSegment);
  const remaining = sumRanges(holes);
  if (remaining < 2 * minSegmentBytes) return holes.map(asSegment);
  const pieceSize = Math.max(minSegmentBytes, Math.ceil(remaining / connections));
  const out: Segment[] = [];
  for (const [start, end] of holes) {
    for (let at = start; at < end; at += pieceSize) {
      out.push({ start: at, end: Math.min(at + pieceSize, end), written: 0 });
    }
  }
  return out;
}

/** A connection-local abort that also fires when the attempt ends. */
export function linkedAbort(parent: AbortSignal): AbortController {
  const controller = new AbortController();
  if (parent.aborted) controller.abort();
  else parent.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}

/**
 * Ask for the bytes `seg` still lacks. A `206` whose `Content-Range`
 * starts where we stopped, with unchanged validators, is the only good
 * answer; a `200` means ranges are not honoured after all; anything else
 * that names a different file makes the partial worthless.
 */
export async function requestSegment(
  seg: Segment,
  ctx: SegmentContext,
  abort: AbortController,
): Promise<Response> {
  const from = seg.start + seg.written;
  const headers: Record<string, string> = {
    ...ctx.headers,
    Range: `bytes=${from}-${Number.isFinite(seg.end) ? seg.end - 1 : ""}`,
  };
  const validator = ctx.validators.etag ?? ctx.validators.lastModified;
  if (validator) headers["If-Range"] = validator;

  const res = await fetch(ctx.url, {
    headers,
    redirect: "follow",
    signal: abort.signal,
  });
  if (res.status === 200) {
    await res.body?.cancel().catch(() => undefined);
    throw new RangesUnsupportedError();
  }
  if (res.status === 416) {
    throw new RangeRejectedError(`server refused range ${headers.Range}`);
  }
  if (res.status !== 206 || !res.body) {
    throw new DownloadHttpError(res.status, res.statusText);
  }
  const cr = parseContentRange(res.headers.get("content-range"));
  const totalMismatch = ctx.total > 0 && cr !== null && cr.total > 0 && cr.total !== ctx.total;
  if (!cr || cr.start !== from || totalMismatch || !validatorsMatch(ctx.validators, res)) {
    await res.body.cancel().catch(() => undefined);
    throw new RangeRejectedError("server range did not match the partial file");
  }
  return res;
}

/**
 * Copy `res`'s body into the file at `seg`'s offsets. Stops at the
 * segment boundary and cancels the rest of the body — the lead request
 * is open-ended, so its stream would otherwise run to the end of the
 * file. A body that closes short of a finite boundary is a retryable
 * failure; the bytes it did deliver stay counted.
 */
export async function streamIntoSegment(
  res: Response,
  seg: Segment,
  ctx: SegmentContext,
  abort: AbortController,
): Promise<void> {
  if (!res.body) throw new DownloadHttpError(res.status, "empty body");
  let stalled = false;
  let stallTimer: NodeJS.Timeout | null = null;
  const armStallTimer = (): void => {
    if (ctx.stallTimeoutMs <= 0) return;
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled = true;
      abort.abort();
    }, ctx.stallTimeoutMs);
  };
  const reader = res.body.getReader();
  const aborted = new Promise<never>((_resolve, reject) => {
    const fail = (): void => reject(createAbortError());
    if (abort.signal.aborted) fail();
    else abort.signal.addEventListener("abort", fail, { once: true });
  });
  // Never awaited on its own: an abort must not wait for a source that
  // has stopped answering.
  aborted.catch(() => undefined);

  try {
    armStallTimer();
    for (;;) {
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await Promise.race([reader.read(), aborted]);
        // A chunk that was already queued can win the race against an
        // abort that fired during the previous write. Nothing is
        // written past a cancel: the partial ends exactly where the
        // caller stopped it.
        if (abort.signal.aborted) throw createAbortError();
      } catch (err) {
        reader.cancel().catch(() => undefined);
        if (ctx.attemptSignal.aborted) throw createAbortError();
        if (stalled) throw new StalledError(ctx.stallTimeoutMs);
        throw err instanceof Error ? err : new Error(String(err));
      }
      if (next.done) break;
      armStallTimer();
      const room = seg.end - (seg.start + seg.written);
      const chunk = next.value.byteLength > room ? next.value.subarray(0, room) : next.value;
      if (chunk.byteLength > 0) {
        // Chunks are written one at a time with an explicit position
        // rather than piped through a WriteStream: a pipeline that fails
        // destroys its destination and drops whatever it had buffered,
        // which is exactly the tail the next attempt needs on disk. Here
        // a chunk is either fully written or never counted.
        const { bytesWritten } = await ctx.handle.write(
          chunk,
          0,
          chunk.byteLength,
          seg.start + seg.written,
        );
        if (bytesWritten !== chunk.byteLength) {
          throw new Error(
            `Short write: ${bytesWritten} of ${chunk.byteLength} bytes at offset ${seg.start + seg.written}`,
          );
        }
        seg.written += bytesWritten;
        ctx.onBytes();
      }
      if (seg.start + seg.written >= seg.end) {
        // Boundary reached; the rest of an open-ended body belongs to
        // other segments (or is already on disk).
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
  }
  if (Number.isFinite(seg.end) && seg.start + seg.written < seg.end) {
    // The body ended early (a CDN closing the connection is reported as
    // a clean end by some stacks). The bytes are good as far as they go.
    throw new Error(
      `Download ended early: ${seg.start + seg.written} of ${seg.end} bytes received`,
    );
  }
}

/**
 * Fetch one segment to completion. With ranges supported, a transport
 * failure re-requests only this segment's remainder while the other
 * connections keep going; the retry budget is per streak, so a
 * connection that keeps making progress is never given up on. Anything
 * fatal (a changed file, a 404, the attempt being cancelled) is thrown
 * for the attempt to handle.
 */
export async function runSegment(
  seg: Segment,
  ctx: SegmentContext,
  initial?: { res: Response; abort: AbortController },
): Promise<void> {
  let pending = initial;
  let failures = 0;
  for (;;) {
    const before = seg.written;
    try {
      const { res, abort } = pending ?? (await openSegment(seg, ctx));
      pending = undefined;
      await streamIntoSegment(res, seg, ctx, abort);
      return;
    } catch (err) {
      pending = undefined;
      const error = err instanceof Error ? err : new Error(String(err));
      if (ctx.attemptSignal.aborted) throw createAbortError();
      if (!ctx.retryInPlace) throw error;
      if (error instanceof RangeRejectedError || error instanceof RangesUnsupportedError) {
        throw error;
      }
      if (seg.written > before) failures = 0;
      if (failures >= ctx.maxRetries || !isRetryableDownloadError(error)) throw error;
      const delayMs = Math.min(ctx.retryDelayMs * 2 ** failures, ctx.maxRetryDelayMs);
      failures += 1;
      ctx.onRetry?.({ attempt: failures, maxRetries: ctx.maxRetries, delayMs, error });
      await sleep(delayMs, ctx.attemptSignal);
    }
  }
}

/**
 * Open one segment's connection. The stall watchdog covers this phase
 * too: a server that accepts the socket and never sends headers must
 * not park the segment forever.
 */
async function openSegment(
  seg: Segment,
  ctx: SegmentContext,
): Promise<{ res: Response; abort: AbortController }> {
  const abort = linkedAbort(ctx.attemptSignal);
  let stalled = false;
  const timer =
    ctx.stallTimeoutMs > 0
      ? setTimeout(() => {
          stalled = true;
          abort.abort();
        }, ctx.stallTimeoutMs)
      : null;
  try {
    const res = await requestSegment(seg, ctx, abort);
    return { res, abort };
  } catch (err) {
    if (ctx.attemptSignal.aborted) throw createAbortError();
    if (stalled) throw new StalledError(ctx.stallTimeoutMs);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Drain `queue` one segment at a time; several of these run in parallel. */
export async function runSegmentQueue(queue: Segment[], ctx: SegmentContext): Promise<void> {
  for (;;) {
    const seg = queue.shift();
    if (!seg) return;
    await runSegment(seg, ctx);
  }
}
