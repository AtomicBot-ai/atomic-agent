import type { MemoryEntry, MemoryStore } from "../memory-store.js";
import type { ReflectionInput, ReflectionRunner } from "../reflection/reflection-runner.js";

import type { NoteReconcileRunner } from "./note-reconcile-runner.js";

/**
 * ATO-672. Decorator: base reflection first, then note reconciliation
 * over the notes that reflection call just wrote. The reflection runner
 * itself is untouched; the new notes are found as the session's
 * `reflection`-tagged rows created since this call started (a dedup merge
 * into an older row is not new and is skipped, which is right: nothing
 * new was said).
 *
 * Fire-safe like every reflection decorator: a closed store at shutdown
 * or a reconcile failure never escapes `reflect()`.
 */
export function createReconcileAwareReflectionRunner(args: {
  reflection: ReflectionRunner;
  reconciler: NoteReconcileRunner;
  notesStore: MemoryStore;
  now?: () => number;
}): ReflectionRunner {
  const now = args.now ?? Date.now;
  return {
    async reflect(input: ReflectionInput): Promise<void> {
      const startedAt = now();
      try {
        await args.reflection.reflect(input);
      } catch {
        // ReflectionRunner is already fire-safe — defence in depth.
      }
      let fresh: MemoryEntry[];
      try {
        fresh = args.notesStore
          .list({ limit: 10 })
          .filter(
            (e) =>
              e.sessionId === input.sessionId &&
              e.createdAt >= startedAt &&
              e.tags.includes("reflection"),
          );
      } catch {
        return;
      }
      if (fresh.length === 0) return;
      try {
        await args.reconciler.reconcile({ sessionId: input.sessionId, notes: fresh });
      } catch {
        // NoteReconcileRunner is fire-safe too — defence in depth.
      }
    },
    abortPending(options) {
      args.reflection.abortPending(options);
      args.reconciler.abortPending(options);
    },
  };
}
