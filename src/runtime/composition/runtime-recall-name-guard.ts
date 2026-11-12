import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { GroundingConversationSource } from "../../memory/name-grounding.js";
import type { LessonStore } from "../../memory/lessons/lesson-store.js";
import type { MemoryStore } from "../../memory/memory-store.js";
import { createRecallNameGuard, type RecallNameGuard } from "../../memory/recall-name-guard.js";

/**
 * ATO-321. Build the recall-time name guard and start the boot check of
 * the names recent notes and active lessons claim. The check runs in the
 * background, never blocks boot and never changes a row; until a name is
 * checked, rows claiming it stay out of the prompt.
 */
export function startRecallNameGuard(args: {
  source: GroundingConversationSource;
  notesStore: MemoryStore;
  lessonStore: LessonStore | null;
  logger: StructuredLogger;
}): RecallNameGuard {
  const guard = createRecallNameGuard({ source: args.source, logger: args.logger });
  let texts: string[];
  try {
    texts = args.notesStore
      .list({ limit: 200, excludeArchived: true })
      .map((entry) => entry.content);
    if (args.lessonStore) {
      for (const row of args.lessonStore.listIndex({ limit: 100 })) {
        const lesson = args.lessonStore.getById(row.id);
        texts.push(lesson ? `${lesson.activation}\n${lesson.principle}` : row.activation);
      }
    }
  } catch (err) {
    args.logger.warn("recall name prefetch could not read memory; names are checked on first recall", {
      error: err instanceof Error ? err.message : String(err),
    });
    return guard;
  }
  void guard.prefetch(texts).catch((err: unknown) => {
    args.logger.warn("recall name prefetch failed; unchecked names stay out of the prompt", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
  return guard;
}
