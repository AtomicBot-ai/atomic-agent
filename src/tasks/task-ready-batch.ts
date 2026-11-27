import type { TaskRecord } from "./task-types.js";

/**
 * Up to `limit` tasks from a paged query, without the cards still
 * waiting on other cards (ATO-2498). A waiting card stays `pending` with
 * the oldest sort key, so filtering after one `LIMIT` would let ten of
 * them hold every slot of the scheduler pass on every tick and starve
 * all other due work. This pages past them instead. `waits` is the
 * dependency map: a task with no edge is ready without a lookup, and an
 * empty map takes the single page the scheduler read before.
 */
export function readyTaskBatch(
  page: (limit: number, offset: number) => TaskRecord[],
  limit: number,
  waits: ReadonlyMap<string, readonly string[]>,
  waitingOn: (id: string) => readonly string[],
): TaskRecord[] {
  if (waits.size === 0) return page(limit, 0);
  const ready: TaskRecord[] = [];
  for (let offset = 0; ready.length < limit; offset += limit) {
    const rows = page(limit, offset);
    for (const task of rows) {
      if (ready.length >= limit) break;
      if (!waits.has(task.id) || waitingOn(task.id).length === 0) ready.push(task);
    }
    if (rows.length < limit) break;
  }
  return ready;
}
