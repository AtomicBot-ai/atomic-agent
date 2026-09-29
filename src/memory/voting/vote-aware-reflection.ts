import type { StructuredLogger } from "../../tracing/structured-logger.js";

import type { LessonStore } from "../lessons/lesson-store.js";
import type { MemoryStore } from "../memory-store.js";
import type { ProcedureStore } from "../procedures/procedure-store.js";
import type { ProfileStore } from "../profile-store.js";
import type {
  ReflectionInput,
  ReflectionRunner,
} from "../reflection/reflection-runner.js";

import type { VoteCandidate } from "./vote-prompt.js";
import type { VoteRunner, VoteTraceEvent } from "./vote-runner.js";

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
 * candidates.
 *
 * Both routes that end the turn here — an empty merged candidate
 * list, and a hydration throw — return before `voteRunner.run()`,
 * so the decorator narrates them itself through `emitTrace`.
 * Delegating the empty set to the runner the way link-gen does
 * (PR #496) is not available on this side: the runner's
 * `minCandidates` gate answers with `skipped` in its *result* and a
 * debug log, and its trace sink only ever carries per-vote rows, so
 * forwarding would leave the trace as silent as the bug. Without
 * both rows, "nothing surfaced this turn", "the stores could not be
 * read" and `memory.voting.enabled=false` are one indistinguishable
 * absence in the trace.
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
  /** Reports a hydration failure — see the guard in `reflect`. */
  logger?: StructuredLogger;
  /**
   * Optional trace sink for the two outcomes no other layer can
   * report, both of which return before `voteRunner.run()`. Shape
   * mirrors `VoteRunnerDeps.emitTrace` so bootstrap binds one sink to
   * both and every vote row lands in one stream. Fire-safe: a throwing
   * sink is swallowed.
   */
  emitTrace?: (event: VoteTraceEvent) => void;
}): ReflectionRunner {
  const previewChars = args.previewChars ?? 80;
  // Both call sites sit on the shutdown race this file exists for, so
  // the sink runs while the runtime tears down and the per-session
  // recorder it resolves may already be gone. The agent loop calls
  // `reflect()` as a bare `void`, so an unguarded throw here would
  // surface as an unhandled rejection — the very failure mode the
  // hydration guard below was added to kill.
  const safeEmit = (event: VoteTraceEvent): void => {
    if (!args.emitTrace) return;
    try {
      args.emitTrace(event);
    } catch {
      // A sink hiccup must never derail reflection — swallow.
    }
  };
  return {
    async reflect(input: ReflectionInput): Promise<void> {
      try {
        await args.reflection.reflect(input);
      } catch {
        // ReflectionRunner is already fire-safe — defence in depth.
      }
      // Hydration reads four SQLite-backed stores. Those reads can
      // throw — most often `TypeError: The database connection is not
      // open`, because runtime shutdown settles the inner reflection
      // via `abortPending()` and then closes every store while this
      // fire-and-forget continuation is still pending. `reflect()` is
      // contractually fire-safe (see `reflection-runner.ts`) and the
      // agent loop calls it as a bare `void`, so a throw escaping here
      // becomes an unhandled rejection rather than a swallowed miss.
      let candidates: VoteCandidate[];
      try {
        candidates = hydrateCandidates(input, args, previewChars);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        // Swallowing without a word would trade a visible crash for
        // silent curation loss, so the failure still gets a line.
        args.logger?.warn("vote candidate hydration failed", {
          sessionId: input.sessionId,
          error: reason,
        });
        // The log left the *trace* silent: `run()` is never reached,
        // so no per-vote row and no result-borne outcome exists, and
        // the turn reads exactly like one with voting switched off.
        // The reason names hydration so a dead SQLite handle is never
        // read as a quiet "nothing to vote on".
        safeEmit({
          type: "run",
          sessionId: input.sessionId,
          outcome: "failed",
          reason: `candidate hydration failed: ${reason}`,
        });
        return;
      }
      if (candidates.length === 0) {
        // A turn that surfaced nothing is a legitimate skip, but it
        // still has to be visible as one — see the note above the
        // factory on why the runner cannot report it from here.
        //
        // The reason names both numbers (the way the link runner's
        // gate does) because an empty candidate list has two causes a
        // reader has to separate: nothing was surfaced at all, or ids
        // were surfaced and every one of them hydrated into no row —
        // the evicted/stale-read shape, which points at the stores
        // rather than at the turn.
        safeEmit({
          type: "run",
          sessionId: input.sessionId,
          outcome: "skipped",
          candidates: 0,
          reason: `candidates=0 of ${countSurfacedIds(input, args)} surfaced ids`,
        });
        return;
      }
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

/**
 * Ids this turn offered the decorator, counting only the kinds whose
 * store is actually wired — an id for a kind that is switched off was
 * never a candidate, so counting it would read as a hydration miss.
 */
function countSurfacedIds(
  input: ReflectionInput,
  args: {
    lessonStore: LessonStore | null;
    profileStore: ProfileStore | null;
    procedureStore?: ProcedureStore | null;
  },
): number {
  return (
    (input.recalledMemoryIds?.length ?? 0) +
    (args.lessonStore ? (input.recalledLessonIds?.length ?? 0) : 0) +
    (args.profileStore ? (input.recalledProfileFactIds?.length ?? 0) : 0) +
    (args.procedureStore ? (input.recalledProcedureIds?.length ?? 0) : 0)
  );
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
