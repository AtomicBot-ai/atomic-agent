import type { MemoryEntry, MemoryIndexEntry } from "./memory-store.js";

/**
 * Render the top-K "hot" notes block. Emitted by `build-prompt` as the
 * `### recalled` section when the agent loop pre-fetches notes
 * relevant to the current user turn. Lives strictly in the variable
 * tail — growing / shrinking the block never invalidates the stable
 * prefix KV cache.
 *
 * Output shape:
 *   - #42 [tag1, tag2] preview of note body…
 *   - #17 project convention observed yesterday
 *
 * The renderer never allocates beyond the input array; truncation is
 * the caller's job (budget clipping happens via `truncateToTokens`).
 */
export function renderRecalledSection(
  entries: readonly MemoryEntry[],
  opts: { previewChars: number },
): string {
  if (entries.length === 0) return "(no notes recalled)";
  return entries.map((e) => renderRecalledLine(e, opts.previewChars)).join("\n");
}

/**
 * Render the compact "warm" pointer block. Emitted by `build-prompt`
 * as the `### memory-index` section — a list of `#id tags preview`
 * lines that the agent can drill into via
 * `memory.notes.recall { id }` on demand.
 */
export function renderMemoryIndexSection(
  entries: readonly MemoryIndexEntry[],
): string {
  if (entries.length === 0) return "(no memory index)";
  const sorted = [...entries].sort((a, b) => a.id - b.id);
  return sorted
    .map((e) => {
      const tags = e.tags.length > 0 ? ` [${e.tags.join(", ")}]` : "";
      return `- #${e.id}${tags} ${e.preview}`;
    })
    .join("\n");
}

/**
 * Render a single `### recalled` line. Exposed for use in tests and in
 * downstream components that need to re-render individual lines
 * without pulling in the whole store.
 */
export function renderRecalledLine(
  entry: MemoryEntry,
  previewChars: number,
): string {
  const tags = entry.tags.length > 0 ? ` [${entry.tags.join(", ")}]` : "";
  const preview = clipPreview(entry.content, previewChars);
  return `- #${entry.id}${tags} ${preview}`;
}

function clipPreview(raw: string, maxChars: number): string {
  const normalised = raw.replace(/\s+/g, " ").trim();
  if (normalised.length <= maxChars) return normalised;
  if (maxChars <= 1) return normalised.slice(0, maxChars);
  return `${normalised.slice(0, maxChars - 1)}…`;
}
