import type { LessonIndexEntry } from "./lesson-store.js";

/**
 * Memory-v2 phase 5. Render the `### lessons` prompt section as a
 * **pointer view**: one compact line per active lesson, carrying
 * only `id`, optional scope/tags, and the one-sentence
 * `activation`. The full `principle` is **not** emitted here — the
 * agent must call `memory.lessons.recall { id }` to read it.
 *
 * Output shape (one line per lesson):
 *
 *   *<id> [tags] activation gist
 *
 * `tags` segment is omitted when the lesson has no tags. `<id>` is
 * prefixed with `*` for parity with `### memory-index` so the agent
 * can grep both sections the same way.
 *
 * Returns `null` when there are no lessons to surface — the build-
 * prompt layer uses `null` to skip the section entirely instead of
 * rendering an "(empty)" stub (the section is purely informational
 * so its absence costs nothing).
 */
export function renderLessonsSection(
  lessons: readonly LessonIndexEntry[],
): string | null {
  if (lessons.length === 0) return null;
  return lessons.map(renderLessonLine).join("\n");
}

function renderLessonLine(entry: LessonIndexEntry): string {
  const tags = entry.tags.length > 0 ? ` [${entry.tags.join(",")}]` : "";
  return `*${entry.id}${tags} ${escapeForLine(entry.activation)}`;
}

/**
 * Collapse newlines in the activation field so a single lesson row
 * always occupies one prompt line. The activation column is small
 * enough that we can replace verbatim; multi-line activations are
 * a pathology that the LessonStore's validation should already
 * trim away (`LESSON_ACTIVATION_MAX_LENGTH` cap), but we defend
 * here too.
 */
function escapeForLine(raw: string): string {
  if (!raw.includes("\n") && !raw.includes("\r")) return raw;
  return raw.replace(/\r?\n/g, " ").replace(/\r/g, " ");
}
