import type { FusionLiveWorker } from "./fusion-live-workers.js";
import { formatElapsed } from "./fusion-live-workers.js";
import {
  clipRowTitle,
  describeOutcome,
  describeProgress,
} from "./fusion-worker-row-details.js";

/**
 * What a fan-out leaves on screen once its turn is over: one collapsed
 * row per worker, saying how it ended.
 *
 * The live readout used to vanish with the turn, so the only record of
 * why a task came back — handed to the planner, out of steps, out of
 * time — was a feed line in a debug tab. Like a finished subagent's
 * summary in other coding agents, the rows stay under the reply, short,
 * until the next turn or the next fan-out replaces them.
 *
 * A leg still marked running when the turn ended did not finish: the
 * turn took it down with it, so it collapses as `cancelled` with its
 * clock stopped at the turn's end rather than ticking on forever.
 */
export function collapseFusionLiveWorkers(
  workers: readonly FusionLiveWorker[],
  now: number = Date.now(),
): readonly FusionLiveWorker[] {
  if (workers.length === 0) return workers;
  return workers.map((w) =>
    w.collapsed === true
      ? w
      : {
          ...w,
          collapsed: true,
          tool: null,
          done: true,
          finishedAt: w.finishedAt ?? now,
          outcome: w.done ? (w.outcome ?? null) : "cancelled",
        },
  );
}

/**
 * `UI · qwen-3.5-4b — returned to planner · 4m10s · 20/40 steps · 1 file`.
 *
 * The outcome and how far the leg got; no estimate, stuck flag, spend
 * or context — those answered questions about a leg that was running,
 * and the feed's end line still carries the spend.
 */
export function formatCollapsedFusionWorker(worker: FusionLiveWorker): string {
  const model = worker.model ?? "local";
  const elapsed = formatElapsed(
    (worker.finishedAt ?? worker.startedAt) - worker.startedAt,
  );
  return `${clipRowTitle(worker.title)} · ${model} — ${describeOutcome(
    worker.outcome,
  )} · ${elapsed}${describeProgress(worker)}`;
}
