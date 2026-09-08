/**
 * How a failed download attempt is sorted into a retry policy. Kept
 * apart from the transfer loop so the worker, the CLI and the TUI can
 * ask "is this worth starting again later?" without importing `fetch`
 * plumbing.
 */

/**
 * Why an attempt died, as far as retrying is concerned.
 *
 * - `transport`: the link, not the file — DNS, a reset, a stall, a
 *   captive portal. The bytes on disk are still right; the next attempt
 *   asks for the rest. Retried until the outage outlives `giveUpAfterMs`.
 * - `server`: the origin answered but would not serve (5xx, 408, 429).
 *   Retried a bounded number of times: a mirror that is broken now is
 *   usually broken in a minute too, and the operator should hear about it.
 * - `fatal`: nothing another attempt could change — a 404, a 401, a full
 *   disk, a file that changed under us.
 * - `aborted`: the caller's signal fired.
 */
export type DownloadErrorKind = "transport" | "server" | "fatal" | "aborted";

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
 * The link was answered by something that is not the file: a hotel
 * Wi-Fi splash page, a proxy's block page. Retried like any transport
 * failure — the partial is kept, the next attempt asks again once the
 * portal has been clicked through.
 */
export class InterceptedError extends Error {
  constructor(detail: string) {
    super(`Download intercepted: ${detail}`);
    this.name = "InterceptedError";
  }
}

/**
 * A transport outage outlived its budget (or the caller's deadline).
 * The partial is intact; a later `downloadFile` for the same destination
 * resumes it. Classified `fatal` so nothing retries it further.
 */
export class DownloadGaveUpError extends Error {
  constructor(
    readonly reason: "no-progress" | "deadline",
    detail: string,
    override readonly cause: Error,
  ) {
    super(`Download gave up: ${detail} (last error: ${cause.message})`);
    this.name = "DownloadGaveUpError";
  }
}

/** Errno codes that mean "the network", not "this machine". */
const TRANSPORT_ERRNO = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_FAIL",
  "ETIMEDOUT",
  "EPIPE",
  "ENETUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "EADDRNOTAVAIL",
]);

/** Errno codes no retry can fix: the disk, not the link. */
const LOCAL_ERRNO = new Set([
  "ENOSPC",
  "EACCES",
  "EPERM",
  "EROFS",
  "EMFILE",
  "ENFILE",
  "EISDIR",
  "ENOTDIR",
  "EIO",
  "EDQUOT",
  "EBADF",
]);

/**
 * Errno-style codes that name a broken *setup*, not a broken link: a
 * malformed URL, a certificate the machine will not trust. Retrying
 * them every minute for a week would only fill the log with the same
 * complaint.
 */
const FATAL_CODE_PREFIXES = ["ERR_INVALID_", "ERR_TLS_", "ERR_SSL_", "ERR_OSSL_"];
const FATAL_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "CERT_UNTRUSTED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "HOSTNAME_MISMATCH",
]);

function isFatalCode(code: string): boolean {
  return FATAL_CODES.has(code) || FATAL_CODE_PREFIXES.some((p) => code.startsWith(p));
}

function errnoOf(err: unknown): string | null {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur && typeof cur === "object"; depth += 1) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

export function createAbortError(): Error {
  const err = new Error("Download aborted");
  err.name = "AbortError";
  return err;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/**
 * Sort a failed attempt into the retry policy that applies to it. An
 * undici `TypeError: fetch failed` carries the errno in `cause`; a
 * `write` on a full disk carries it on the error itself. Anything
 * unrecognised is treated as the link — that is the failure a download
 * of this size meets in practice, and retrying it costs nothing.
 */
export function classifyDownloadError(err: unknown): DownloadErrorKind {
  if (isAbortError(err)) return "aborted";
  if (err instanceof DownloadGaveUpError) return "fatal";
  if (err instanceof StalledError || err instanceof InterceptedError) {
    return "transport";
  }
  if (err instanceof DownloadHttpError) {
    return err.status === 408 || err.status === 429 || err.status >= 500
      ? "server"
      : "fatal";
  }
  const code = errnoOf(err);
  if (code && (LOCAL_ERRNO.has(code) || isFatalCode(code))) return "fatal";
  if (code && (TRANSPORT_ERRNO.has(code) || code.startsWith("UND_ERR_"))) return "transport";
  // undici reports network failures as a TypeError — `fetch failed` for
  // the connection, `terminated` for a body cut short — always with the
  // underlying error in `cause`. A TypeError with no cause at all is a
  // bug in this program, which no amount of waiting fixes.
  if (
    err instanceof TypeError &&
    (err as { cause?: unknown }).cause === undefined &&
    !/fetch failed|terminated/i.test(err.message)
  ) {
    return "fatal";
  }
  return "transport";
}

/**
 * Whether another attempt can reasonably succeed. Transport-level
 * failures (reset, timeout, DNS blip, a socket the CDN dropped mid-body)
 * and server-side throttling are; a 404 or a 401 is not — the retries
 * would only delay the same answer.
 */
export function isRetryableDownloadError(err: unknown): boolean {
  const kind = classifyDownloadError(err);
  return kind === "transport" || kind === "server";
}

/**
 * Whether a download that ended with `err` is worth starting again
 * later: the outage, not the file, was the problem. What a background
 * worker records so a relaunch knows to pick the job back up.
 */
export function isResumableDownloadError(err: unknown): boolean {
  if (err instanceof DownloadGaveUpError) return true;
  return classifyDownloadError(err) === "transport";
}

