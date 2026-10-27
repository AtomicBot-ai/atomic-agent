/**
 * Refuse a write that would put a masked-secret marker into a file
 * (ATO-1077).
 *
 * Tool output reaches the model with credentials replaced by markers
 * such as `[redacted:openrouter-key]` (`src/tools/tool-output-secrets.ts`).
 * A model that read `.env` and then rewrites it whole would write those
 * markers back over the real keys, and the keys are gone. So
 * `os.fs.write`, `os.fs.edit` and `os.fs.patch` compare the file before
 * and after: a marker the new content holds more often than the file
 * already did is refused before the operator is asked, with nothing
 * written. A marker already in the file (a doc about this feature, an
 * earlier copy) may stay where it is.
 */

/** The marker shape `redactedMarker` produces (`src/error-reporting/secret-detector.ts`). */
const MARKER_RE = /\[redacted:[A-Za-z0-9_.-]{1,64}\]/g;

function countMarkers(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  if (!text.includes("[redacted:")) return counts;
  for (const match of text.matchAll(MARKER_RE)) {
    counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
  }
  return counts;
}

/** The first marker `after` adds over `before`, or `null` when it adds none. */
export function addedMaskedMarker(before: string, after: string): string | null {
  const added = countMarkers(after);
  if (added.size === 0) return null;
  const had = countMarkers(before);
  for (const [marker, count] of added) {
    if (count > (had.get(marker) ?? 0)) return marker;
  }
  return null;
}

/**
 * Throw when the change from `before` to `after` would write a
 * masked-secret marker into `display`. `before` is `""` for a new file.
 */
export function refuseMaskedSecretWrite(
  tool: string,
  display: string,
  before: string,
  after: string,
): void {
  const marker = addedMaskedMarker(before, after);
  if (marker === null) return;
  throw new Error(
    `${tool}: this text contains a masked secret (${marker}) that is not in ${display}; ` +
      "writing it would replace the real value with the marker. Nothing was written. " +
      "Edit around that line instead (os.fs.edit on the lines you need to change), and leave the masked value out of your text.",
  );
}
