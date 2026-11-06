import type { AgentLoopEvent } from "../agent/agent-contract.js";
import {
  createSnapshotCadence,
  type SnapshotCadenceConfig,
} from "../agent/status-snapshot.js";

import type { TaskLiveStatus, TaskRunSummaryCollector } from "./task-run-summary.js";

/**
 * Auto status snapshots of a running task (ATO-965). A reporting task
 * that runs long (every `everySteps` steps or `everyMs` of wall time,
 * counted from the last snapshot; a short run never gets one) hands its
 * live status (the same collector the final report reads, so the two
 * never disagree) to the sink. The Telegram sink keeps ONE message per
 * task and edits it, falling back to a new message when the edit fails.
 *
 * `end` fires once the run is over, only when a snapshot went out: the
 * sink can then drop or close its message (the final report follows).
 * Both calls are fire-and-forget; a throwing sink never touches the run.
 */
export interface TaskSnapshotSink {
  update(status: TaskLiveStatus): void | Promise<void>;
  end(taskId: string): void | Promise<void>;
}

export interface TaskSnapshotLoop {
  /** Feed from the run's event hook, after the collector saw the event. */
  onEvent(event: AgentLoopEvent): void;
  /** The run is over: stop the timer, close the sink's message. */
  stop(): void;
}

export function startTaskSnapshots(args: {
  sink: TaskSnapshotSink;
  cadence: SnapshotCadenceConfig | null | undefined;
  live: Omit<TaskLiveStatus, "summary">;
  collector: TaskRunSummaryCollector;
  now?: () => number;
  /** Test seam: replaces an unref'ed `setInterval`. */
  schedule?: (cb: () => void, ms: number) => () => void;
  onError?: (err: unknown) => void;
}): TaskSnapshotLoop | null {
  const now = args.now ?? Date.now;
  const cadence = createSnapshotCadence(args.cadence, args.live.startedAt);
  if (!cadence.enabled) return null;
  let steps = 0;
  let sent = false;
  let stopped = false;
  const guard = (fn: () => void | Promise<void>): void => {
    void (async () => fn())().catch((err) => args.onError?.(err));
  };
  const check = (): void => {
    if (stopped) return;
    const at = now();
    if (!cadence.due(steps, at)) return;
    cadence.mark(steps, at);
    sent = true;
    const status: TaskLiveStatus = { ...args.live, summary: args.collector.snapshot() };
    guard(() => args.sink.update(status));
  };
  const stopTimer =
    cadence.pollMs === null
      ? () => undefined
      : (args.schedule ?? unrefInterval)(check, cadence.pollMs);
  return {
    onEvent(event) {
      if (event.type !== "step_finished") return;
      steps += 1;
      check();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      stopTimer();
      if (sent) guard(() => args.sink.end(args.live.taskId));
    },
  };
}

function unrefInterval(cb: () => void, ms: number): () => void {
  const handle = setInterval(cb, ms);
  if (typeof (handle as { unref?: () => unknown }).unref === "function") {
    (handle as { unref: () => unknown }).unref();
  }
  return () => clearInterval(handle);
}
