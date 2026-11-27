import type { MemoryEntry, MemoryStore } from "../memory-store.js";

import type { ConsolidationStateStore } from "./consolidation-state-store.js";

/** Notes read per tick. */
export const CANDIDATE_PAGE_SIZE = 200;

/**
 * Which page a tick read: `first` (newest notes), `next` (the page after
 * the previous tick's), or `wrapped` (the cursor ran past the oldest
 * note, so this tick started over from the newest).
 */
export type CandidatePage = "first" | "next" | "wrapped";

export interface CandidateWindow {
  candidates: MemoryEntry[];
  page: CandidatePage;
}

/**
 * ATO-2506. One page of consolidation candidates. Eligible notes are
 * active, on, older than the cooldown and not put off by an abstain
 * backoff; all four filters run in SQL before the page limit (#903).
 *
 * Paging: a full page stores its last note as the cursor and the next
 * tick reads the page after it; a short page clears the cursor so the
 * tick after that starts again from the newest notes. Before this the
 * window was always the newest 200 eligible notes, so on a large store
 * everything older was never consolidated.
 */
export function selectCandidatePage(
  deps: {
    memoryStore: Pick<MemoryStore, "list">;
    stateStore: Pick<ConsolidationStateStore, "readCursor" | "writeCursor">;
  },
  args: { now: number; cooldownMs: number; pageSize?: number },
): CandidateWindow {
  const pageSize = args.pageSize ?? CANDIDATE_PAGE_SIZE;
  const query = {
    excludeArchived: true,
    // ATO-1124: a note the person turned off is not distilled.
    excludeDisabled: true,
    updatedBefore: args.now - args.cooldownMs,
    consolidationDueAt: args.now,
    limit: pageSize,
  };
  const cursor = deps.stateStore.readCursor();
  let page: CandidatePage = cursor ? "next" : "first";
  let candidates = deps.memoryStore.list(
    cursor ? { ...query, after: cursor } : query,
  );
  if (candidates.length === 0 && cursor) {
    candidates = deps.memoryStore.list(query);
    page = "wrapped";
  }
  const last = candidates[candidates.length - 1];
  deps.stateStore.writeCursor(
    candidates.length >= pageSize && last
      ? { updatedAt: last.updatedAt, id: last.id }
      : null,
  );
  return { candidates, page };
}
