import * as fs from "node:fs";

import {
  completedRanges,
  discardPartialDownload,
  holesIn,
  readPartialMeta,
  resolvePartialPath,
  type ByteRange,
  type PartialDownloadMeta,
} from "./download-partial.js";

export interface ResumePlan {
  /** The sidecar found, if it names this URL. */
  stored: PartialDownloadMeta | null;
  /** Trusted byte intervals already on disk (merged, disjoint). */
  done: ByteRange[];
  /** Declared length from the sidecar, `0` when unknown or nothing is kept. */
  total: number;
  /** First byte the lead request asks for. */
  offset: number;
  /** Whether the lead carries a `Range` header at all. */
  sentRange: boolean;
  leadHeaders: Record<string, string>;
}

/**
 * Decide what a new attempt can build on. Only a sidecar naming this URL
 * with intervals that fit both the declared length and the file on disk
 * counts; anything else is discarded and the attempt starts from zero.
 */
export function describeResume(
  url: string,
  destPath: string,
  headers: Record<string, string>,
): ResumePlan {
  const stored = readPartialMeta(destPath);
  let done: ByteRange[] = stored && stored.url === url ? completedRanges(destPath, stored) : [];
  const total = done.length > 0 && stored ? stored.total : 0;
  const first = done[0];
  if (first && total === 0 && (done.length !== 1 || first[0] !== 0)) {
    // No declared length and bytes that are not one prefix: nothing to
    // ask the server for.
    done = [];
  }
  if (done.length === 0) discardPartialDownload(destPath);
  const holes: ByteRange[] =
    !first || done.length === 0
      ? []
      : total > 0
        ? holesIn(done, total)
        : [[first[1], Infinity]];
  // Where the lead request starts: the first byte we do not have. With
  // every byte present this is `total` — the range request then asks
  // for nothing, and the 416 branch publishes the file once the server
  // has confirmed it still is that file. A partial whose first hole is
  // at byte 0 (the lead had not delivered when the last run died) still
  // sends a range: a plain GET would read as "start over".
  const offset = done.length === 0 ? 0 : (holes[0]?.[0] ?? total);
  const sentRange = done.length > 0;
  const leadHeaders = { ...headers };
  if (sentRange) {
    leadHeaders.Range = `bytes=${offset}-`;
    // `If-Range` makes a server that still has the same file answer 206
    // and one that has a new one answer 200 with the whole body — the
    // restart case, handled without a second round-trip.
    const validator = stored?.etag ?? stored?.lastModified;
    if (validator) leadHeaders["If-Range"] = validator;
  }
  return { stored, done, total: done.length > 0 ? total : 0, offset, sentRange, leadHeaders };
}

/** Publish the finished `.part` and report the terminal number once. */
export function finalize(
  destPath: string,
  transferred: number,
  total: number,
  onProgress?: (percent: number, transferred: number, total: number) => void,
): void {
  fs.renameSync(resolvePartialPath(destPath), destPath);
  discardPartialDownload(destPath);
  // A 416-finalised partial never streamed, so it never reported; and a
  // streamed one may have emitted its last progress inside the throttle
  // window. Either way the terminal number goes out exactly once here.
  if (total > 0 && transferred === total) {
    onProgress?.(100, transferred, total);
  }
}
