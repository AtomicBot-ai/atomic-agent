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
  /**
   * When this leg was first seen, and when it ended.
   *
   * A fan-out is the longest thing the app does and the readout said
   * nothing about time: four rows of "working" look identical at ten
   * seconds and at ten minutes, which are very different situations —
   * the second one is the operator's cue to cancel, narrow the tasks or
   * go and look at the daemon. Kept per leg rather than for the wave so
   * a single straggler is visible against its finished siblings.
   */
  readonly startedAt: number;
  readonly finishedAt: number | null;
  /**
   * What the orchestrator expected this task to take, in seconds, when
   * it said so. Shown beside the elapsed time — `42s (~2m expected)` —
   * because elapsed alone cannot be read as fast or slow, and "is this
   * stuck?" is the only question the operator is asking of this row.
   */
  readonly etaSeconds: number | null;
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
  now: number = Date.now(),
): readonly FusionLiveWorker[] {
  // The orchestrator's own bracket lines are not a leg of the fan-out;
  // the composer already names the model it is running.
  if (event.role === "orchestrator") return current;
  const at = current.findIndex((w) => w.taskId === event.taskId);
  const done =
    event.phase === "finished" ||
    event.phase === "failed" ||
    event.phase === "cancelled";
  const previous = at < 0 ? undefined : current[at];
  const next: FusionLiveWorker = {
    taskId: event.taskId,
    title: event.title,
    model: event.model ?? previous?.model ?? null,
    tool: done ? null : (event.tool ?? previous?.tool ?? null),
    done,
    // First sight starts the clock. A leg that reappears keeps its
    // original start, or the elapsed time would restart on every tool
    // call and the readout would always say a few seconds.
    startedAt: previous?.startedAt ?? now,
    finishedAt: done ? (previous?.finishedAt ?? now) : null,
    // The estimate arrives on the first event and is not repeated on
    // every one, so it is kept rather than overwritten with undefined.
    etaSeconds: event.etaSeconds ?? previous?.etaSeconds ?? null,
  };
  if (at < 0) return [...current, next];
  const copy = [...current];
  copy[at] = next;
  return copy;
}

/**
 * `1m04s`, `12s` — short enough to sit at the end of a truncating row.
 *
 * Floors rather than rounds, and lives here rather than in
 * `thinking-indicator.tsx` where it started: the turn clock and the
 * per-worker clock are drawn one above the other, and two formatters
 * would eventually disagree about the same second.
 */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * One line per leg: `worker · qwen-3.5-4b — os.fs.read · 42s (~2m expected)`.
 *
 * The estimate is dropped once the leg is done: at that point the
 * elapsed time IS the answer, and a guess printed next to a fact only
 * invites the reader to check the guess.
 */
export function formatFusionLiveWorker(
  worker: FusionLiveWorker,
  now: number = Date.now(),
): string {
  const model = worker.model ?? "local";
  const what = worker.done ? "done" : (worker.tool ?? "working");
  const elapsed = formatElapsed((worker.finishedAt ?? now) - worker.startedAt);
  const eta =
    worker.done || worker.etaSeconds === null
      ? ""
      : ` (~${formatElapsed(worker.etaSeconds * 1000)} expected)`;
  return `${worker.title} · ${model} — ${what} · ${elapsed}${eta}`;
}
