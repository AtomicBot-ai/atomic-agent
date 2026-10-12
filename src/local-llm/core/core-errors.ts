import { classifyDownloadError, DownloadGaveUpError } from "../downloads/download-errors.js";

/**
 * There is no automatic fallback: with atomic-core selected, a failed Core
 * install or start leaves no working local engine. Every such failure ends
 * with both ways forward, for the CLI, the TUI and the desktop.
 */
export const CORE_RETRY_HINT = "Retry with: atomic-agent models update (TUI: press R in Models).";
export const CORE_SWITCH_BACK_HINT = "Or use llama.cpp: atomic-agent models engine llama-server (TUI: /model engine llama-server).";

/** Where Core became unavailable. */
export type CoreFailureStage = "download" | "verify" | "backend" | "start";

/**
 * Why, as a short fixed word. Safe for analytics: never a path, a URL or a
 * message from the network.
 */
export type CoreFailureReason =
  | "network" | "server" | "disk" | "checksum" | "version" | "unsupported"
  | "no_backend" | "not_installed" | "not_ready" | "spawn" | "unknown";

/**
 * The structured part of a failure, for UIs that render buttons and for
 * analytics. `reason` is display text; analytics sends only `stage` and
 * `reasonCode`.
 */
export interface CoreFailureInfo {
  stage: CoreFailureStage;
  reasonCode: CoreFailureReason;
  retryable: boolean;
  reason: string;
}

const STAGE_TEXT: Record<CoreFailureStage, string> = {
  download: "The Atomic Chat engine could not be downloaded",
  verify: "The downloaded Atomic Chat engine did not pass verification",
  backend: "Atomic Chat could not install its inference backend",
  start: "The Atomic Chat engine could not start",
};

/** Nothing a retry can change; everything else is worth "download again". */
const NOT_RETRYABLE: ReadonlySet<CoreFailureReason> = new Set(["unsupported", "version", "no_backend", "disk"]);

/**
 * Core is not available as the local engine. `reason` says what happened in
 * plain words; the message adds both ways forward (retry, or llama.cpp).
 */
export class CoreUnavailableError extends Error {
  override readonly name = "CoreUnavailableError";
  readonly stage: CoreFailureStage;
  readonly reasonCode: CoreFailureReason;
  readonly reason: string;
  readonly retryable: boolean;

  constructor(opts: { stage: CoreFailureStage; reasonCode: CoreFailureReason; detail?: string; retryable?: boolean; cause?: unknown }) {
    const detail = opts.detail?.trim().replace(/\.$/, "");
    const reason = detail ? `${STAGE_TEXT[opts.stage]}: ${detail}.` : `${STAGE_TEXT[opts.stage]}.`;
    super(`${reason} ${CORE_RETRY_HINT} ${CORE_SWITCH_BACK_HINT}`, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.stage = opts.stage;
    this.reasonCode = opts.reasonCode;
    this.reason = reason;
    this.retryable = opts.retryable ?? !NOT_RETRYABLE.has(opts.reasonCode);
  }

  get info(): CoreFailureInfo {
    return { stage: this.stage, reasonCode: this.reasonCode, retryable: this.retryable, reason: this.reason };
  }
}

export function isCoreUnavailableError(err: unknown): err is CoreUnavailableError {
  return err instanceof CoreUnavailableError;
}

const DISK_ERRNO = new Set(["ENOSPC", "EDQUOT", "EROFS"]);

function errnoOf(err: unknown): string | null {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur && typeof cur === "object"; depth += 1) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/** A short fixed word for an arbitrary failure. */
export function classifyCoreFailure(err: unknown): CoreFailureReason {
  const code = errnoOf(err);
  if (code && DISK_ERRNO.has(code)) return "disk";
  if (code === "ENOENT" || code === "EACCES" || code === "ENOEXEC") return "spawn";
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number") return status >= 500 || status === 408 || status === 429 ? "server" : "unknown";
  if (err instanceof Error && (err.name === "TimeoutError" || (err instanceof TypeError && /fetch failed/.test(err.message)))) return "network";
  if (err instanceof DownloadGaveUpError) return "network";
  const kind = classifyDownloadError(err);
  if (kind === "server") return "server";
  if (kind === "transport" && code) return "network";
  return "unknown";
}

/** True for a cancellation, which is never a failure and never retried. */
export function isCoreCancellation(err: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || (err instanceof Error && err.name === "AbortError");
}

/**
 * Turn a failure at `stage` into a CoreUnavailableError. A cancellation and
 * a non-Error value stay untouched; an existing CoreUnavailableError keeps
 * the stage where it first happened.
 */
export function toCoreUnavailable(err: unknown, stage: CoreFailureStage, signal?: AbortSignal): unknown {
  if (isCoreCancellation(err, signal) || !(err instanceof Error)) return err;
  if (err instanceof CoreUnavailableError) return err;
  return new CoreUnavailableError({ stage, reasonCode: classifyCoreFailure(err), detail: err.message, cause: err });
}

/** Kept for callers that only need the text: the same structured error, stage `start`. */
export function withSwitchBackHint(err: unknown, signal?: AbortSignal): unknown {
  return toCoreUnavailable(err, "start", signal);
}
