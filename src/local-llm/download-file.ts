import { downloadAttempt } from "./download-attempt.js";
import {
  classifyDownloadError,
  DownloadGaveUpError,
  RangeRejectedError,
  RangesUnsupportedError,
  sleep,
  throwIfAborted,
  type DownloadErrorKind,
} from "./download-errors.js";
import {
  discardPartialDownload,
  readPartialDownload,
  rmQuiet,
} from "./download-partial.js";

export {
  discardPartialDownload,
  readPartialDownload,
  resolvePartialMetaPath,
  resolvePartialPath,
  type PartialDownloadMeta,
} from "./download-partial.js";
export {
  DownloadGaveUpError,
  classifyDownloadError,
  isResumableDownloadError,
  isRetryableDownloadError,
  type DownloadErrorKind,
} from "./download-errors.js";
export {
  DEFAULT_DOWNLOAD_CONNECTIONS,
  MAX_DOWNLOAD_CONNECTIONS,
  resolveDownloadConnections,
  setDefaultDownloadConnections,
} from "./download-settings.js";

export type DownloadProgressFn = (
  percent: number,
  transferred: number,
  total: number,
) => void;

/**
 * Called before each retry. `attempt` counts consecutive attempts that
 * made no progress (1-based) — a retry after new bytes landed starts at
 * 1 again. `delayMs` is how long the downloader is about to wait; `error`
 * why the previous attempt died; `since` when the no-progress streak
 * began; `giveUpAt` when a transport streak turns into a failure. Lets a
 * UI say "offline — retrying" instead of freezing the bar.
 * Fires both for a whole-attempt retry and for one segment
 * re-requesting its remainder while the other connections keep going.
 */
export interface DownloadRetryInfo {
  attempt: number;
  kind: Exclude<DownloadErrorKind, "fatal" | "aborted">;
  /** The bound on `server` retries. Transport retries have none. */
  maxRetries: number;
  delayMs: number;
  error: Error;
  /** Epoch ms. */
  since: number;
  /** Epoch ms. */
  giveUpAt: number;
}

export type DownloadRetryFn = (info: DownloadRetryInfo) => void;

export interface DownloadFileOptions {
  onProgress?: DownloadProgressFn;
  onRetry?: DownloadRetryFn;
  userAgent?: string;
  signal?: AbortSignal;
  /**
   * Retries after a server-side error (5xx, 408, 429) before giving up.
   * Default 5. Transport errors are not counted against this — see
   * `giveUpAfterMs`.
   */
  maxRetries?: number;
  /** Base of the exponential backoff between retries. Default 1s. */
  retryDelayMs?: number;
  /** Ceiling of the backoff. Default 60s. */
  maxRetryDelayMs?: number;
  /**
   * How long a transport outage may go on without a single new byte
   * before the download gives up. Default 10 minutes; the background
   * worker passes days. Any progress restarts the clock.
   */
  giveUpAfterMs?: number;
  /**
   * Epoch ms after which no further retry is scheduled, whatever the
   * progress. A detached worker uses it as a hard cap on its own life.
   */
  deadlineAt?: number;
  /**
   * How long the body may go without a single byte before the attempt is
   * declared dead and retried from the partial. Default 60s. `0` disables
   * the watchdog.
   */
  stallTimeoutMs?: number;
  /**
   * Parallel connections for one file. Defaults to the value pushed in
   * from config (`localModels.download.connections`, 16 out of the box),
   * overridden by the `ATOMIC_AGENT_DOWNLOAD_CONNECTIONS` env var. `1`
   * is the old single stream. Only used when the server honours `Range`
   * requests and the file is large enough to split.
   */
  connections?: number;
  /** Smallest slice worth its own connection. Default 8 MiB. */
  minSegmentBytes?: number;
  /** Test seam. */
  now?: () => number;
}

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
/**
 * 10 minutes without a byte before an outage becomes a failure — for a
 * download somebody is sitting in front of (`models pull`, the TUI's
 * backend zip). The detached worker asks for days; see
 * `WORKER_GIVE_UP_AFTER_MS`.
 */
export const DEFAULT_GIVE_UP_AFTER_MS = 10 * 60 * 1_000;
const DEFAULT_STALL_TIMEOUT_MS = 60_000;
const DEFAULT_MIN_SEGMENT_BYTES = 8 * 1024 * 1024;

/**
 * Download a file from `url` to `destPath` over several connections,
 * resuming and retrying.
 *
 * Bytes land in `<dest>.part` at their final offsets, with
 * `<dest>.part.json` recording the URL, declared length, validators and
 * the byte intervals already written. When the server honours `Range`
 * requests the remainder is split across up to `connections` streams;
 * otherwise one stream does the work, as before. The partial is **kept**
 * on abort, on error and when the process dies, and the next call for
 * the same destination asks only for the holes. A `200` to a resume, a
 * changed validator or a range that does not line up restarts from zero.
 * Only a completed transfer is renamed onto `destPath`.
 *
 * Within one call, transport failures and stalls retry from the partial
 * with exponential backoff for as long as the outage lasts — up to
 * `giveUpAfterMs` without a single new byte (10 minutes by default; the
 * detached worker asks for days, so a machine that goes offline for the
 * night resumes by itself in the morning). Server-side errors are
 * bounded by `maxRetries` (default 5) instead. The caller's `signal`
 * cancels everything, including a backoff wait, and is never retried.
 *
 * Within one call a failed segment re-requests its own remainder
 * while the other connections keep streaming.
 *
 * Progress counts every byte on disk, so a UI picking up a 12 GB partial
 * of a 20 GB file starts its bar at 60%, not 0%.
 */
export async function downloadFile(
  url: string,
  destPath: string,
  opts?: DownloadFileOptions,
): Promise<void> {
  throwIfAborted(opts?.signal);
  const maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelay = opts?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxDelay = opts?.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  const giveUpAfterMs = opts?.giveUpAfterMs ?? DEFAULT_GIVE_UP_AFTER_MS;
  const now = opts?.now ?? Date.now;

  // Pre-resume `.tmp` files are unusable: nothing records what they hold.
  rmQuiet(`${destPath}.tmp`);

  // The budget is a no-progress *window*, not a count: `attempt` and
  // `since` restart whenever an attempt carries the partial past its
  // previous high-water mark, so six blips spread over a three-hour
  // transfer never add up to a failure, while an outage that outlives
  // `giveUpAfterMs` does. Progress is measured against the bytes the
  // sidecar says are complete, not the `.part` file's size: the parallel
  // engine writes sparsely, so the size runs ahead of what has landed.
  //
  // Server errors keep their own counter. Sharing one would let the first
  // 503 after a long outage — the common case when a CDN comes back —
  // inherit the outage's attempts and fail the download for good.
  let attempt = 0;
  let serverFailures = 0;
  let since = now();
  let highWater = readPartialDownload(destPath)?.transferred ?? 0;
  let singleStream = false;
  for (;;) {
    try {
      await downloadAttempt(url, destPath, {
        onProgress: opts?.onProgress,
        // A segment retrying its own remainder is a retry the operator
        // should see, but it carries no window of its own — it is
        // reported inside the attempt's window.
        onRetry: opts?.onRetry
          ? (info) =>
              opts.onRetry?.({
                ...info,
                // A segment only ever retries what is worth retrying;
                // the two terminal kinds end the attempt instead.
                kind:
                  classifyDownloadError(info.error) === "server"
                    ? "server"
                    : "transport",
                since,
                giveUpAt: since + giveUpAfterMs,
              })
          : undefined,
        userAgent: opts?.userAgent,
        signal: opts?.signal,
        maxRetries,
        retryDelayMs: baseDelay,
        maxRetryDelayMs: maxDelay,
        stallTimeoutMs: opts?.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS,
        connections: opts?.connections,
        minSegmentBytes: opts?.minSegmentBytes ?? DEFAULT_MIN_SEGMENT_BYTES,
        singleStream,
      });
      return;
    } catch (err) {
      throwIfAborted(opts?.signal);
      const kind = classifyDownloadError(err);
      if (kind === "fatal" || kind === "aborted") throw err;
      const error = err instanceof Error ? err : new Error(String(err));
      // A range answer that named a different file: the bytes on disk
      // are not this file's, so the retry starts from zero — and the
      // high-water mark goes with them, or the window would never
      // restart while the same bytes are fetched again.
      if (err instanceof RangeRejectedError) {
        discardPartialDownload(destPath);
        highWater = 0;
      }
      // A server that ignored a segment's range keeps its bytes but
      // gets one stream from here on.
      if (err instanceof RangesUnsupportedError) singleStream = true;
      const reached = readPartialDownload(destPath)?.transferred ?? 0;
      if (reached > highWater) {
        highWater = reached;
        attempt = 0;
        serverFailures = 0;
        since = now();
      }
      attempt += 1;
      if (kind === "server") {
        serverFailures += 1;
        if (serverFailures > maxRetries) throw err;
      }
      const delayMs = Math.min(baseDelay * 2 ** (attempt - 1), maxDelay);
      const giveUpAt = since + giveUpAfterMs;
      const t = now();
      if (opts?.deadlineAt !== undefined && t + delayMs >= opts.deadlineAt) {
        throw new DownloadGaveUpError(
          "deadline",
          "the download's time limit was reached",
          error,
        );
      }
      if (kind === "transport" && t + delayMs >= giveUpAt) {
        throw new DownloadGaveUpError(
          "no-progress",
          `no progress for ${formatDuration(giveUpAfterMs)}`,
          error,
        );
      }
      opts?.onRetry?.({
        attempt,
        kind,
        maxRetries,
        delayMs,
        error,
        since,
        giveUpAt,
      });
      await sleep(delayMs, opts?.signal);
    }
  }
}

/** "10 minutes", "2 hours" — for the give-up message, not a UI clock. */
function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}
