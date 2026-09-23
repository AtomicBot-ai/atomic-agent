import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { MemoryStore } from "../memory-store.js";
import type {
  ReflectionInput,
  ReflectionRunner,
} from "../reflection/reflection-runner.js";

import type { LinkGeneratorRunner } from "./link-generator-runner.js";

/**
 * Memory-v2 phase 2. Decorator that composes the existing
 * `ReflectionRunner` with the new `LinkGeneratorRunner` so the agent
 * loop's existing `reflectionRunner.reflect()` call site stays
 * untouched.
 *
 * Sequencing (matches cross-phase invariant 2 in
 * `reflection-runner.ts`):
 *
 *   1. await reflection.reflect(input)
 *   2. fire-and-forget link-generator.generate({...input, candidates})
 *
 * Step 2 is best-effort: even if reflection succeeded we never want
 * its observability story polluted by a link-gen timeout, so the
 * decorator only logs / counts link-gen failures via the runner's
 * own metrics path. Returning before link-generation completes is
 * intentional — both runners are fire-safe and write to independent
 * tables.
 *
 * Too-few-candidates is NOT decided here. The decorator used to
 * `return` on both the id-count and the hydrated-row-count gates,
 * which made a link-gen that never fires indistinguishable from one
 * that is switched off. The runner's own `minCandidates` guard is the
 * first statement of its `runOne` and emits a `skipped` trace + metric
 * before any LLM call, so the decorator hands the (possibly short)
 * candidate set over and lets that guard report. The one thing the
 * decorator still short-circuits is the DB read: an id list shorter
 * than `minCandidates` cannot hydrate into enough rows, so it is
 * forwarded unhydrated.
 *
 * The decorator still bails out entirely when hydration throws — see
 * the guard in `reflect` (logged, never silent).
 *
 * `abortPending` is forwarded to both runners.
 */
export function createLinkAwareReflectionRunner(args: {
  reflection: ReflectionRunner;
  linkGenerator: LinkGeneratorRunner;
  notesStore: MemoryStore;
  /** Mirrors `LinkGeneratorRunnerDeps.minCandidates`. Defaults to 2. */
  minCandidates?: number;
  /** Reports a hydration failure — see the guard in `reflect`. */
  logger?: StructuredLogger;
}): ReflectionRunner {
  const minCandidates = args.minCandidates ?? 2;
  return {
    async reflect(input: ReflectionInput): Promise<void> {
      try {
        await args.reflection.reflect(input);
      } catch {
        // ReflectionRunner is already fire-safe — defence in depth.
      }
      const ids = input.recalledMemoryIds ?? [];
      // Same shutdown race as the vote-aware decorator: `notesStore`
      // is a SQLite handle that runtime shutdown may close while this
      // fire-and-forget continuation is pending, and a closed
      // better-sqlite3 statement throws `TypeError`. `reflect()` must
      // stay fire-safe for the agent loop's bare `void` call.
      const candidates: { id: number; body: string }[] = [];
      if (ids.length >= minCandidates) {
        try {
          for (const id of ids) {
            const entry = args.notesStore.get(id);
            if (!entry) continue;
            candidates.push({ id: entry.id, body: entry.content });
          }
        } catch (err) {
          args.logger?.warn("link candidate hydration failed", {
            sessionId: input.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
          return;
        }
      }
      try {
        await args.linkGenerator.generate({
          sessionId: input.sessionId,
          userMessage: input.userMessage,
          assistantReply: input.assistantReply,
          candidates,
        });
      } catch {
        // LinkGeneratorRunner is fire-safe too — defence in depth.
      }
    },
    abortPending(options) {
      args.reflection.abortPending(options);
      args.linkGenerator.abortPending(options);
    },
  };
}
