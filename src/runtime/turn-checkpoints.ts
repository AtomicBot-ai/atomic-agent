import type { StepCheckpoint } from "../agent/agent-contract.js";
import type { SessionState } from "../session/session-state.js";
import type { TurnProgress, TurnResumeOptions } from "../session/turn-progress.js";

/**
 * What a caller tells `executeTurn` about the turn it starts, beyond the
 * message, so the turn's progress marker can name it (ATO-1109).
 */
export interface TurnCheckpointOptions {
  /** The durable task this turn runs for. */
  taskId?: string;
  /** Resumes already spent on this piece of work (0 for a fresh run). */
  resumes?: number;
  /**
   * The request to record, when the message the turn is given is not it:
   * a resumed task's message carries the resume note in front of the
   * task's own words, and only those words are the request.
   */
  request?: string;
}

/** The run options `executeTurn` takes that a continuation needs again. */
export interface CheckpointedRunOptions {
  maxSteps?: number;
  taskMaxDurationMs?: number;
  providerId?: string;
  interactive?: boolean;
  checkpoint?: TurnCheckpointOptions;
}

/**
 * The progress markers of one turn: the one written as it starts
 * (`initial`) and the one written with each completed step (`atStep`).
 * Pure; `executeTurn` does the writes.
 */
export function turnProgressFor(
  userMessage: string,
  runOptions: CheckpointedRunOptions,
  startedAt: number,
  now: () => number = Date.now,
): {
  initial: TurnProgress;
  atStep(step: StepCheckpoint): TurnProgress;
} {
  const checkpoint = runOptions.checkpoint ?? {};
  const options: TurnResumeOptions = {
    ...(checkpoint.taskId !== undefined ? { taskId: checkpoint.taskId } : {}),
    ...(runOptions.maxSteps !== undefined ? { maxSteps: runOptions.maxSteps } : {}),
    ...(runOptions.taskMaxDurationMs !== undefined
      ? { taskMaxDurationMs: runOptions.taskMaxDurationMs }
      : {}),
    ...(runOptions.providerId !== undefined
      ? { providerId: runOptions.providerId }
      : {}),
    ...(runOptions.interactive === true ? { interactive: true } : {}),
  };
  const base = {
    request: checkpoint.request ?? userMessage,
    options,
    resumes: checkpoint.resumes ?? 0,
    startedAt,
  };
  return {
    initial: { ...base, stepsDone: 0, lastStepIndex: -1, updatedAt: startedAt },
    atStep: (step) => ({
      ...base,
      stepsDone: step.stepsTaken,
      lastStepIndex: step.stepIndex,
      updatedAt: now(),
    }),
  };
}

/** The session a step checkpoint stores: the loop's state, stamped now. */
export function checkpointState(session: SessionState, now: number): SessionState {
  return { ...session, updatedAt: Math.max(session.updatedAt, now) };
}
