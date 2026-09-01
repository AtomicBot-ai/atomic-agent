/**
 * Split an imported note to fit the memory store's content cap
 * (`MEMORY_CONTENT_MAX_LENGTH`). Source notes are whatever size the
 * other agent allowed — Claude Code's auto-memory files routinely run
 * past 4k chars — and an import that errors on them silently loses the
 * exact notes worth keeping.
 *
 * Splits on line boundaries, packing lines greedily; a single line
 * longer than the cap (rare, but nothing stops a one-line file) is
 * hard-sliced. Deterministic, so a re-run produces the same chunks and
 * the importer's exact-content dedup still recognises them.
 */
export function splitMemoryNote(content: string, maxChars: number): string[] {
  const trimmed = content.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= maxChars) return [trimmed];
  const chunks: string[] = [];
  let current = "";
  const flush = (): void => {
    const chunk = current.trim();
    if (chunk.length > 0) chunks.push(chunk);
    current = "";
  };
  for (const line of trimmed.split("\n")) {
    const pieces: string[] = [];
    if (line.length > maxChars) {
      for (let i = 0; i < line.length; i += maxChars) {
        pieces.push(line.slice(i, i + maxChars));
      }
    } else {
      pieces.push(line);
    }
    for (const piece of pieces) {
      if (current.length + piece.length + 1 > maxChars) flush();
      current = current.length > 0 ? `${current}\n${piece}` : piece;
    }
  }
  flush();
  return chunks;
}
