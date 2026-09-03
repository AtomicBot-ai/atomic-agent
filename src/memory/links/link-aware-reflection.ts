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
 * The decorator skips link-gen when:
 *   - `recalledMemoryIds` is missing or shorter than the runner's
 *     `minCandidates` (already enforced inside the runner; the
 *     decorator short-circuits to avoid a needless DB read).
 *   - Hydrating ids into `{id, body}` yields fewer than
 *     `minCandidates` rows (e.g. recently evicted ids).
 *
 * `abortPending` is forwarded to both runners.
 */
export function createLinkAwareReflectionRunner(args: {
  reflection: ReflectionRunner;
  linkGenerator: LinkGeneratorRunner;
  notesStore: MemoryStore;
  /** Mirrors `LinkGeneratorRunnerDeps.minCandidates`. Defaults to 2. */
  minCandidates?: number;
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
      if (ids.length < minCandidates) return;
      // Same shutdown race as the vote-aware decorator: `notesStore`
      // is a SQLite handle that runtime shutdown may close while this
      // fire-and-forget continuation is pending, and a closed
      // better-sqlite3 statement throws `TypeError`. `reflect()` must
      // stay fire-safe for the agent loop's bare `void` call.
      const candidates: { id: number; body: string }[] = [];
      try {
        for (const id of ids) {
          const entry = args.notesStore.get(id);
          if (!entry) continue;
          candidates.push({ id: entry.id, body: entry.content });
        }
      } catch {
        return;
      }
      if (candidates.length < minCandidates) return;
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
