/**
 * Pure order arithmetic for the rail's Sessions list.
 *
 * The list is recency-sorted until the operator touches it. The first
 * move snapshots the displayed ids as a manual order (persisted under
 * `tui.sessionRail.order`); from then on ids in that order keep it, and
 * ids the order has never seen take the slot their date earns them —
 * as many rows down as there are rows newer than they are. A thread
 * started now is the newest thing there is, so it lands on top; a
 * four-year-old transcript that an import has just written lands beside
 * the other four-year-old rows rather than above today's work.
 */

/**
 * Arrange `entries` by `order`. An empty order is "no opinion": the
 * incoming (recency) order stands. Otherwise ids named by `order` form
 * a block sorted by their position in it, and everything else sits
 * above that block in its incoming order. Ids in `order` that have no
 * entry are ignored — a deleted thread leaves a stale id behind until
 * the next write prunes it.
 */
export function applySessionRailOrder<T extends RailRow>(
  entries: readonly T[],
  order: readonly string[],
): T[] {
  if (order.length === 0) return [...entries];
  const rank = new Map<string, number>();
  order.forEach((id, index) => {
    if (!rank.has(id)) rank.set(id, index);
  });
  const unknown: T[] = [];
  const arranged: T[] = [];
  for (const entry of entries) {
    (rank.has(entry.sessionId) ? arranged : unknown).push(entry);
  }
  arranged.sort(
    (a, b) => (rank.get(a.sessionId) ?? 0) - (rank.get(b.sessionId) ?? 0),
  );
  // Newest first, so a run of new rows keeps its own recency order as
  // each one is placed.
  unknown.sort((a, b) => b.updatedAt - a.updatedAt);
  for (const row of unknown) insertByDate(arranged, row);
  return arranged;
}

/** What the rail needs of a row to arrange it: an identity and a date. */
interface RailRow {
  sessionId: string;
  updatedAt: number;
}

/**
 * Put `row` directly below the last row that is newer than it, so it
 * ends up under everything newer and above everything older.
 *
 * Scanning from the bottom for the last newer row — rather than from
 * the top for the first older one — is what keeps this honest on a
 * hand-arranged rail, which is in no date order at all. "Before the
 * first older row" would throw a four-year-old import to the top the
 * moment the operator had dragged an old thread up there. This rule
 * holds the one property that matters either way: nothing newer ever
 * ends up below it. A thread created now has nothing newer above it,
 * so it still lands on top.
 */
function insertByDate<T extends RailRow>(rows: T[], row: T): void {
  let at = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if ((rows[i]?.updatedAt ?? 0) > row.updatedAt) {
      at = i + 1;
      break;
    }
  }
  rows.splice(at, 0, row);
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
