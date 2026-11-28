/**
 * Reordering the parked-message queue (ATO-2476). Pure: `ChatOrchestrator`
 * owns the queue and the steer watermark and calls this.
 *
 * The queue runs from its front. Its first `ahead` entries are steers the
 * running turn refused (`queueAsSteer`), parked ahead of ordinary backlog.
 * A message moved in among them joins them and one moved out of them
 * leaves them, so the watermark stays a prefix of the queue and the next
 * refused steer still lands right behind the last parked one.
 */

/**
 * Moves `queue[from]` to index `to` (its index once moved), in place.
 * Returns the new watermark, or `null` when either index is out of range
 * or nothing would move.
 */
export function moveQueuedMessage(
  queue: string[],
  from: number,
  to: number,
  ahead: number,
): number | null {
  const n = queue.length;
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
  if (from < 0 || from >= n || to < 0 || to >= n || from === to) return null;
  const mark = Math.max(0, Math.min(ahead, n));
  const wasAhead = from < mark;
  const rest = wasAhead ? mark - 1 : mark;
  const [moved] = queue.splice(from, 1);
  if (moved === undefined) return null;
  queue.splice(to, 0, moved);
  return rest + (to < rest || (to === rest && wasAhead) ? 1 : 0);
}
