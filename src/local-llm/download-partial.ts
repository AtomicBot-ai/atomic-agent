import * as fs from "node:fs";

/** A half-open byte interval `[start, end)`. */
export type ByteRange = readonly [start: number, end: number];

/**
 * Sidecar next to the `.part` file: what the partial bytes belong to.
 *
 * `done` lists the byte intervals already on disk. A segmented download
 * fills the file out of order, so "how much is here" is the sum of
 * these intervals, not the file size. `null` marks a sidecar written by
 * a pre-segment build: its bytes are one prefix, measured by file size.
 */
export interface PartialDownloadMeta {
  url: string;
  /** Total length the server declared, or `0` when it did not. */
  total: number;
  etag: string | null;
  lastModified: string | null;
  done: ByteRange[] | null;
}

/**
 * On-disk shape of a current sidecar. The URL sits under `source`, not
 * `url`, on purpose: a pre-segment build reads `url` and treats the
 * `.part` file size as the resume offset. Fed a sparse, out-of-order
 * partial that way it would append the tail of the file onto a hole and
 * publish a GGUF that crashes llama-server. Without `url` it sees no
 * usable partial and starts over instead — slower, but correct.
 */
const PARTIAL_META_VERSION = 2;

export function resolvePartialPath(destPath: string): string {
  return `${destPath}.part`;
}

export function resolvePartialMetaPath(destPath: string): string {
  return `${destPath}.part.json`;
}

export function partialSize(destPath: string): number {
  try {
    return fs.statSync(resolvePartialPath(destPath)).size;
  } catch {
    return 0;
  }
}

export function rmQuiet(path: string): void {
  try {
    fs.rmSync(path, { force: true });
  } catch {
    /* ignore */
  }
}

/** Sorted, disjoint, non-empty intervals; touching ones are joined. */
export function mergeRanges(ranges: readonly ByteRange[]): ByteRange[] {
  const sorted = ranges
    .filter(([start, end]) => end > start)
    .slice()
    .sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      out.push([start, end]);
    }
  }
  return out;
}

export function sumRanges(ranges: readonly ByteRange[]): number {
  let sum = 0;
  for (const [start, end] of ranges) sum += end - start;
  return sum;
}

/** The complement of `done` (already merged) inside `[0, total)`. */
export function holesIn(
  done: readonly ByteRange[],
  total: number,
): ByteRange[] {
  const holes: ByteRange[] = [];
  let cursor = 0;
  for (const [start, end] of done) {
    if (start > cursor) holes.push([cursor, Math.min(start, total)]);
    cursor = Math.max(cursor, end);
    if (cursor >= total) break;
  }
  if (cursor < total) holes.push([cursor, total]);
  return holes;
}

function parseRanges(raw: unknown): ByteRange[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ByteRange[] = [];
  for (const item of raw) {
    if (!Array.isArray(item) || item.length !== 2) return null;
    const [start, end] = item as unknown[];
    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end < start
    ) {
      return null;
    }
    out.push([start, end]);
  }
  return mergeRanges(out);
}

/**
 * Read either sidecar generation. Anything malformed reads as "no
 * sidecar", which makes the caller discard the partial — the only safe
 * answer when the bytes cannot be placed.
 */
export function readPartialMeta(destPath: string): PartialDownloadMeta | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(resolvePartialMetaPath(destPath), "utf-8"),
    ) as Record<string, unknown>;
    const total =
      typeof raw.total === "number" && raw.total > 0 ? raw.total : 0;
    const etag = typeof raw.etag === "string" ? raw.etag : null;
    const lastModified =
      typeof raw.lastModified === "string" ? raw.lastModified : null;
    if (raw.version === PARTIAL_META_VERSION) {
      if (typeof raw.source !== "string") return null;
      const done = parseRanges(raw.done);
      if (!done) return null;
      return { url: raw.source, total, etag, lastModified, done };
    }
    if (typeof raw.url !== "string") return null;
    return { url: raw.url, total, etag, lastModified, done: null };
  } catch {
    return null;
  }
}

/**
 * Written atomically: a process killed mid-write must leave the previous
 * sidecar, not half a JSON document that reads as "no partial".
 */
export function writePartialMeta(
  destPath: string,
  meta: PartialDownloadMeta,
): void {
  const path = resolvePartialMetaPath(destPath);
  const tmp = `${path}.tmp`;
  fs.writeFileSync(
    tmp,
    JSON.stringify({
      version: PARTIAL_META_VERSION,
      source: meta.url,
      total: meta.total,
      etag: meta.etag,
      lastModified: meta.lastModified,
      done: meta.done ?? [],
    }),
    "utf-8",
  );
  fs.renameSync(tmp, path);
}

/**
 * The byte intervals of `destPath`'s partial that can be trusted. A
 * pre-segment sidecar vouches for a prefix the length of the file; a
 * current one lists its intervals. Bytes past the declared total, or
 * intervals past the end of the file, make the whole partial unusable.
 */
export function completedRanges(
  destPath: string,
  meta: PartialDownloadMeta,
): ByteRange[] {
  const size = partialSize(destPath);
  const done: ByteRange[] = meta.done ?? (size > 0 ? [[0, size]] : []);
  if (meta.total > 0 && done.some(([, end]) => end > meta.total)) return [];
  // A sidecar that claims bytes the file does not have — the `.part`
  // deleted by hand, truncated by a full disk — must not turn into
  // zeros published as model weights.
  if (done.some(([, end]) => end > size)) return [];
  return done;
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
  const transferred = sumRanges(completedRanges(destPath, meta));
  if (transferred <= 0) return null;
  return { transferred, total: meta.total };
}

/** Drop a partial download and its sidecar. No-op when neither exists. */
export function discardPartialDownload(destPath: string): void {
  rmQuiet(resolvePartialPath(destPath));
  rmQuiet(resolvePartialMetaPath(destPath));
  rmQuiet(`${resolvePartialMetaPath(destPath)}.tmp`);
}
