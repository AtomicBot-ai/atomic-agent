/**
 * The task set `models tasks collect` writes and `models fit-test` reads
 * (ATO-1089, ATO-994).
 *
 * Each task is the JSON half of an eval case (`eval/harness/case-schema.ts`):
 * same `id`, `name`, `category`, `prompt`, `maxSteps` and `expectations`
 * fields, with only the `judge` expectation kind, since a regex or a
 * setup function cannot travel in JSON. `eval/harness/load-fit-task-set.ts`
 * turns a file of these into `EvalCase[]` for the eval runner.
 *
 * The file shape is a contract: fields are only ever added. A breaking
 * change bumps {@link FIT_TASK_SET_VERSION}.
 */

export const FIT_TASK_SET_KIND = "atomic-agent.fit-task-set";
export const FIT_TASK_SET_VERSION = 1;

/** A subset of the eval harness's `EvalCategory`. */
export type FitTaskCategory = "os" | "coding";

/** The eval harness's `JudgeExpectation`, without a RegExp anywhere. */
export interface FitJudgeExpectation {
  kind: "judge";
  rubric: string;
  threshold?: number;
}

/** Where a task came from: the user's own chat. */
export interface FitTaskSource {
  sessionId: string;
  /** When the user sent the message (ms epoch). */
  at: number;
  /** Tools the agent called while it worked on it, in call order, deduplicated. */
  toolsUsed: string[];
  /** The reply the user got back then, secrets masked. */
  referenceReply: string;
}

export interface FitTask {
  id: string;
  name: string;
  category: FitTaskCategory;
  prompt: string;
  maxSteps?: number;
  expectations: FitJudgeExpectation[];
  source: FitTaskSource;
}

export interface FitTaskSet {
  kind: typeof FIT_TASK_SET_KIND;
  version: typeof FIT_TASK_SET_VERSION;
  /** ISO time the set was collected. */
  createdAt: string;
  tasks: FitTask[];
}

/** Longest reference reply quoted into a judge rubric, in characters. */
const RUBRIC_REFERENCE_CHARS = 1500;

/**
 * The judge's criteria for a task: did the new reply do what the user
 * asked, with the old reply as a hint of what a good answer looked like.
 * The old reply is not ground truth (it may itself have been wrong), so
 * the rubric says so.
 */
export function rubricForTask(referenceReply: string): string {
  const ref =
    referenceReply.length > RUBRIC_REFERENCE_CHARS
      ? `${referenceReply.slice(0, RUBRIC_REFERENCE_CHARS)}…`
      : referenceReply;
  return [
    "Score how well the reply completes the user's request.",
    "Tools that change things outside the agent were refused in this run, so do not mark the reply down for saying it could not send, push or post something.",
    "For reference, the user once accepted this answer to the same request (it is a hint, not ground truth):",
    ref,
  ].join("\n");
}

/** Parse a task set file's JSON. Throws with a plain reason when it is not one. */
export function parseFitTaskSet(raw: unknown): FitTaskSet {
  if (raw === null || typeof raw !== "object") throw new Error("task set is not a JSON object");
  const set = raw as Partial<FitTaskSet>;
  if (set.kind !== FIT_TASK_SET_KIND) throw new Error(`not a task set (kind must be "${FIT_TASK_SET_KIND}")`);
  if (set.version !== FIT_TASK_SET_VERSION) throw new Error(`unsupported task set version: ${String(set.version)}`);
  if (!Array.isArray(set.tasks)) throw new Error("task set has no tasks array");
  for (const task of set.tasks) {
    if (task === null || typeof task !== "object" || typeof task.id !== "string" || typeof task.prompt !== "string") {
      throw new Error("every task needs a string id and prompt");
    }
    if (!Array.isArray(task.expectations)) throw new Error(`task ${task.id} has no expectations array`);
  }
  return set as FitTaskSet;
}
