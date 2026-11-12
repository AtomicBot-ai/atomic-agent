import { LessonStore } from "../memory/lessons/lesson-store.js";
import { MemoryStore } from "../memory/memory-store.js";

/**
 * ATO-321. `atomic-agent memory forget --before <YYYY-MM-DD> [--yes]`:
 * clear memory left by test runs (or anything else) older than a date.
 *
 *   - Notes created before the date are deleted (their vectors and link
 *     edges go with them, through the schema's ON DELETE CASCADE).
 *   - Active lessons created before the date are deprecated, the same
 *     soft step the lesson lifecycle uses: out of recall and the prompt,
 *     still readable by id.
 *   - Profile facts are not touched; they have their own history and
 *     are edited from the memory view.
 *
 * Without `--yes` nothing changes: it prints what would be cleared.
 */
export interface MemoryForgetResult {
  cutoff: number;
  applied: boolean;
  notes: number;
  lessons: number;
}

export function forgetMemoryBefore(args: {
  dbFile: string;
  maxEntries: number;
  cutoff: number;
  apply: boolean;
}): MemoryForgetResult {
  const notes = new MemoryStore({ dbFile: args.dbFile, maxEntries: args.maxEntries });
  try {
    const db = notes.getDatabaseHandleForEmbeddings();
    const noteIds = (
      db.prepare("SELECT id FROM memories WHERE created_at < ? ORDER BY id").all(args.cutoff) as Array<{ id: number }>
    ).map((r) => r.id);
    const lessonIds = (
      db
        .prepare("SELECT id FROM lessons WHERE status = 'active' AND created_at < ? ORDER BY id")
        .all(args.cutoff) as Array<{ id: number }>
    ).map((r) => r.id);
    if (!args.apply) {
      return { cutoff: args.cutoff, applied: false, notes: noteIds.length, lessons: lessonIds.length };
    }
    let removed = 0;
    db.transaction(() => {
      for (const id of noteIds) if (notes.remove(id)) removed += 1;
    })();
    let deprecated = 0;
    if (lessonIds.length > 0) {
      const lessons = new LessonStore({ dbFile: args.dbFile });
      try {
        for (const id of lessonIds) {
          if (lessons.markDeprecated(id, "memory forget --before")) deprecated += 1;
        }
      } finally {
        lessons.close();
      }
    }
    return { cutoff: args.cutoff, applied: true, notes: removed, lessons: deprecated };
  } finally {
    notes.close();
  }
}

/** `YYYY-MM-DD` as local midnight (epoch ms), or null when it is not a real date. */
export function parseForgetDate(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date.getTime();
}
