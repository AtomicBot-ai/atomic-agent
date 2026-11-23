/**
 * The critical path of a fan-out (ATO-1586), the metric Kimi's agent
 * swarm reports.
 *
 * Three numbers close a `fusion.delegate` result:
 * - **critical path**: the longest chain through the contract's
 *   dependencies (`requires → provides`, `contract-waves.ts`), each task
 *   weighted by the time it actually worked (its duration minus its
 *   queue wait). No dependencies: the single longest task. It is the
 *   floor on the fan-out's wall time however many workers run.
 * - **total work**: every task's working time, summed. Total work over
 *   the critical path is how much parallelism the plan offered.
 * - **idle local slot**: on a local leg, slot time not spent working:
 *   slots in use × the fan-out's wall time, minus the local tasks' work.
 *   This is the "GPU sits idle" figure: a dependent waiting on its
 *   provider, a wave tail, a slow straggler.
 *
 * Report only: nothing here changes how tasks are dispatched.
 */

import { formatEstimateMs } from "./worker-fit.js";
import type { WorkerTaskResult } from "./worker-result.js";

export type PathTask = Pick<WorkerTaskResult, "id" | "durationMs" | "queueWaitMs">;

/** The time a task spent working: its duration without the queue wait. */
export function workMs(task: PathTask): number {
  return Math.max(0, task.durationMs - Math.max(0, task.queueWaitMs ?? 0));
}

export interface CriticalPath {
  /** Task ids along the chain, first provider first. */
  path: string[];
  ms: number;
}

/**
 * The longest chain through `dependencies` (task → the tasks it waits
 * for). A dependency on a task that did not run is ignored; a cycle is
 * cut where it closes, so the walk always ends.
 */
export function criticalPath(
  tasks: readonly PathTask[],
  dependencies: ReadonlyMap<string, readonly string[]>,
): CriticalPath {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const memo = new Map<string, CriticalPath>();
  const visiting = new Set<string>();
  const longestEndingAt = (id: string): CriticalPath => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const task = byId.get(id);
    if (task === undefined) return { path: [], ms: 0 };
    visiting.add(id);
    let best: CriticalPath = { path: [], ms: 0 };
    for (const dep of dependencies.get(id) ?? []) {
      if (visiting.has(dep) || !byId.has(dep)) continue;
      const before = longestEndingAt(dep);
      if (before.ms > best.ms) best = before;
    }
    visiting.delete(id);
    const own = { path: [...best.path, id], ms: best.ms + workMs(task) };
    memo.set(id, own);
    return own;
  };
  let best: CriticalPath = { path: [], ms: 0 };
  for (const task of tasks) {
    const chain = longestEndingAt(task.id);
    if (chain.ms > best.ms || best.path.length === 0) best = chain;
  }
  return best;
}

export interface FanoutPathReport {
  critical: CriticalPath;
  totalWorkMs: number;
  /** `null` when no task ran on a local leg. */
  idleLocalSlotMs: number | null;
}

export function fanoutPathReport(input: {
  tasks: readonly PathTask[];
  dependencies: ReadonlyMap<string, readonly string[]>;
  /** Wall time of the whole fan-out. */
  wallMs: number;
  /** Local slots the fan-out used at once; `null` on a cloud-only fan-out. */
  localSlots: number | null;
  /** Which tasks ran on the local leg. */
  isLocal: (taskId: string) => boolean;
}): FanoutPathReport {
  const critical = criticalPath(input.tasks, input.dependencies);
  const totalWorkMs = input.tasks.reduce((sum, t) => sum + workMs(t), 0);
  const local = input.tasks.filter((t) => input.isLocal(t.id));
  const idleLocalSlotMs =
    input.localSlots === null || local.length === 0
      ? null
      : Math.max(
          0,
          Math.max(1, input.localSlots) * Math.max(0, input.wallMs) -
            local.reduce((sum, t) => sum + workMs(t), 0),
        );
  return { critical, totalWorkMs, idleLocalSlotMs };
}

/**
 * `\n\ncritical path 14m (tasks a → c → f), total work 31m, idle local
 * slot 6m`, or `""` when no task ran.
 */
export function renderPathLine(report: FanoutPathReport): string {
  if (report.critical.path.length === 0) return "";
  const idle =
    report.idleLocalSlotMs === null
      ? ""
      : `, idle local slot ${formatEstimateMs(report.idleLocalSlotMs)}`;
  return `\n\nCritical path ${formatEstimateMs(report.critical.ms)} (tasks ${report.critical.path.join(" → ")}), total work ${formatEstimateMs(report.totalWorkMs)}${idle}.`;
}
