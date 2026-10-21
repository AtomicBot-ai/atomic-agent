/**
 * Studio: one resumable, verified HTTP download of a local model file.
 * No Electron, so the unit suite loads it from `out/main`.
 *
 * The bytes go to `<file>.part` beside the target. A stopped or dropped
 * download keeps the part file, and the next attempt asks the server for
 * the rest (`Range: bytes=<have>-`); the SHA-256 is fed the part file
 * first, so a resumed file is checked as a whole. A server that ignores the
 * range (200) restarts it from zero. Only a file of the catalog's size and
 * hash is renamed into place; a wrong one is deleted.
 *
 * The request goes to the Hugging Face mirror when one is set (huggingface.ts
 * `rewriteHuggingFaceUrl`), and `HF_TOKEN` is sent only to Hugging Face, as
 * the projector download does. Network failures are retried three times,
 * resuming; an HTTP refusal is not.
 */

import { createHash, type Hash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, realpath, rename, rm, stat, truncate } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";

import { isInside } from "./studio-paths.js";

export class StudioDownloadError extends Error {
  override readonly name = "StudioDownloadError";
  constructor(message: string, readonly code: string, readonly details?: string) {
    super(message);
  }
}

export interface DownloadTarget { url: string; savePath: string; bytes: number; sha256: string | null }

export interface DownloadOptions {
  /** The models root the file must land in (checked on real paths once the folders exist). */
  root: string;
  signal?: AbortSignal;
  /** Bytes gained (positive) or thrown away (negative, a restart), as they happen. */
  onBytes?: (delta: number) => void;
  /** Hashing the part file and the final check. */
  onVerifying?: () => void;
  request?: typeof fetch;
  /** The URL to actually request (a mirror), from the canonical one. */
  rewrite?: (url: string) => string;
  /** Extra headers for a URL (a token for Hugging Face only). */
  headers?: (url: string) => Record<string, string>;
  retries?: number;
  retryDelayMs?: number;
}

const aborted = () => new StudioDownloadError("Download stopped.", "CANCELLED");

async function sizeOf(path: string): Promise<number> {
  try { return (await stat(path)).size; } catch { return 0; }
}

/** Feed `path` (all of it) into `hash`. */
async function hashFile(path: string, hash: Hash, signal?: AbortSignal): Promise<void> {
  await pipeline(createReadStream(path), new Transform({ transform(chunk: Buffer, _e, done) { hash.update(chunk); done(); } }), { signal });
}

/** The real path of `dir` lies inside the real `root`: no link planted in the models folder leads out of it. */
async function checkInside(root: string, dir: string): Promise<void> {
  const [r, d] = await Promise.all([realpath(root), realpath(dir)]);
  if (!isInside(d, r)) throw new StudioDownloadError("A model folder leads outside the models folder.", "OUTSIDE", dir);
}

function httpError(status: number, host: string): StudioDownloadError {
  if (status === 401 || status === 403) {
    return new StudioDownloadError(
      "Hugging Face refused the download: this model is gated. Accept its licence on huggingface.co and set HF_TOKEN, then try again.",
      "GATED", `HTTP ${status} from ${host}`);
  }
  if (status === 404) return new StudioDownloadError("The model file is no longer at its address. Try again after the catalog updates.", "NOT_FOUND", `HTTP 404 from ${host}`);
  if (status === 429) return new StudioDownloadError("Hugging Face is rate limiting downloads. Try again in a few minutes.", "RATE_LIMITED", `HTTP 429 from ${host}`);
  return new StudioDownloadError(`The download failed (HTTP ${status} from ${host}).`, "HTTP_ERROR", `HTTP ${status}`);
}

function retryable(err: unknown): boolean {
  if (err instanceof StudioDownloadError) return err.code === "NETWORK" || (err.code === "HTTP_ERROR" && /HTTP 5\d\d/.test(err.details ?? ""));
  return (err as NodeJS.ErrnoException | null)?.code !== "ENOSPC";
}

/**
 * Download `target` into place, resuming a part file left by an earlier
 * attempt. Resolves once the verified file is at `savePath`; a file
 * already there with the right size is left alone.
 */
export async function downloadModelFile(target: DownloadTarget, opts: DownloadOptions): Promise<void> {
  const part = `${target.savePath}.part`;
  await mkdir(dirname(target.savePath), { recursive: true });
  await checkInside(opts.root, dirname(target.savePath));
  if ((await sizeOf(target.savePath)) === target.bytes) return;
  const retries = opts.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    if (opts.signal?.aborted) throw aborted();
    try {
      await attemptOnce(target, part, opts);
      return;
    } catch (err) {
      if (opts.signal?.aborted) throw aborted();
      if (attempt >= retries || !retryable(err)) {
        if (err instanceof StudioDownloadError) throw err;
        const e = err as NodeJS.ErrnoException;
        if (e?.code === "ENOSPC") throw new StudioDownloadError("The disk is full. Free some space and download again; what is already here is kept.", "DISK_FULL");
        throw new StudioDownloadError("The download failed. Check the connection and try again; it picks up where it stopped.", "NETWORK", e instanceof Error ? e.message : String(err));
      }
      await delay((opts.retryDelayMs ?? 2_000) * (attempt + 1), undefined, { signal: opts.signal }).catch(() => { throw aborted(); });
    }
  }
}

async function attemptOnce(target: DownloadTarget, part: string, opts: DownloadOptions): Promise<void> {
  let have = await sizeOf(part);
  if (have > target.bytes) { await rm(part, { force: true }); opts.onBytes?.(-have); have = 0; }
  const hash = createHash("sha256");
  if (have > 0) {
    opts.onVerifying?.();
    await hashFile(part, hash, opts.signal);
  }
  if (have === target.bytes) return finish(target, part, hash, opts);

  const url = opts.rewrite ? opts.rewrite(target.url) : target.url;
  const host = (() => { try { return new URL(url).host; } catch { return "the server"; } })();
  let res: Response;
  try {
    res = await (opts.request ?? fetch)(url, {
      headers: { "User-Agent": "atomic-agent/studio", ...(opts.headers?.(target.url) ?? {}), ...(have > 0 ? { Range: `bytes=${have}-` } : {}) },
      redirect: "follow",
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    if (opts.signal?.aborted) throw aborted();
    throw new StudioDownloadError(`Could not reach ${host}.`, "NETWORK", err instanceof Error ? err.message : String(err));
  }
  if (res.status === 416 && have > 0) {
    // The server has nothing past what we hold: the part is wrong. Start over.
    await rm(part, { force: true });
    opts.onBytes?.(-have);
    throw new StudioDownloadError("The partial file did not match; starting over.", "NETWORK", "HTTP 416");
  }
  if (!res.ok || !res.body) throw httpError(res.status, host);
  if (have > 0 && res.status !== 206) {
    // The range was ignored: the body is the whole file.
    await truncate(part, 0);
    opts.onBytes?.(-have);
    const fresh = createHash("sha256");
    await stream(res, part, fresh, 0, target, opts);
    return finish(target, part, fresh, opts);
  }
  await stream(res, part, hash, have, target, opts);
  return finish(target, part, hash, opts);
}

async function stream(res: Response, part: string, hash: Hash, have: number, target: DownloadTarget, opts: DownloadOptions): Promise<void> {
  let written = have;
  const counter = new Transform({
    transform(chunk: Buffer, _e, done) {
      written += chunk.length;
      if (written > target.bytes) { done(new StudioDownloadError("The server sent more than the catalog says the file holds.", "SIZE_MISMATCH")); return; }
      hash.update(chunk);
      opts.onBytes?.(chunk.length);
      done(null, chunk);
    },
  });
  const body = Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream);
  try {
    await pipeline(body, counter, createWriteStream(part, { flags: have > 0 ? "a" : "w", mode: 0o644 }), { signal: opts.signal });
  } catch (err) {
    if (opts.signal?.aborted) throw aborted();
    if (err instanceof StudioDownloadError) {
      if (err.code === "SIZE_MISMATCH") await rm(part, { force: true });
      throw err;
    }
    if ((err as NodeJS.ErrnoException)?.code === "ENOSPC") throw err;
    throw new StudioDownloadError("The connection dropped.", "NETWORK", err instanceof Error ? err.message : String(err));
  }
}

async function finish(target: DownloadTarget, part: string, hash: Hash, opts: DownloadOptions): Promise<void> {
  opts.onVerifying?.();
  const size = await sizeOf(part);
  if (size !== target.bytes) {
    // Short: the stream ended early. Kept, so the retry resumes.
    throw new StudioDownloadError("The download ended early.", "NETWORK", `${size} of ${target.bytes} bytes`);
  }
  const digest = hash.digest("hex");
  if (target.sha256 && digest !== target.sha256) {
    await rm(part, { force: true });
    opts.onBytes?.(-size);
    throw new StudioDownloadError("The downloaded file is damaged (its checksum does not match). Download it again.", "CHECKSUM_MISMATCH", `${target.savePath}: ${digest}`);
  }
  await rename(part, target.savePath);
}
