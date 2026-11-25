/**
 * The result of `models fit-test` (ATO-1090): every task of one task set
 * run on each model in turn and scored by a judge. Written as JSON by
 * `--out`; `models fit-test --compare` (ATO-1105) reads two of them. The
 * shape is a contract: fields are only ever added.
 */
import type { FitTask } from "./fit-task.js";

export const FIT_TEST_RUN_KIND = "atomic-agent.fit-test-run";
export const FIT_TEST_RUN_VERSION = 1;

export interface FitTaskResult {
  taskId: string;
  /** Judge score 1..5; `null` when the run or the judge failed. */
  score: number | null;
  /** The judge's short reason, or what went wrong. */
  reason: string;
  /** Wall time of the agent run (ms). */
  durationMs: number;
  /** Prompt plus generated tokens the run used, when its trace said. */
  tokens: number | null;
  /** True when the run hit its time limit. */
  timedOut: boolean;
}

export interface FitModelResult {
  modelId: string;
  /** Set when the model could not be loaded; `tasks` is then empty. */
  loadError: string | null;
  /** Time to load the model (ms). */
  loadMs: number;
  /** Highest resident memory of the model server seen while it ran (bytes). */
  peakMemoryBytes: number | null;
  tasks: FitTaskResult[];
}

export interface FitTestRun {
  kind: typeof FIT_TEST_RUN_KIND;
  version: typeof FIT_TEST_RUN_VERSION;
  createdAt: string;
  /** The task set's `createdAt`, so two runs of the same set can be matched. */
  taskSetCreatedAt: string;
  taskIds: string[];
  /** The machine's GPU memory budget (GB), for reading the memory column. */
  gpuBudgetGb: number | null;
  models: FitModelResult[];
}

/** A model loaded for the run; `release` unloads it. */
export interface LoadedFitModel {
  /** Chat completion server the agent talks to, and the key it sends. */
  url: string;
  apiKey: string | null;
  /** Model server process to watch for memory; `null` when unknown. */
  pid: number | null;
  release(): Promise<void>;
}

export interface AgentTaskOutcome {
  reply: string;
  durationMs: number;
  tokens: number | null;
  timedOut: boolean;
  /** Set when the agent did not reply (crash, non-zero exit). */
  error: string | null;
}

export interface JudgeOutcome {
  score: number;
  reason: string;
}

/**
 * What the runner needs from the outside. The CLI wires the real ones
 * (`models-fit-test-command.ts`); tests pass fakes.
 */
export interface FitTestDeps {
  loadModel(modelId: string): Promise<LoadedFitModel>;
  /** Run one task on the loaded model with outside effects refused. */
  runTask(task: FitTask, model: LoadedFitModel): Promise<AgentTaskOutcome>;
  judge(task: FitTask, reply: string): Promise<JudgeOutcome>;
  /** Resident memory of `pid` in bytes, or `null` when it cannot be read. */
  sampleMemory(pid: number): Promise<number | null>;
  /** How often to sample memory while a task runs (ms). */
  sampleEveryMs?: number;
  /** One line of progress, e.g. to stderr. */
  progress?(line: string): void;
  now?(): number;
}
