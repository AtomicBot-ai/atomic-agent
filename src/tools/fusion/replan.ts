import type { WorkerTaskResult, WorkerTaskStatus } from "./worker-result.js";

/**
 * Automatic replanning after a fan-out (ATO-941).
 *
 * Until now a failed part ended the planner's turn as often as not: the
 * orchestrator replied with what stood and the person typed "continue"
 * to get the rest. With `llm.runMode.fusion.autoReplan: N` the fan-out's
 * result names every task that did not close, from the facts (its
 * status, its error, its failed checks and judge findings, all already
 * on the row), with how many replans it has left this turn; the loop
 * then holds the planner's next step to `fusion.delegate`
 * (`src/agent/fusion-replan.ts`). A task that used its N replans is
 * listed as exhausted, for the planner to report, not to retry.
 */

/** Statuses that leave a task open. `cancelled` only when it was held. */
const OPEN_STATUSES: ReadonlySet<WorkerTaskStatus> = new Set([
  "failed",
  "needs_orchestrator",
  "no_changes",
  "max_steps",
  "timeout",
  "queued",
]);

export const HELD_FOR_REPLAN = "not started: held for the replan";

export interface ReplanTask {
  id: string;
  status: WorkerTaskStatus;
  /** The row's own error, or its status when it has none. */
  why: string;
  /** Replans left after this one is sent back; 0 for an exhausted task. */
  replansLeft: number;
}

export interface ReplanReport {
  pending: ReplanTask[];
  exhausted: ReplanTask[];
  max: number;
}

function isOpen(result: WorkerTaskResult): boolean {
  if (OPEN_STATUSES.has(result.status)) return true;
  return (
    result.status === "cancelled" &&
    (result.error ?? "").startsWith(HELD_FOR_REPLAN)
  );
}

/**
 * Which tasks go back to the planner. `attempts(id)` is how many times
 * the task was run this turn, this call included; a task run `max + 1`
 * times has used every replan.
 */
export function describeReplan(
  results: readonly WorkerTaskResult[],
  attempts: (taskId: string) => number,
  max: number,
): ReplanReport {
  const pending: ReplanTask[] = [];
  const exhausted: ReplanTask[] = [];
  for (const result of results) {
    if (!isOpen(result)) continue;
    const used = Math.max(0, attempts(result.id) - 1);
    const left = max - used;
    const task: ReplanTask = {
      id: result.id,
      status: result.status,
      why: (result.error ?? result.status).replace(/\s+/g, " ").slice(0, 300),
      replansLeft: Math.max(0, left - 1),
    };
    if (left > 0) pending.push(task);
    else exhausted.push(task);
  }
  return { pending, exhausted, max };
}

export function renderReplanBlock(report: ReplanReport): string {
  const parts: string[] = [];
  if (report.pending.length > 0) {
    parts.push(
      [
        `REPLAN REQUIRED — these tasks did not close. Your next step must be \`fusion.delegate\` again: rewrite each brief from the facts above (the error, the failed checks, the judge's findings), keep the same task ids, and include anything held for them.`,
        ...report.pending.map(
          (t) =>
            `- ${t.id} (${t.status}): ${t.why} — ${t.replansLeft} more replan${t.replansLeft === 1 ? "" : "s"} after this one`,
        ),
      ].join("\n"),
    );
  }
  if (report.exhausted.length > 0) {
    parts.push(
      [
        `NO REPLANS LEFT (${report.max} used) — do not send these again this turn; tell the person plainly what failed and why:`,
        ...report.exhausted.map((t) => `- ${t.id} (${t.status}): ${t.why}`),
      ].join("\n"),
    );
  }
  return parts.length === 0 ? "" : `\n\n${parts.join("\n\n")}`;
}
