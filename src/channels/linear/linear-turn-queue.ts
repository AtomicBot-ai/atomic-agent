/**
 * Turns per Linear issue (ATO-2464): the one running and the ones
 * waiting behind it.
 *
 * A mention that arrives while the agent is still answering on the same
 * issue is queued, not refused: `runtime.runTurn` already runs turns of
 * one session in order, so the channel only has to keep an abort handle
 * per request and a cap. The same as Claude Code and Codex, where a
 * message typed during a turn waits for it. `/cancel` aborts the running
 * turn and everything queued on the issue.
 */

/** Requests one issue may hold at once, the running one included. */
export const LINEAR_QUEUE_LIMIT = 4;

export class LinearTurnQueue {
  private readonly turns = new Map<string, AbortController[]>();

  /** True while a turn for `issueId` runs or waits. */
  busy(issueId: string): boolean {
    return this.size(issueId) > 0;
  }

  /** Requests held for `issueId`, the running one included. */
  size(issueId: string): number {
    return this.turns.get(issueId)?.length ?? 0;
  }

  /** False when `issueId` already holds `LINEAR_QUEUE_LIMIT` requests. */
  hasRoom(issueId: string): boolean {
    return this.size(issueId) < LINEAR_QUEUE_LIMIT;
  }

  /** Register one more request on `issueId`; returns its abort handle. */
  add(issueId: string): AbortController {
    const controller = new AbortController();
    const list = this.turns.get(issueId) ?? [];
    list.push(controller);
    this.turns.set(issueId, list);
    return controller;
  }

  /** Forget a finished request. */
  remove(issueId: string, controller: AbortController): void {
    const list = this.turns.get(issueId);
    if (!list) return;
    const index = list.indexOf(controller);
    if (index >= 0) list.splice(index, 1);
    if (list.length === 0) this.turns.delete(issueId);
  }

  /** Abort every request on `issueId`. Returns how many were aborted. */
  cancel(issueId: string): number {
    const list = this.turns.get(issueId) ?? [];
    for (const controller of list) controller.abort();
    this.turns.delete(issueId);
    return list.length;
  }

  /** Abort everything (channel stopping). */
  cancelAll(): void {
    for (const issueId of [...this.turns.keys()]) this.cancel(issueId);
  }
}
