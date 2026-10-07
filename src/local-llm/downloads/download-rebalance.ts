import type { Segment } from "./download-segments.js";

/**
 * Hand an idle connection the back half of the running segment with the
 * most bytes left. The plan is made once per attempt, so without this a
 * connection that finishes its slice goes home while one slow slice
 * holds the rest of the download — the whole file waits on its worst
 * connection.
 *
 * The donor keeps the front half: its `end` moves to the cut, which its
 * stream reads on every chunk, so the request in flight stops there and
 * a retry asks only up to it. A slice is only cut when both halves stay
 * at least `minSegmentBytes`, the same floor the plan uses. Returns the
 * new piece, or `null` when nothing is worth cutting.
 */
export function splitLargestSegment(
  running: Iterable<Segment>,
  minSegmentBytes: number,
): Segment | null {
  let donor: Segment | null = null;
  let donorLeft = 0;
  for (const seg of running) {
    if (!Number.isFinite(seg.end)) continue;
    const left = seg.end - (seg.start + seg.written);
    if (left > donorLeft) {
      donor = seg;
      donorLeft = left;
    }
  }
  if (!donor || donorLeft < 2 * Math.max(1, minSegmentBytes)) return null;
  const cut = donor.start + donor.written + Math.ceil(donorLeft / 2);
  const piece: Segment = { start: cut, end: donor.end, written: 0 };
  donor.end = cut;
  return piece;
}
