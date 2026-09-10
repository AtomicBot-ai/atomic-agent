/**
 * Error types and small HTTP helpers shared by the downloader's pieces
 * (`download-file.ts`, `download-segments.ts`). Kept apart so the
 * segment workers and the attempt orchestrator agree on what each
 * failure means without importing each other.
 */

export class DownloadHttpError extends Error {
  constructor(
    readonly status: number,
    statusText: string,
  ) {
    super(`Download failed: HTTP ${status} ${statusText}`);
    this.name = "DownloadHttpError";
  }
}

export class StalledError extends Error {
  constructor(ms: number) {
    super(`Download stalled: no data for ${Math.round(ms / 1000)}s`);
    this.name = "StalledError";
  }
}

/**
 * The server's answer to a `Range` request did not describe the bytes
 * we hold — a range that does not line up, a changed validator, a 416
 * for a range inside the declared length. The partial cannot be trusted
 * any more; the caller discards it and the retry starts from zero.
 */
export class RangeRejectedError extends Error {
  constructor(detail: string) {
    super(`Download resume rejected: ${detail}`);
    this.name = "RangeRejectedError";
  }
}

/**
 * A server that advertised `Accept-Ranges: bytes` answered a segment's
 * `Range` request with a full `200` body. The bytes on disk are still
 * good; the caller falls back to one stream for the rest of the file.
 */
export class RangesUnsupportedError extends Error {
  constructor() {
    super("Download server ignored a Range request; continuing with one connection");
    this.name = "RangesUnsupportedError";
  }
}

export function createAbortError(): Error {
  const err = new Error("Download aborted");
  err.name = "AbortError";
  return err;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

export function isAbortError(err: unknown): boolean {
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

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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
 * `Content-Range` parsed with an **exclusive** `end`, matching the byte
 * ranges the downloader keeps everywhere else. `bytes 3-5/6` becomes
 * `{ start: 3, end: 6, total: 6 }`; the unsatisfied form (a `*` where
 * the range would be, as a 416 sends it) becomes
 * `{ start: -1, end: -1, total: 6 }`; an unknown length is `total: 0`.
 */
export function parseContentRange(
  header: string | null,
): { start: number; end: number; total: number } | null {
  if (!header) return null;
  const trimmed = header.trim();
  const full = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(trimmed);
  if (full) {
    return {
      start: Number(full[1]),
      end: Number(full[2]) + 1,
      total: full[3] === "*" ? 0 : Number(full[3]),
    };
  }
  const unsatisfied = /^bytes \*\/(\d+)$/.exec(trimmed);
  if (unsatisfied) {
    return { start: -1, end: -1, total: Number(unsatisfied[1]) };
  }
  return null;
}

/**
 * The partial on disk is only worth continuing when the server still
 * serves the same bytes: same URL, and the same validator when one was
 * recorded. A file re-uploaded under the same name has a new ETag, and
 * appending the tail of the new file to the head of the old one would
 * produce a GGUF that loads up to the seam and then crashes llama-server.
 */
export function validatorsMatch(
  stored: { etag: string | null; lastModified: string | null },
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
