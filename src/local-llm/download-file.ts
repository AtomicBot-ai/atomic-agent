import { downloadAttempt } from "./download-attempt.js";
import {
  isRetryableDownloadError,
  RangeRejectedError,
  RangesUnsupportedError,
  sleep,
  throwIfAborted,
} from "./download-errors.js";
import { discardPartialDownload, rmQuiet } from "./download-partial.js";

export {
  discardPartialDownload,
  readPartialDownload,
  resolvePartialMetaPath,
  resolvePartialPath,
  type PartialDownloadMeta,
} from "./download-partial.js";
export { isRetryableDownloadError } from "./download-errors.js";
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
 * Called before each retry. `attempt` is the retry about to run (1-based),
 * `delayMs` how long the downloader is about to wait, `error` why the
 * previous attempt died. Surfaces a stalled link to the operator instead
 * of leaving the progress bar frozen while the backoff runs. Fires both
 * for a whole-attempt retry and for one segment re-requesting its
 * remainder while the other connections keep going.
 */
export type DownloadRetryFn = (info: {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  error: Error;
}) => void;

export interface DownloadFileOptions {
  onProgress?: DownloadProgressFn;
  onRetry?: DownloadRetryFn;
  userAgent?: string;
  signal?: AbortSignal;
  /** Retries after a network failure before giving up. Default 5. */
  maxRetries?: number;
  /** Base of the exponential backoff between retries. Default 1s. */
  retryDelayMs?: number;
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
}

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;
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
 * Within one call, a failed segment re-requests its own remainder while
 * the others keep streaming; a failure that takes the whole attempt down
 * retries from the partial with exponential backoff (`maxRetries`,
 * default 5). The caller's `signal` cancels everything, including a
 * backoff wait, and is never retried.
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
  const retryDelayMs = opts?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  // Pre-resume `.tmp` files are unusable: nothing records what they hold.
  rmQuiet(`${destPath}.tmp`);

  let singleStream = false;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await downloadAttempt(url, destPath, {
        onProgress: opts?.onProgress,
        onRetry: opts?.onRetry,
        userAgent: opts?.userAgent,
        signal: opts?.signal,
        maxRetries,
        retryDelayMs,
        maxRetryDelayMs: MAX_RETRY_DELAY_MS,
        stallTimeoutMs: opts?.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS,
        connections: opts?.connections,
        minSegmentBytes: opts?.minSegmentBytes ?? DEFAULT_MIN_SEGMENT_BYTES,
        singleStream,
      });
      return;
    } catch (err) {
      throwIfAborted(opts?.signal);
      // A range answer that named a different file: the bytes on disk
      // are not this file's, so the retry starts from zero.
      if (err instanceof RangeRejectedError) discardPartialDownload(destPath);
      // A server that ignored a segment's range keeps its bytes but
      // gets one stream from here on.
      if (err instanceof RangesUnsupportedError) singleStream = true;
      if (attempt >= maxRetries || !isRetryableDownloadError(err)) {
        throw err;
      }
      const delayMs = Math.min(retryDelayMs * 2 ** attempt, MAX_RETRY_DELAY_MS);
      opts?.onRetry?.({
        attempt: attempt + 1,
        maxRetries,
        delayMs,
        error: err instanceof Error ? err : new Error(String(err)),
      });
      await sleep(delayMs, opts?.signal);
    }
  }
}
