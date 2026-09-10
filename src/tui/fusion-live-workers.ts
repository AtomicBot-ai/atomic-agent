import type { AgentLoopEvent } from "../agent/agent-loop.js";

/** One leg of a fan-out, as the chat surface shows it while it runs. */
export interface FusionLiveWorker {
  readonly taskId: string;
  readonly title: string;
  /** The model running this leg; `null` when the resolver had no label. */
  readonly model: string | null;
  /** The tool it is running right now, or `null` between calls. */
  readonly tool: string | null;
  readonly done: boolean;
}

/**
 * The live readout of a fusion fan-out, kept for the chat surface.
 *
 * The feed lines say what *happened*; this says what is happening. A
 * fan-out holds the orchestrator's turn for minutes with nothing of its
 * own to show, and the operator watching the chat should not have to
 * open a debug tab to learn that four local workers are busy and which
 * model each is running — that is the whole point of a mode that splits
 * a turn across two models and two bills.
 *
 * Ordered by first sight, so a worker does not jump around the readout
 * as its tools change. Finished legs are kept (marked `done`) until the
 * turn ends, so the block does not shrink under the reader mid-fan-out.
 */
export function reduceFusionLiveWorkers(
  current: readonly FusionLiveWorker[],
  event: Extract<AgentLoopEvent, { type: "fusion_worker" }>,
): readonly FusionLiveWorker[] {
  // The orchestrator's own bracket lines are not a leg of the fan-out;
  // the composer already names the model it is running.
  if (event.role === "orchestrator") return current;
  const at = current.findIndex((w) => w.taskId === event.taskId);
  const done =
    event.phase === "finished" || event.phase === "failed" || event.phase === "cancelled";
  const next: FusionLiveWorker = {
    taskId: event.taskId,
    title: event.title,
    model: event.model ?? current[at]?.model ?? null,
    tool: done ? null : (event.tool ?? current[at]?.tool ?? null),
    done,
  };
  if (at < 0) return [...current, next];
  const copy = [...current];
  copy[at] = next;
  return copy;
}

/** One line per leg: `worker · qwen-3.5-4b — os.fs.read`. */
export function formatFusionLiveWorker(worker: FusionLiveWorker): string {
  const model = worker.model ?? "local";
  const what = worker.done ? "done" : (worker.tool ?? "working");
  return `${worker.title} · ${model} — ${what}`;
}
