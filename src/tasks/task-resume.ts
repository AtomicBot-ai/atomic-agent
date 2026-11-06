import type { TurnProgress } from "../session/turn-progress.js";
import { TASK_INTERRUPTED_ERROR, TASK_OWNER_GONE_ERROR } from "./task-store.js";
import type { TaskRecord } from "./task-types.js";

/**
 * Continuing a durable task whose run was cut off (ATO-1109).
 *
 * A task's run that a crash, a kill or a restart stopped used to start
 * over from the task's message, with no word to the model that half the
 * work was already in the transcript, and a task that crashed the agent
 * every time was claimed again at every boot for ever. Now the run that
 * picks it up again continues it: the model is told how far the cut-off
 * run got, the resumes are counted in the session's progress marker, and
 * after `agent.task.maxResumes` of them the task fails with a sentence
 * saying why.
 *
 * Only an interruption from outside is continued: the boot sweep taking
 * back a run whose process died (`TASK_OWNER_GONE_ERROR`), or a one-shot
 * task left due by a shutdown (`TASK_INTERRUPTED_ERROR`). A run a person
 * stopped is never one of those: a one-shot task stopped from its chat
 * is cancelled, and a recurring task stopped either way is rearmed for
 * its next firing, which is a fresh run.
 */
export interface TaskResumePolicy {
  /** `agent.task.resumeInterrupted`: `false` re-runs from the start, as before. */
  enabled: boolean;
  /** `agent.task.maxResumes`: resumes allowed before the task is failed. */
  maxResumes: number;
}

/** How the run about to start relates to the one before it. */
export type TaskResumePlan =
  | { kind: "fresh" }
  | {
      kind: "resume";
      /** Crash resumes spent once this one starts (`maxResumes` counts these). */
      resumes: number;
      /** This resume follows a crash or kill, not a clean restart. */
      crashed: boolean;
      /** The message to run the turn with: the note, then the task. */
      message: string;
    }
  | { kind: "give_up"; resumes: number; message: string };

/** The note a resumed run starts with. */
export function resumeNote(progress: TurnProgress): string {
  const where =
    progress.stepsDone > 0
      ? `after step ${progress.stepsDone}`
      : "before its first step finished";
  return (
    `[Resumed] The previous run of this task was interrupted ${where} ` +
    "(the agent stopped: a crash, a kill or a restart). " +
    "Continue from where you stopped; do not redo finished work. " +
    "Check the conversation above for what is already done."
  );
}

/**
 * Whether `task` (as read before this claim) was put back by an
 * interruption from outside, rather than by a person or a failure.
 */
export function wasInterruptedFromOutside(task: TaskRecord): boolean {
  if (task.lastError === TASK_OWNER_GONE_ERROR) return true;
  return task.lastError === TASK_INTERRUPTED_ERROR && !task.recurring;
}

/**
 * Decide how to start `task`'s run. `task` is the row as read before the
 * claim (the claim clears `lastError`); `progress` is its session's
 * marker. Pure.
 */
export function planTaskResume(
  task: TaskRecord,
  progress: TurnProgress | null,
  policy: TaskResumePolicy,
): TaskResumePlan {
  if (!policy.enabled || progress === null) return { kind: "fresh" };
  if (progress.options.taskId !== task.id) return { kind: "fresh" };
  if (!wasInterruptedFromOutside(task)) return { kind: "fresh" };
  // Only a run whose process died counts towards the limit: that is the
  // crash loop it exists for. A clean restart (the task left due by a
  // shutdown) is continued without spending one.
  const crashed = task.lastError === TASK_OWNER_GONE_ERROR;
  const resumes = progress.resumes + (crashed ? 1 : 0);
  if (resumes > policy.maxResumes) {
    return {
      kind: "give_up",
      resumes: progress.resumes,
      message:
        `gave up: the agent stopped under this task ${resumes} times ` +
        `(last after step ${progress.stepsDone}); ` +
        `agent.task.maxResumes is ${policy.maxResumes}`,
    };
  }
  return {
    kind: "resume",
    resumes,
    crashed,
    message: `${resumeNote(progress)}\n\nThe task:\n${task.userMessage}`,
  };
}
