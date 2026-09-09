/**
 * Pure order arithmetic for the rail's Sessions list.
 *
 * The list is recency-sorted until the operator touches it. The first
 * move snapshots the displayed ids as a manual order (persisted under
 * `tui.sessionRail.order`); from then on ids in that order keep it, and
 * ids the order has never seen — a thread started afterwards — go to
 * the TOP, still by recency among themselves, so a new conversation
 * lands where a recency-sorted rail would have put it anyway.
 */

/**
 * Arrange `entries` by `order`. An empty order is "no opinion": the
 * incoming (recency) order stands. Otherwise ids named by `order` form
 * a block sorted by their position in it, and everything else sits
 * above that block in its incoming order. Ids in `order` that have no
 * entry are ignored — a deleted thread leaves a stale id behind until
 * the next write prunes it.
 */
export function applySessionRailOrder<T extends { sessionId: string }>(
  entries: readonly T[],
  order: readonly string[],
): T[] {
  if (order.length === 0) return [...entries];
  const rank = new Map<string, number>();
  order.forEach((id, index) => {
    if (!rank.has(id)) rank.set(id, index);
  });
  const unknown: T[] = [];
  const known: T[] = [];
  for (const entry of entries) {
    (rank.has(entry.sessionId) ? known : unknown).push(entry);
  }
  known.sort(
    (a, b) => (rank.get(a.sessionId) ?? 0) - (rank.get(b.sessionId) ?? 0),
  );
  return [...unknown, ...known];
}

/**
 * Move the id at `from` so it lands at index `to`. Both indices are
 * clamped to the list; `from === to` (after clamping) or an empty list
 * returns a copy unchanged. Never mutates its input.
 */
export function moveSessionInOrder(
  ids: readonly string[],
  from: number,
  to: number,
): string[] {
  const next = [...ids];
  if (next.length === 0) return next;
  const max = next.length - 1;
  const source = Math.min(max, Math.max(0, from));
  const target = Math.min(max, Math.max(0, to));
  if (source === target) return next;
  const [moved] = next.splice(source, 1);
  if (moved === undefined) return next;
  next.splice(target, 0, moved);
  return next;
}

/**
 * The order the rail should persist after `sessionId`, displayed in
 * `displayedIds`, is dropped on `toIndex`. `null` when the id is not on
 * the list or the move changes nothing — the caller then writes nothing.
 */
export function computeMovedOrder(
  displayedIds: readonly string[],
  sessionId: string,
  toIndex: number,
): string[] | null {
  const from = displayedIds.indexOf(sessionId);
  if (from < 0) return null;
  const next = moveSessionInOrder(displayedIds, from, toIndex);
  return next.every((id, index) => id === displayedIds[index]) ? null : next;
}

/** Drop ids from `order` that no longer name a live session. */
export function pruneSessionRailOrder(
  order: readonly string[],
  liveIds: readonly string[],
): string[] {
  const live = new Set(liveIds);
  return order.filter((id) => live.has(id));
}
