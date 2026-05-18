import type {
  LessonLifecycleHook,
  LessonLifecycleOutcome,
} from "../../agent/agent-loop.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";

import type { LessonStore } from "./lesson-store.js";

/**
 * Phase 6 — default implementation of `LessonLifecycleHook`. Drives
 * `LessonStore.bumpSuccess` / `bumpFailure` for each surfaced lesson
 * id. Idempotent: the agent loop already deduplicates ids, but the
 * hook tolerates duplicates anyway because both store calls are
 * single-row UPDATEs guarded by `WHERE id = ? AND status = 'active'`
 * — bumping a deprecated lesson is a silent no-op (returns `false`).
 *
 * Failure isolation: a sqlite error on one id never aborts the
 * remaining bumps. Errors are logged at WARN and counted in the
 * caller-supplied logger only.
 */
export interface LessonLifecycleHookOptions {
  lessonStore: LessonStore;
  logger?: StructuredLogger;
}

export function createLessonLifecycleHook(
  opts: LessonLifecycleHookOptions,
): LessonLifecycleHook {
  const { lessonStore, logger } = opts;
  return {
    recordTurnOutcome({ sessionId, surfacedLessonIds, outcome }): void {
      // Defensive dedup — the agent loop already passes a Set-derived
      // array, but a misbehaving caller could pass duplicates.
      const seen = new Set<number>();
      for (const id of surfacedLessonIds) {
        if (seen.has(id)) continue;
        seen.add(id);
        try {
          applyBump(lessonStore, id, outcome);
        } catch (err) {
          logger?.warn?.("lesson lifecycle bump failed", {
            sessionId,
            lessonId: id,
            outcome,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
  };
}

function applyBump(
  store: LessonStore,
  id: number,
  outcome: LessonLifecycleOutcome,
): void {
  if (outcome === "success") {
    store.bumpSuccess(id);
  } else {
    store.bumpFailure(id);
  }
}
