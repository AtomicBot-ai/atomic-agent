import * as fs from "node:fs";
import { dirname } from "node:path";

import { huggingFaceToken } from "./huggingface-api.js";

export type DownloadProgressFn = (
  percent: number,
  transferred: number,
  total: number,
) => void;

/**
 * Called before each retry. `attempt` is the retry about to run (1-based),
 * `delayMs` how long the downloader is about to wait, `error` why the
 * previous attempt died. Surfaces a stalled link to the operator instead
 * of leaving the progress bar frozen while the backoff runs.
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
}

/** Sidecar next to the `.part` file: what the partial bytes belong to. */
export interface PartialDownloadMeta {
  url: string;
  /** Total length the server declared, or `0` when it did not. */
  total: number;
  etag: string | null;
  lastModified: string | null;
}

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;
const DEFAULT_STALL_TIMEOUT_MS = 60_000;

export function resolvePartialPath(destPath: string): string {
  return `${destPath}.part`;
}

export function resolvePartialMetaPath(destPath: string): string {
  return `${destPath}.part.json`;
}

/**
 * Bytes already on disk for an unfinished download of `destPath`, or
 * `null` when there is no resumable partial. Lets a UI show "12.4 GB of
 * 20.1 GB already here" before any request is made.
 */
export function readPartialDownload(
  destPath: string,
): { transferred: number; total: number } | null {
  const meta = readPartialMeta(destPath);
  if (!meta) return null;
  const transferred = partialSize(destPath);
  if (transferred <= 0) return null;
  return { transferred, total: meta.total };
}

/** Drop a partial download and its sidecar. No-op when neither exists. */
export function discardPartialDownload(destPath: string): void {
  rmQuiet(resolvePartialPath(destPath));
  rmQuiet(resolvePartialMetaPath(destPath));
}

class DownloadHttpError extends Error {
  constructor(
    readonly status: number,
    statusText: string,
  ) {
    super(`Download failed: HTTP ${status} ${statusText}`);
    this.name = "DownloadHttpError";
  }
}

class StalledError extends Error {
  constructor(ms: number) {
    super(`Download stalled: no data for ${Math.round(ms / 1000)}s`);
    this.name = "StalledError";
  }
}

function createAbortError(): Error {
  const err = new Error("Download aborted");
  err.name = "AbortError";
  return err;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/**
 * Whether another attempt can reasonably succeed. Transport-level
 * failures (reset, timeout, DNS blip, a socket the CDN dropped mid-body)
 * and server-side throttling are; a 404 or a 401 is not — the retries
 * would only delay the same answer.
 */
export function isRetryableDownloadError(err: unknown): boolean {
  if (isAbortError(err)) return false;
  if (err instanceof StalledError) return true;
  if (err instanceof DownloadHttpError) {
    return err.status === 408 || err.status === 429 || err.status >= 500;
  }
  return true;
}

function partialSize(destPath: string): number {
  try {
    return fs.statSync(resolvePartialPath(destPath)).size;
  } catch {
    return 0;
  }
}

function readPartialMeta(destPath: string): PartialDownloadMeta | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(resolvePartialMetaPath(destPath), "utf-8"),
    ) as Partial<PartialDownloadMeta>;
    if (typeof raw.url !== "string") return null;
    return {
      url: raw.url,
      total: typeof raw.total === "number" && raw.total > 0 ? raw.total : 0,
      etag: typeof raw.etag === "string" ? raw.etag : null,
      lastModified: typeof raw.lastModified === "string" ? raw.lastModified : null,
    };
  } catch {
    return null;
  }
}

function writePartialMeta(destPath: string, meta: PartialDownloadMeta): void {
  fs.writeFileSync(resolvePartialMetaPath(destPath), JSON.stringify(meta), "utf-8");
}

function rmQuiet(path: string): void {
  try {
    fs.rmSync(path, { force: true });
  } catch {
    /* ignore */
  }
}

function parseContentRange(
  header: string | null,
): { start: number; total: number } | null {
  if (!header) return null;
  const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(header.trim());
  if (!m) return null;
  return {
    start: Number(m[1]),
    total: m[3] === "*" ? 0 : Number(m[3]),
  };
}

/**
 * The partial on disk is only worth continuing when the server still
 * serves the same bytes: same URL, and the same validator when one was
 * recorded. A file re-uploaded under the same name has a new ETag, and
 * appending the tail of the new file to the head of the old one would
 * produce a GGUF that loads up to the seam and then crashes llama-server.
 */
function validatorsMatch(
  stored: PartialDownloadMeta,
  res: Response,
): boolean {
  const etag = res.headers.get("etag");
  if (stored.etag && etag && stored.etag !== etag) return false;
  const lastModified = res.headers.get("last-modified");
  if (
    !stored.etag &&
    stored.lastModified &&
    lastModified &&
    stored.lastModified !== lastModified
  ) {
    return false;
  }
  return true;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Download a file from `url` to `destPath`, resuming and retrying.
 *
 * Bytes stream into `<dest>.part`, with `<dest>.part.json` recording the
 * URL, declared length and validators they belong to. The partial is
 * **kept** on abort, on error and when the process dies, and the next
 * call for the same destination asks the server for the remainder with a
 * `Range` request. A `206` continues from where the last run stopped; a
 * `200`, a changed validator or a length mismatch restarts from zero.
 * Only a completed transfer is renamed onto `destPath`.
 *
 * Within one call, transport failures and stalls retry from the partial
 * with exponential backoff (`maxRetries`, default 5). The caller's
 * `signal` cancels everything, including a backoff wait, and is never
 * retried.
 *
 * Progress counts from the resumed offset, so a UI picking up a 12 GB
 * partial of a 20 GB file starts its bar at 60%, not 0%.
 */
export async function downloadFile(
  url: string,
  destPath: string,
  opts?: DownloadFileOptions,
): Promise<void> {
  throwIfAborted(opts?.signal);
  const maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelay = opts?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  // Pre-resume `.tmp` files are unusable: nothing records what they hold.
  rmQuiet(`${destPath}.tmp`);

  for (let attempt = 0; ; attempt += 1) {
    try {
      await downloadAttempt(url, destPath, opts);
      return;
    } catch (err) {
      throwIfAborted(opts?.signal);
      if (attempt >= maxRetries || !isRetryableDownloadError(err)) {
        throw err;
      }
      const delayMs = Math.min(baseDelay * 2 ** attempt, MAX_RETRY_DELAY_MS);
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

async function downloadAttempt(
  url: string,
  destPath: string,
  opts?: DownloadFileOptions,
): Promise<void> {
  const partPath = resolvePartialPath(destPath);
  const stallTimeoutMs = opts?.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;

  const headers: Record<string, string> = {
    "User-Agent": opts?.userAgent ?? "atomic-agent/local-llm",
  };
  const isGitHub =
    url.includes("github.com") || url.includes("githubusercontent.com");
  if (isGitHub) {
    const token = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();
    if (token) headers.Authorization = `Bearer ${token}`;
  } else if (url.includes("huggingface.co")) {
    // Gated repos answer 401 without this; public ones ignore it, so it
    // costs nothing to send whenever the operator has a token exported.
    const token = huggingFaceToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  // Resume only what we can vouch for: a sidecar naming this URL and a
  // non-empty partial. Anything else starts over.
  const stored = readPartialMeta(destPath);
  let offset = 0;
  if (stored && stored.url === url) {
    offset = partialSize(destPath);
  }
  if (offset > 0 && stored && stored.total > 0 && offset > stored.total) {
    // More bytes than the file has: a stray append. Not salvageable.
    offset = 0;
  }
  // `offset === stored.total` is left alone on purpose: the last run
  // wrote every byte and died before the rename. The range request then
  // asks for nothing, and the 416 branch below publishes the file once
  // the server has confirmed it still is that file.
  if (offset === 0) discardPartialDownload(destPath);
  if (offset > 0) {
    headers.Range = `bytes=${offset}-`;
    // `If-Range` makes a server that still has the same file answer 206
    // and one that has a new one answer 200 with the whole body — the
    // restart case, handled below without a second round-trip.
    const validator = stored?.etag ?? stored?.lastModified;
    if (validator) headers["If-Range"] = validator;
  }

  // One controller for both the caller's cancel and the stall watchdog;
  // which of the two fired is decided after the fact.
  const attemptAbort = new AbortController();
  const onCallerAbort = (): void => attemptAbort.abort();
  if (opts?.signal?.aborted) throw createAbortError();
  opts?.signal?.addEventListener("abort", onCallerAbort, { once: true });
  let stalled = false;
  let stallTimer: NodeJS.Timeout | null = null;
  const armStallTimer = (): void => {
    if (stallTimeoutMs <= 0) return;
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled = true;
      attemptAbort.abort();
    }, stallTimeoutMs);
  };
  const disarmStallTimer = (): void => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = null;
  };

  try {
    armStallTimer();
    let res: Response;
    try {
      res = await fetch(url, {
        headers,
        redirect: "follow",
        signal: attemptAbort.signal,
      });
    } catch (err) {
      throw translateAttemptFailure(err, opts?.signal, stalled, stallTimeoutMs);
    }
    throwIfAborted(opts?.signal);

    if (res.status === 416 && offset > 0) {
      // Range not satisfiable. When the partial already holds the whole
      // declared length this is "nothing left to send" — publish it.
      // Otherwise the server's idea of the file differs from ours.
      const cr = parseContentRange(res.headers.get("content-range"));
      const total = cr?.total ?? stored?.total ?? 0;
      if (total > 0 && offset === total && stored) {
        finalize(destPath, offset, total, opts);
        return;
      }
      discardPartialDownload(destPath);
      throw new DownloadHttpError(res.status, res.statusText);
    }
    if (!res.ok || !res.body) {
      throw new DownloadHttpError(res.status, res.statusText);
    }

    let resumed = false;
    let total = 0;
    if (res.status === 206 && offset > 0 && stored) {
      const cr = parseContentRange(res.headers.get("content-range"));
      if (cr && cr.start === offset && validatorsMatch(stored, res)) {
        resumed = true;
        total = cr.total || stored.total;
      } else {
        // A 206 whose range does not line up with our offset cannot be
        // appended; drain nothing, start over on the next attempt.
        discardPartialDownload(destPath);
        await res.body.cancel().catch(() => undefined);
        throw new Error(
          "Download resume rejected: server range did not match the partial file",
        );
      }
    } else {
      // A full body (200) — either a fresh download or the server would
      // not (or could not, validators changed) honour the range. Whatever
      // is on disk is not this file's prefix.
      discardPartialDownload(destPath);
      offset = 0;
      const totalRaw = res.headers.get("content-length");
      total = totalRaw ? parseInt(totalRaw, 10) : 0;
      if (!Number.isFinite(total) || total < 0) total = 0;
    }

    fs.mkdirSync(dirname(destPath), { recursive: true });
    writePartialMeta(destPath, {
      url,
      total,
      etag: res.headers.get("etag"),
      lastModified: res.headers.get("last-modified"),
    });

    let transferred = offset;
    let lastEmitAt = 0;
    let lastEmittedBytes = -1;

    /**
     * Progress used to be emitted only when the whole-number percentage
     * changed, which left the byte counter frozen between those moments:
     * one percent of a 4 GB GGUF is ~41 MB, so at realistic speeds the UI
     * sat still for seconds at a time and the download looked stalled.
     * Worse, a response without `content-length` pins `percent` at 0
     * forever, so after the first chunk the counter never moved again.
     *
     * Emit on a time base instead. The percentage still only changes
     * when it changes; the bytes advance visibly, which is the part that
     * tells the user the transfer is alive.
     */
    const PROGRESS_INTERVAL_MS = 200;

    const emitProgress = (now: number): void => {
      if (transferred === lastEmittedBytes) return;
      lastEmitAt = now;
      lastEmittedBytes = transferred;
      const percent = total > 0 ? Math.round((transferred / total) * 100) : 0;
      opts?.onProgress?.(percent, transferred, total);
    };

    // A resumed transfer owes the UI its starting point at once: the
    // bar must open at the partial's percentage, not at zero.
    if (resumed) emitProgress(Date.now());

    // Chunks are written one at a time with an explicit `write` rather
    // than piped through a WriteStream: a pipeline that fails destroys
    // its destination and drops whatever it had buffered, which is
    // exactly the tail the next attempt needs on disk. Here a chunk is
    // either fully written or never counted.
    const reader = res.body.getReader();
    const aborted = new Promise<never>((_resolve, reject) => {
      const fail = (): void => reject(createAbortError());
      if (attemptAbort.signal.aborted) fail();
      else attemptAbort.signal.addEventListener("abort", fail, { once: true });
    });
    // Never awaited on its own: an abort must not wait for a source that
    // has stopped answering.
    aborted.catch(() => undefined);
    const handle = await fs.promises.open(partPath, resumed ? "a" : "w");
    try {
      for (;;) {
        let next: Awaited<ReturnType<typeof reader.read>>;
        try {
          next = await Promise.race([reader.read(), aborted]);
          // A chunk that was already queued can win the race against an
          // abort that fired during the previous write. Nothing is
          // written past a cancel: the partial ends exactly where the
          // caller stopped it.
          if (attemptAbort.signal.aborted) throw createAbortError();
        } catch (err) {
          reader.cancel().catch(() => undefined);
          throw translateAttemptFailure(err, opts?.signal, stalled, stallTimeoutMs);
        }
        if (next.done) break;
        armStallTimer();
        await handle.write(next.value);
        transferred += next.value.byteLength;
        const now = Date.now();
        if (now - lastEmitAt >= PROGRESS_INTERVAL_MS) {
          emitProgress(now);
        }
      }
    } finally {
      await handle.close();
    }
    // The last partial interval still owes the user its final numbers.
    emitProgress(Date.now());
    throwIfAborted(opts?.signal);

    if (total > 0 && transferred !== total) {
      // The body ended early (a CDN closing the connection is reported
      // as a clean end by some stacks). The bytes are good as far as they
      // go; the retry loop asks for the rest.
      throw new Error(
        `Download ended early: ${transferred} of ${total} bytes received`,
      );
    }
    finalize(destPath, transferred, total, opts);
  } finally {
    disarmStallTimer();
    opts?.signal?.removeEventListener("abort", onCallerAbort);
  }
}

function finalize(
  destPath: string,
  transferred: number,
  total: number,
  opts?: DownloadFileOptions,
): void {
  fs.renameSync(resolvePartialPath(destPath), destPath);
  rmQuiet(resolvePartialMetaPath(destPath));
  // A 416-finalised partial never streamed, so it never reported; and a
  // streamed one may have emitted its last progress inside the throttle
  // window. Either way the terminal number goes out exactly once here.
  if (total > 0 && transferred === total) {
    opts?.onProgress?.(100, transferred, total);
  }
}

/**
 * Sort out whose abort this was. The caller's cancel surfaces as
 * `AbortError` and is never retried; the watchdog's surfaces as a
 * `StalledError`, which is. Anything else passes through as the
 * transport error it is.
 */
function translateAttemptFailure(
  err: unknown,
  callerSignal: AbortSignal | undefined,
  stalled: boolean,
  stallTimeoutMs: number,
): Error {
  if (callerSignal?.aborted) return createAbortError();
  if (stalled) return new StalledError(stallTimeoutMs);
  if (err instanceof Error) return err;
  return new Error(String(err));
}
