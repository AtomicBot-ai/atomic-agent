/**
 * How fast each leg actually generated this turn (ATO-1583).
 *
 * The planner already sees the local daemon's probe speed in the
 * `### fusion` block, measured once at daemon start, and nothing at all
 * for a cloud leg. What it plans the next fan-out from is better served
 * by what the workers really did: tokens written over the time the
 * model spent producing them (summed per completion, so tool runs and
 * checks between completions do not count), averaged per leg and model
 * over the turn, from tasks that ended `ok`.
 *
 * The figure rides the `fusion.delegate` result, not the prompt prefix:
 * it moves after every task, and the `### fusion` block sits in the
 * KV-cache-hot stable prefix, which must not move per turn. The outcome
 * log carries it per task too, so the next session's past-runs summary
 * can read it.
 */

import type { WorkerTaskResult } from "./worker-result.js";

/** Below this much generating time a speed is noise, not a measurement. */
export const MIN_SPEED_SAMPLE_MS = 1000;

/** One leg's measured output so far this turn. */
export interface LegSpeedSample {
  /** Output tokens written. */
  tokens: number;
  /** Milliseconds the model spent producing them (per completion). */
  ms: number;
  /** Tasks that contributed. */
  tasks: number;
}

/** One leg's line in the readout. */
export interface LegSpeed {
  /** `local qwen3.8-27b`, `cloud gpt-5-mini`. */
  label: string;
  tokensPerSecond: number;
  tasks: number;
}

/**
 * A finished task's output and the time the model spent producing it
 * (`WorkerTaskResult.generation`: per completion, the server's decode
 * time or the request's wall time, never the tool runs between them),
 * or `null` when there is nothing fair to measure: a task that did not
 * end `ok` (a timeout or a failure says nothing about decode speed and
 * would drag the leg down), no generation recorded, or too little of it.
 */
export function workerSpeedSample(
  result: Pick<WorkerTaskResult, "status" | "generation">,
): LegSpeedSample | null {
  if (result.status !== "ok") return null;
  const tokens = result.generation?.tokens;
  const ms = result.generation?.ms;
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) {
    return null;
  }
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < MIN_SPEED_SAMPLE_MS) {
    return null;
  }
  return { tokens, ms, tasks: 1 };
}

/** Tokens per second of a sample: whole above 10, one decimal below. */
export function sampleTokensPerSecond(sample: LegSpeedSample): number {
  const value = sample.tokens / (sample.ms / 1000);
  return value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
}

/** Add `next` into `into` (token-weighted: total tokens over total time). */
export function addSpeedSample(
  into: LegSpeedSample | undefined,
  next: LegSpeedSample,
): LegSpeedSample {
  return into === undefined
    ? { ...next }
    : {
        tokens: into.tokens + next.tokens,
        ms: into.ms + next.ms,
        tasks: into.tasks + next.tasks,
      };
}

/** The per-leg averages, in the order the legs were first seen. */
export function legSpeeds(
  samples: ReadonlyMap<string, LegSpeedSample>,
): LegSpeed[] {
  return [...samples].map(([label, sample]) => ({
    label,
    tokensPerSecond: sampleTokensPerSecond(sample),
    tasks: sample.tasks,
  }));
}

/**
 * `\n\nMeasured speed this turn: local qwen 6.1 tok/s (2 tasks), cloud
 * gpt-5-mini 48 tok/s (1 task).` — or `""` when nothing was measured, so
 * a result without usage reads exactly as before.
 */
export function renderLegSpeedLine(speeds: readonly LegSpeed[]): string {
  if (speeds.length === 0) return "";
  const parts = speeds.map(
    (s) =>
      `${s.label} ${s.tokensPerSecond} tok/s (${s.tasks} task${s.tasks === 1 ? "" : "s"})`,
  );
  return `\n\nMeasured speed this turn: ${parts.join(", ")}. Size the next tasks from these.`;
}
