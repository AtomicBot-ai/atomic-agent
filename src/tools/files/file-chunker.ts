/**
 * Cut extracted text into the chunks the index stores and searches.
 *
 * A segment is a run of text with one place in the file: a PDF page, a
 * stretch of a recording, or the whole document when it has no pages.
 * Chunks never cross a segment, so every chunk keeps the page (or time)
 * a citation points at. Each segment is cut at about
 * {@link CHUNK_TARGET_CHARS}, at the last paragraph break, line break,
 * sentence end or space before the limit, in that order of preference.
 */

export const CHUNK_TARGET_CHARS = 1000;
/** A cut is looked for only after this many characters. */
const CHUNK_MIN_CUT = 600;

export interface TextSegment {
  text: string;
  page?: number;
  timeSec?: number;
}

export interface FileChunk {
  /** 0-based order in the file. */
  ord: number;
  page?: number;
  timeSec?: number;
  text: string;
}

/** `--- page 12 ---` on a line of its own, as the PDF extractor writes it. */
const PAGE_DIVIDER = /^--- page (\d+) ---$/gm;

/**
 * Split the PDF extractor's output into one segment per page, by its
 * `--- page N ---` dividers. Text before the first divider (a notice) is
 * dropped; pages with no text are left out.
 */
export function pageSegments(text: string): TextSegment[] {
  const markers = [...text.matchAll(PAGE_DIVIDER)];
  if (markers.length === 0) return text.trim().length > 0 ? [{ text }] : [];
  const segments: TextSegment[] = [];
  for (let i = 0; i < markers.length; i += 1) {
    const marker = markers[i]!;
    const start = marker.index! + marker[0].length;
    const end = i + 1 < markers.length ? markers[i + 1]!.index! : text.length;
    const body = text.slice(start, end).trim();
    if (body.length > 0) segments.push({ text: body, page: Number(marker[1]) });
  }
  return segments;
}

/** All chunks of a file, in order. */
export function chunkSegments(
  segments: readonly TextSegment[],
  target: number = CHUNK_TARGET_CHARS,
): FileChunk[] {
  const chunks: FileChunk[] = [];
  for (const segment of segments) {
    for (const text of splitText(segment.text, target)) {
      chunks.push({
        ord: chunks.length,
        ...(segment.page !== undefined ? { page: segment.page } : {}),
        ...(segment.timeSec !== undefined ? { timeSec: segment.timeSec } : {}),
        text,
      });
    }
  }
  return chunks;
}

/** Cut one text into pieces of at most `target` characters, none empty. */
export function splitText(text: string, target: number = CHUNK_TARGET_CHARS): string[] {
  const pieces: string[] = [];
  let rest = text.replace(/\r\n/g, "\n").trim();
  const minCut = Math.min(CHUNK_MIN_CUT, Math.floor(target * 0.6));
  while (rest.length > target) {
    const cut = findCut(rest, target, minCut);
    const piece = rest.slice(0, cut).trim();
    if (piece.length > 0) pieces.push(piece);
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces;
}

function findCut(text: string, target: number, minCut: number): number {
  const window = text.slice(0, target);
  for (const breaker of ["\n\n", "\n", ". ", "! ", "? ", "; ", " "]) {
    const at = window.lastIndexOf(breaker);
    if (at >= minCut) return at + breaker.length;
  }
  return target;
}
