import type { LessonStore } from "../lessons/lesson-store.js";
import type { MemoryStore } from "../memory-store.js";
import type { ProcedureStore } from "../procedures/procedure-store.js";
import type { ProfileStore } from "../profile-store.js";
import type {
  ReflectionInput,
  ReflectionRunner,
} from "../reflection/reflection-runner.js";

import type { VoteCandidate } from "./vote-prompt.js";
import type { VoteRunner } from "./vote-runner.js";

/**
 * Memory-v2 phase 7a. Decorator that composes the existing
 * (already-link-aware) `ReflectionRunner` with the new
 * `VoteRunner` so the agent loop's existing
 * `reflectionRunner.reflect()` call site stays untouched.
 *
 * Sequencing (matches cross-phase invariant 2 in
 * `reflection-runner.ts` and §6.4 of MEMORY_FABRIC_V2.md):
 *
 *   1. await reflection.reflect(input)
 *      (which already chains SET/NOTE → link-generator →
 *       neighbor-evolver behind the scenes)
 *   2. fire-and-forget vote-runner.run({...input, candidates})
 *
 * Step 2 is best-effort: even if reflection succeeded we never
 * want its observability story polluted by a vote-runner timeout,
 * so the decorator only logs / counts vote-runner failures via the
 * runner's own metrics path. Returning before vote-runner
 * completes is intentional — both runners are fire-safe and write
 * to independent tables.
 *
 * The decorator builds the per-kind allowlist by hydrating ids
 * from the three stores. Skipped kinds (no surfaced ids, no
 * matching rows after a stale read) simply do not contribute
 * candidates; when the merged candidate list is empty the runner
 * itself short-circuits to `skipped`.
 *
 * `abortPending` is forwarded to both runners.
 */
export function createVoteAwareReflectionRunner(args: {
  reflection: ReflectionRunner;
  voteRunner: VoteRunner;
  memoryStore: MemoryStore;
  lessonStore: LessonStore | null;
  profileStore: ProfileStore | null;
  /** Phase 7b — optional store for procedure-kind allowlist hydration. */
  procedureStore?: ProcedureStore | null;
  /** Per-preview character cap. Defaults to 80. */
  previewChars?: number;
}): ReflectionRunner {
  const previewChars = args.previewChars ?? 80;
  return {
    async reflect(input: ReflectionInput): Promise<void> {
      try {
        await args.reflection.reflect(input);
      } catch {
        // ReflectionRunner is already fire-safe — defence in depth.
      }
      const candidates = hydrateCandidates(input, args, previewChars);
      if (candidates.length === 0) return;
      try {
        await args.voteRunner.run({
          sessionId: input.sessionId,
          userMessage: input.userMessage,
          assistantReply: input.assistantReply,
          candidates,
          ...(typeof input.turnIndex === "number"
            ? { turnIndex: input.turnIndex }
            : {}),
        });
      } catch {
        // VoteRunner is fire-safe too — defence in depth.
      }
    },
    abortPending(options) {
      args.reflection.abortPending(options);
      args.voteRunner.abortPending(options);
    },
  };
}

function hydrateCandidates(
  input: ReflectionInput,
  args: {
    memoryStore: MemoryStore;
    lessonStore: LessonStore | null;
    profileStore: ProfileStore | null;
    procedureStore?: ProcedureStore | null;
  },
  previewChars: number,
): VoteCandidate[] {
  const out: VoteCandidate[] = [];
  for (const id of input.recalledMemoryIds ?? []) {
    const entry = args.memoryStore.get(id);
    if (!entry) continue;
    out.push({
      kind: "memory",
      id: entry.id,
      preview: trimPreview(entry.content, previewChars),
    });
  }
  if (args.lessonStore) {
    for (const id of input.recalledLessonIds ?? []) {
      const lesson = args.lessonStore.getById(id);
      if (!lesson) continue;
      out.push({
        kind: "lesson",
        id: lesson.id,
        preview: trimPreview(lesson.activation, previewChars),
      });
    }
  }
  if (args.profileStore) {
    for (const id of input.recalledProfileFactIds ?? []) {
      const fact = args.profileStore.getById(id);
      if (!fact) continue;
      out.push({
        kind: "profile",
        id: fact.id,
        preview: trimPreview(`${fact.key}=${fact.value}`, previewChars),
      });
    }
  }
  if (args.procedureStore) {
    for (const id of input.recalledProcedureIds ?? []) {
      const proc = args.procedureStore.getById(id);
      if (!proc) continue;
      out.push({
        kind: "procedure",
        id: proc.id,
        preview: trimPreview(proc.activation, previewChars),
      });
    }
  }
  return out;
}

function trimPreview(raw: string, max: number): string {
  const s = raw.replace(/\s+/g, " ").trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
