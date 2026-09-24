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
 * Correct the orchestrator's estimates by what this fan-out has
 * actually done.
 *
 * The estimate is the cloud model's guess about work a different model
 * will do on hardware it cannot see, and in the field it came back
 * consistently optimistic — a task it called two minutes took nineteen.
 * Nothing here can make the guess better, but the finished legs of the
 * same wave are direct evidence of how wrong it is, and they are free.
 *
 * The median ratio, not the mean: one straggler that ran twenty times
 * its estimate would otherwise drag every other row with it. Clamped
 * at 20x because past that the estimate carries no information and a
 * number with no information should not be shown as if it did — the
 * caller drops the expectation instead.
 */
export const MAX_ETA_CORRECTION = 20;

export function etaCorrection(
  workers: readonly FusionLiveWorker[],
): number | null {
  const ratios: number[] = [];
  for (const w of workers) {
    if (!w.done || w.etaSeconds === null || w.finishedAt === null) continue;
    const actual = (w.finishedAt - w.startedAt) / 1000;
    if (actual <= 0) continue;
    ratios.push(actual / w.etaSeconds);
  }
  if (ratios.length === 0) return null;
  ratios.sort((a, b) => a - b);
  const mid = Math.floor(ratios.length / 2);
  const median =
    ratios.length % 2 === 1
      ? (ratios[mid] as number)
      : ((ratios[mid - 1] as number) + (ratios[mid] as number)) / 2;
  if (!Number.isFinite(median) || median <= 0) return null;
  return Math.min(median, MAX_ETA_CORRECTION);
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
  correction: number | null = null,
): string {
  const model = worker.model ?? "local";
  const what = worker.done ? "done" : (worker.tool ?? "working");
  const elapsedMs = (worker.finishedAt ?? now) - worker.startedAt;
  const elapsed = formatElapsed(elapsedMs);
  return `${worker.title} · ${model} — ${what} · ${elapsed}${describeExpectation(
    worker,
    elapsedMs,
    correction,
  )}`;
}

/**
 * The trailing `(~2m expected)`, corrected and honest about being past.
 *
 * Dropped once the leg is done: the elapsed time IS the answer then,
 * and a guess printed beside a fact only invites checking the guess.
 * Dropped again once elapsed has passed it, replaced by `over` —
 * "42s (~2m expected)" at nineteen minutes is not an estimate, it is
 * the UI insisting on something the operator can see is false.
 */
function describeExpectation(
  worker: FusionLiveWorker,
  elapsedMs: number,
  correction: number | null,
): string {
  if (worker.done || worker.etaSeconds === null) return "";
  const expectedMs = worker.etaSeconds * 1000 * (correction ?? 1);
  if (elapsedMs >= expectedMs) {
    return ` (past the ~${formatElapsed(expectedMs)} expected)`;
  }
  return ` (~${formatElapsed(expectedMs)} expected)`;
}
