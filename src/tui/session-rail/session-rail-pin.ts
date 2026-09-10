/**
 * Pure pin arithmetic for the rail's Sessions list.
 *
 * Pinned sessions form a block at the TOP of the rail. Inside the block
 * the rows follow the same manual `order` as everything else, so one
 * list in the config describes both halves; `pinned` only says which
 * ids belong to the block. Pinning appends to the block, unpinning puts
 * the row at the top of the unpinned half, and both are expressed by
 * rewriting `order` from the ids as displayed — the same "snapshot on
 * touch" a move does.
 */

import {
  applySessionRailOrder,
  moveSessionInOrder,
  type RailRow,
} from "./session-rail-order.js";

/** What the rail remembers between runs: the manual order and the pinned ids. */
export interface SessionRailLayout {
  readonly order: readonly string[];
  readonly pinned: readonly string[];
}

/** How many of `displayedIds` are pinned — the block always sits at 0..n-1. */
export function pinnedBlockLength(
  displayedIds: readonly string[],
  pinned: readonly string[],
): number {
  const set = new Set(pinned);
  let count = 0;
  for (const id of displayedIds) if (set.has(id)) count += 1;
  return count;
}

/**
 * Arrange `entries` into the pinned block followed by the unpinned
 * list. The block holds every pinned id that has an entry, sorted by
 * its position in `order`; pinned ids `order` has never seen go last
 * in their incoming order. The unpinned half is `applySessionRailOrder`
 * over the rest, so an unarranged rail still reads by recency below
 * its pins.
 */
export function arrangeSessionRail<T extends RailRow>(
  entries: readonly T[],
  layout: SessionRailLayout,
): T[] {
  const pinnedSet = new Set(layout.pinned);
  if (pinnedSet.size === 0) return applySessionRailOrder(entries, layout.order);
  const rank = new Map<string, number>();
  layout.order.forEach((id, index) => {
    if (!rank.has(id)) rank.set(id, index);
  });
  const ranked: T[] = [];
  const unranked: T[] = [];
  const rest: T[] = [];
  for (const entry of entries) {
    if (!pinnedSet.has(entry.sessionId)) rest.push(entry);
    else if (rank.has(entry.sessionId)) ranked.push(entry);
    else unranked.push(entry);
  }
  ranked.sort(
    (a, b) => (rank.get(a.sessionId) ?? 0) - (rank.get(b.sessionId) ?? 0),
  );
  return [...ranked, ...unranked, ...applySessionRailOrder(rest, layout.order)];
}

/**
 * Flip the pin of `sessionId`, displayed in `displayedIds`. Pinning
 * appends the row to the block; unpinning drops it at the top of the
 * unpinned half. `null` when the id is not on the list.
 *
 * `pinned` is rewritten from the displayed ids too: a pinned id that is
 * not on screen is dropped. The orchestrator loads every live pinned
 * session before displaying the list, so the only ids that can be
 * missing here are deleted ones — this is where a stale pin is pruned.
 */
export function togglePinned(
  layout: SessionRailLayout,
  displayedIds: readonly string[],
  sessionId: string,
): SessionRailLayout | null {
  const from = displayedIds.indexOf(sessionId);
  if (from < 0) return null;
  const pinnedSet = new Set(layout.pinned);
  const block = pinnedBlockLength(displayedIds, layout.pinned);
  const wasPinned = pinnedSet.has(sessionId);
  // `moveSessionInOrder` removes first, then inserts: after removing a
  // pinned row the block ends at `block - 2`, so `block - 1` is the top
  // of the unpinned half; after removing an unpinned row the block is
  // intact and `block` is the slot right after it.
  const order = moveSessionInOrder(displayedIds, from, wasPinned ? block - 1 : block);
  if (wasPinned) pinnedSet.delete(sessionId);
  else pinnedSet.add(sessionId);
  return { order, pinned: order.filter((id) => pinnedSet.has(id)) };
}

/**
 * The layout after `sessionId` is dropped on slot `toIndex` of the
 * displayed list — the desktop rule: the slot decides the pin. A drop
 * inside the pinned block (an index below its length) pins the row, a
 * drop below the block unpins it. `null` when the id is not on the
 * list or nothing would change, so the caller writes nothing.
 */
export function computeDroppedLayout(
  layout: SessionRailLayout,
  displayedIds: readonly string[],
  sessionId: string,
  toIndex: number,
): SessionRailLayout | null {
  const from = displayedIds.indexOf(sessionId);
  if (from < 0) return null;
  const max = displayedIds.length - 1;
  const to = Math.min(max, Math.max(0, toIndex));
  const block = pinnedBlockLength(displayedIds, layout.pinned);
  const pinnedSet = new Set(layout.pinned);
  const wasPinned = pinnedSet.has(sessionId);
  const shouldPin = to < block;
  const order = moveSessionInOrder(displayedIds, from, to);
  const sameOrder = order.every((id, index) => id === displayedIds[index]);
  if (sameOrder && shouldPin === wasPinned) return null;
  if (shouldPin) pinnedSet.add(sessionId);
  else pinnedSet.delete(sessionId);
  return { order, pinned: order.filter((id) => pinnedSet.has(id)) };
}
