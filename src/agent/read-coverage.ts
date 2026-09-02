import type { CompressedToolResult } from "../compressor/result-compressor.js";
import { parseReadCoverage } from "../tools/os/fs-read-coverage.js";

/**
 * Semantic progress signal for file reads (issue #114, companion of #118).
 *
 * `ToolLoopTracker` hashes canonical arguments, so two reads of the same
 * unchanged file with shifted `offset`/`limit` are different signatures
 * and neither the repeat counter nor the no-progress streak ever fires —
 * even when the second read returns lines the first one already showed.
 * `os.fs.read` is also (correctly) excluded from the wandering detector,
 * because scanning many files is legitimate work.
 *
 * What is missing is not a fourth way to hash arguments but a different
 * question: did this read show the model a line it had not already seen?
 * That is answered by the RESULT — the resolved file, the version of its
 * content, and the range that actually came back — which is why this
 * detector sits beside the argument-hashing machinery and consumes
 * `os.fs.read` results, and why it only ever produces the same kind of
 * warn signal the tracker's other detectors do.
 *
 * Coverage is per file VERSION: a content change starts a fresh, empty
 * coverage set, so re-reading a file after editing it is progress.
 */

/** 1-based inclusive line range. */
export interface LineRange {
  start: number;
  end: number;
}

/** What one successful `os.fs.read` observed, for coverage bookkeeping. */
export interface ReadObservation {
  /** Canonical (symlink-resolved) path — the file's identity. */
  path: string;
  /** Fingerprint of the content this read looked at. */
  contentHash: string;
  /** Range returned, or `null` when the read returned no lines at all. */
  span: LineRange | null;
  /** Lines visible in the read window (see `ReadCoverageDetail`). */
  totalLines: number;
  /**
   * Whether this read rendered `LINE_NUMBER|` prefixes. Part of the
   * coverage IDENTITY, not of the span: the same lines rendered
   * differently are different text, so a rendering switch starts a fresh
   * coverage set exactly the way a content change does.
   */
  numbered: boolean;
  /**
   * Whether the file has content past `totalLines` that the read's byte
   * budget hid. Only used to word the notice honestly — a repeat of an
   * unreachable range is still a repeat, but the fix for it is a bigger
   * `maxBytes`, not a different offset.
   */
  truncated: boolean;
}

/**
 * Extract a read observation from a completed tool result, or `null` when
 * the result carries no usable read semantics.
 *
 * Returns `null` for every non-`os.fs.read` tool and for every failed
 * read: an error result has no returned range, and inventing one (say,
 * the requested offset/limit) would credit coverage for lines the model
 * never saw and could then suppress a later, genuinely useful read. A
 * truncated read is NOT skipped — it returned real lines — but it only
 * ever contributes the range it actually returned, never the whole file.
 */
export function classifyReadResult(
  tool: string,
  result: CompressedToolResult,
): ReadObservation | null {
  if (tool !== "os.fs.read") return null;
  if (result.status !== "ok") return null;
  const detail = parseReadCoverage(result.details);
  if (detail === null) return null;
  return {
    path: detail.path,
    contentHash: detail.contentHash,
    span:
      detail.startLine === 0
        ? null
        : { start: detail.startLine, end: detail.endLine },
    totalLines: detail.totalLines,
    numbered: detail.numbered,
    truncated: detail.truncated,
  };
}

/**
 * How many lines of `span` are not already in `covered`.
 *
 * `covered` is expected to be sorted, disjoint and non-adjacent (the
 * shape `mergeRange` maintains). Zero means the read was fully contained
 * in what the turn had already seen — the no-progress case the issue is
 * about, which a plain "same start line?" check misses whenever the model
 * shifts the offset.
 *
 * The result is clamped at zero so it is always a count of lines, never
 * a negative number. `covered` reaching here overlapping violates that
 * contract but is possible — this function is exported — and overlapping
 * ranges subtract their shared lines once per range, so the raw
 * arithmetic can go below zero. That matters because callers test the
 * result BOTH ways: `> 0` means progress, and `=== 0` is what extends
 * the no-progress streak. An unclamped `-6` would answer "no" to both
 * and silently reset the streak.
 */
export function newlyCoveredCount(
  covered: readonly LineRange[],
  span: LineRange,
): number {
  let fresh = span.end - span.start + 1;
  for (const range of covered) {
    if (range.end < span.start) continue;
    if (range.start > span.end) break;
    fresh -= Math.min(range.end, span.end) - Math.max(range.start, span.start) + 1;
  }
  return Math.max(0, fresh);
}

/**
 * Fold `span` into `covered`, returning a new sorted, disjoint list.
 *
 * Adjacent ranges are merged (`1-40` + `41-80` → `1-80`) so ordinary
 * pagination collapses to one interval instead of growing the list by one
 * entry per page — and so a later read of `40-45` is correctly seen as
 * fully covered rather than falling into a seam between two intervals.
 */
export function mergeRange(
  covered: readonly LineRange[],
  span: LineRange,
): LineRange[] {
  const merged: LineRange[] = [];
  let current = { ...span };
  let inserted = false;
  for (const range of covered) {
    if (range.end + 1 < current.start) {
      merged.push(range);
      continue;
    }
    if (range.start > current.end + 1) {
      if (!inserted) {
        merged.push(current);
        inserted = true;
      }
      merged.push(range);
      continue;
    }
    current = {
      start: Math.min(current.start, range.start),
      end: Math.max(current.end, range.end),
    };
  }
  if (!inserted) merged.push(current);
  return merged.sort((a, b) => a.start - b.start);
}

/**
 * Compact human description of a coverage set (`"1-40, 88-120"`) for the
 * notice text. Line numbers only — no file content ever reaches a
 * message, an event, or a log line from this detector.
 */
export function describeCoverage(
  covered: readonly LineRange[],
  maxRanges = 4,
): string {
  if (covered.length === 0) return "";
  const shown = covered
    .slice(0, maxRanges)
    .map((range) => (range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`));
  return covered.length > maxRanges
    ? `${shown.join(", ")}, … (${covered.length - maxRanges} more)`
    : shown.join(", ");
}
