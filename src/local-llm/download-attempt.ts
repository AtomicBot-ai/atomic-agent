import * as fs from "node:fs";
import { dirname } from "node:path";

import {
  createAbortError,
  DownloadHttpError,
  parseContentRange,
  RangeRejectedError,
  StalledError,
  throwIfAborted,
  validatorsMatch,
} from "./download-errors.js";
import {
  discardPartialDownload,
  holesIn,
  mergeRanges,
  resolvePartialPath,
  sumRanges,
  writePartialMeta,
  type ByteRange,
} from "./download-partial.js";
import { describeResume, finalize } from "./download-resume.js";
import {
  linkedAbort,
  planSegments,
  runSegment,
  runSegmentQueue,
  type SegmentContext,
} from "./download-segments.js";
import { resolveDownloadConnections } from "./download-settings.js";
import { huggingFaceToken } from "./huggingface-api.js";
import { isHuggingFaceUrl, rewriteHuggingFaceUrl } from "./huggingface-endpoint.js";

export interface AttemptOptions {
  onProgress?: (percent: number, transferred: number, total: number) => void;
  onRetry?: SegmentContext["onRetry"];
  userAgent?: string;
  signal?: AbortSignal;
  maxRetries: number;
  retryDelayMs: number;
  maxRetryDelayMs: number;
  stallTimeoutMs: number;
  connections?: number;
  minSegmentBytes: number;
  /** Set once a server ignored a segment's `Range`; one stream from then on. */
  singleStream: boolean;
}

const PROGRESS_INTERVAL_MS = 200;
const META_WRITE_INTERVAL_MS = 500;

function baseHeaders(url: string, userAgent?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": userAgent ?? "atomic-agent/local-llm",
  };
  const isGitHub =
    url.includes("github.com") || url.includes("githubusercontent.com");
  if (isGitHub) {
    const token = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();
    if (token) headers.Authorization = `Bearer ${token}`;
  } else if (isHuggingFaceUrl(url)) {
    // Gated repos answer 401 without this; public ones ignore it, so it
    // costs nothing to send whenever the operator has a token exported.
    const token = huggingFaceToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

/**
 * One attempt: a lead request for the first missing byte, then — when
 * the server honours ranges — the rest of the holes fanned out across
 * parallel connections into the same `.part` file. Throws to let
 * `downloadFile` decide about a retry; the sidecar always reflects what
 * is on disk when it returns or throws.
 */
export async function downloadAttempt(
  url: string,
  destPath: string,
  opts: AttemptOptions,
): Promise<void> {
  const partPath = resolvePartialPath(destPath);
  const headers = baseHeaders(url, opts.userAgent);
  // The sidecar, and every comparison against it, uses the canonical
  // URL; only the wire request goes to the configured endpoint, so a
  // partial survives switching mirrors.
  const requestUrl = rewriteHuggingFaceUrl(url);

  const resume = describeResume(url, destPath, headers);
  const { stored, offset, sentRange, leadHeaders } = resume;
  let { done, total } = resume;

  // One controller ends the attempt — the caller's cancel or a fatal
  // segment error; which of the two it was is decided after the fact.
  const attemptAbort = new AbortController();
  const onCallerAbort = (): void => attemptAbort.abort();
  throwIfAborted(opts.signal);
  opts.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const leadAbort = linkedAbort(attemptAbort.signal);
  let leadStalled = false;
  const connectTimer =
    opts.stallTimeoutMs > 0
      ? setTimeout(() => {
          leadStalled = true;
          leadAbort.abort();
        }, opts.stallTimeoutMs)
      : null;

  try {
    let res: Response;
    try {
      res = await fetch(requestUrl, {
        headers: leadHeaders,
        redirect: "follow",
        signal: leadAbort.signal,
      });
    } catch (err) {
      throwIfAborted(opts.signal);
      if (leadStalled) throw new StalledError(opts.stallTimeoutMs);
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      if (connectTimer) clearTimeout(connectTimer);
    }
    throwIfAborted(opts.signal);

    if (res.status === 416 && sentRange) {
      // Range not satisfiable. When the partial already holds the whole
      // declared length this is "nothing left to send" — publish it.
      // Otherwise the server's idea of the file differs from ours.
      const cr = parseContentRange(res.headers.get("content-range"));
      const confirmed = cr?.total || total;
      if (confirmed > 0 && offset === confirmed && sumRanges(done) === confirmed) {
        finalize(destPath, offset, confirmed, opts.onProgress);
        return;
      }
      discardPartialDownload(destPath);
      throw new DownloadHttpError(res.status, res.statusText);
    }
    if (!res.ok || !res.body) {
      throw new DownloadHttpError(res.status, res.statusText);
    }

    let resumed = false;
    let rangesSupported = false;
    if (res.status === 206 && sentRange && stored) {
      const cr = parseContentRange(res.headers.get("content-range"));
      if (cr && cr.start === offset && validatorsMatch(stored, res)) {
        resumed = true;
        rangesSupported = true;
        total = cr.total || total;
      } else {
        // A 206 whose range does not line up with our offset cannot be
        // placed; drain nothing, start over on the next attempt.
        await res.body.cancel().catch(() => undefined);
        throw new RangeRejectedError("server range did not match the partial file");
      }
    } else {
      // A full body (200) — either a fresh download or the server would
      // not (or could not, validators changed) honour the range. Whatever
      // is on disk is not this file's prefix.
      discardPartialDownload(destPath);
      done = [];
      const totalRaw = res.headers.get("content-length");
      total = totalRaw ? parseInt(totalRaw, 10) : 0;
      if (!Number.isFinite(total) || total < 0) total = 0;
      rangesSupported = total > 0 && res.headers.get("accept-ranges") === "bytes";
    }

    const connections =
      opts.singleStream || !rangesSupported ? 1 : resolveDownloadConnections(opts.connections);
    let remaining: ByteRange[] = resumed
      ? total > 0
        ? holesIn(done, total)
        : [[offset, Infinity]]
      : [[0, total > 0 ? total : Infinity]];
    if (opts.singleStream && remaining.length > 1) {
      // The server ignored a closed range once; asking it for each hole
      // would cost one torn-down attempt per hole. One open-ended stream
      // from the first hole re-fetches the islands beyond it instead.
      remaining = [[offset, total > 0 ? total : Infinity]];
      done = offset > 0 ? [[0, offset]] : [];
    }
    const segments = planSegments(remaining, connections, opts.minSegmentBytes);
    const [lead, ...queue] = segments;
    if (!lead) {
      // A 206 for a range that starts past the end: the server's file is
      // not the one the sidecar describes.
      await res.body.cancel().catch(() => undefined);
      throw new RangeRejectedError("server answered a range past the end of the file");
    }

    fs.mkdirSync(dirname(destPath), { recursive: true });
    // Positional writes need an existing file; a fresh download also
    // truncates whatever a discarded partial left behind.
    fs.closeSync(fs.openSync(partPath, resumed ? "a" : "w"));
    const handle = await fs.promises.open(partPath, "r+");
    const validators = {
      etag: res.headers.get("etag"),
      lastModified: res.headers.get("last-modified"),
    };
    const seedSum = sumRanges(done);
    const transferredNow = (): number =>
      seedSum + segments.reduce((sum, seg) => sum + seg.written, 0);
    const doneNow = (): ByteRange[] =>
      mergeRanges([
        ...done,
        ...segments
          .filter((seg) => seg.written > 0)
          .map((seg): ByteRange => [seg.start, seg.start + seg.written]),
      ]);
    const persistMeta = (): void =>
      writePartialMeta(destPath, { url, total, ...validators, done: doneNow() });
    persistMeta();

    // Progress is emitted on a time base: one percent of a 4 GB GGUF is
    // ~41 MB, so a whole-percent trigger would leave the byte counter
    // frozen for seconds, and a response without `content-length` (percent
    // pinned at 0) would never move at all. The bytes advance visibly,
    // which is the part that tells the user the transfer is alive.
    let lastEmitAt = 0;
    let lastEmittedBytes = -1;
    let lastMetaAt = Date.now();
    const emitProgress = (now: number): void => {
      const transferred = transferredNow();
      if (transferred === lastEmittedBytes) return;
      lastEmitAt = now;
      lastEmittedBytes = transferred;
      const percent = total > 0 ? Math.round((transferred / total) * 100) : 0;
      opts.onProgress?.(percent, transferred, total);
    };
    // A resumed transfer owes the UI its starting point at once: the
    // bar must open at the partial's percentage, not at zero.
    if (resumed) emitProgress(Date.now());

    const ctx: SegmentContext = {
      url: requestUrl,
      headers,
      validators,
      total,
      handle,
      attemptSignal: attemptAbort.signal,
      // A lone segment is retried by `downloadFile`, as it always was; a
      // segment among several re-requests only its own remainder.
      retryInPlace: rangesSupported && segments.length > 1,
      stallTimeoutMs: opts.stallTimeoutMs,
      maxRetries: opts.maxRetries,
      retryDelayMs: opts.retryDelayMs,
      maxRetryDelayMs: opts.maxRetryDelayMs,
      onBytes: () => {
        const now = Date.now();
        if (now - lastEmitAt >= PROGRESS_INTERVAL_MS) emitProgress(now);
        if (now - lastMetaAt >= META_WRITE_INTERVAL_MS) {
          lastMetaAt = now;
          persistMeta();
        }
      },
      onRetry: opts.onRetry,
    };

    let fatal: Error | null = null;
    const guard = (work: Promise<void>): Promise<void> =>
      work.catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        if (!fatal && error.name !== "AbortError") fatal = error;
        attemptAbort.abort();
        throw error;
      });
    // The lead joins the pool once its own slice is done, so a plan with
    // more pieces than connections (a fragmented partial resumed on one
    // stream, say) still drains every hole.
    const workers = [
      guard(runSegment(lead, ctx, { res, abort: leadAbort }).then(() => runSegmentQueue(queue, ctx))),
      ...Array.from({ length: Math.min(connections - 1, queue.length) }, () =>
        guard(runSegmentQueue(queue, ctx)),
      ),
    ];
    try {
      await Promise.allSettled(workers);
    } finally {
      // The sidecar's claims must not outlive the page cache: flush the
      // data before the record that vouches for it is renamed into place.
      await handle.datasync().catch(() => undefined);
      await handle.close();
      persistMeta();
      // The last partial interval still owes the user its final numbers.
      emitProgress(Date.now());
    }
    throwIfAborted(opts.signal);
    if (fatal) throw fatal;
    if (attemptAbort.signal.aborted) throw createAbortError();

    const transferred = transferredNow();
    if (total > 0 && transferred !== total) {
      throw new Error(`Download ended early: ${transferred} of ${total} bytes received`);
    }
    finalize(destPath, transferred, total, opts.onProgress);
  } finally {
    opts.signal?.removeEventListener("abort", onCallerAbort);
    // Whatever is still in flight (a lead body never read) goes away
    // with the attempt.
    attemptAbort.abort();
  }
}
