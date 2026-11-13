/**
 * Run a task set on several models, one at a time, and score every reply
 * with a judge (ATO-1090). Models are loaded and released in turn so only
 * one sits in memory; a model that fails to load is recorded and the run
 * goes on with the next one.
 */
import type { FitTask, FitTaskSet } from "./fit-task.js";
import {
  FIT_TEST_RUN_KIND,
  FIT_TEST_RUN_VERSION,
  type FitModelResult,
  type FitTaskResult,
  type FitTestDeps,
  type FitTestRun,
  type LoadedFitModel,
} from "./fit-test-types.js";

const DEFAULT_SAMPLE_EVERY_MS = 2000;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Samples the model server's memory until stopped; keeps the highest value. */
function watchMemory(model: LoadedFitModel, deps: FitTestDeps): { stop(): Promise<number | null> } {
  if (model.pid === null) return { stop: async () => null };
  const pid = model.pid;
  let peak: number | null = null;
  let pending: Promise<void> = Promise.resolve();
  const sample = (): void => {
    pending = pending.then(async () => {
      const bytes = await deps.sampleMemory(pid).catch(() => null);
      if (bytes !== null && (peak === null || bytes > peak)) peak = bytes;
    });
  };
  sample();
  const timer = setInterval(sample, deps.sampleEveryMs ?? DEFAULT_SAMPLE_EVERY_MS);
  return {
    async stop() {
      clearInterval(timer);
      sample();
      await pending;
      return peak;
    },
  };
}

async function runOneTask(task: FitTask, model: LoadedFitModel, deps: FitTestDeps): Promise<FitTaskResult> {
  let outcome;
  try {
    outcome = await deps.runTask(task, model);
  } catch (err) {
    return { taskId: task.id, score: null, reason: `run failed: ${message(err)}`, durationMs: 0, tokens: null, timedOut: false };
  }
  const base = { taskId: task.id, durationMs: outcome.durationMs, tokens: outcome.tokens, timedOut: outcome.timedOut };
  if (outcome.error !== null && outcome.reply.trim() === "") {
    return { ...base, score: null, reason: outcome.error };
  }
  try {
    const verdict = await deps.judge(task, outcome.reply);
    return { ...base, score: verdict.score, reason: verdict.reason };
  } catch (err) {
    return { ...base, score: null, reason: `judge failed: ${message(err)}` };
  }
}

async function runOneModel(set: FitTaskSet, modelId: string, deps: FitTestDeps): Promise<FitModelResult> {
  const now = deps.now ?? Date.now;
  const loadStart = now();
  let model: LoadedFitModel;
  try {
    model = await deps.loadModel(modelId);
  } catch (err) {
    return { modelId, loadError: message(err), loadMs: now() - loadStart, peakMemoryBytes: null, tasks: [] };
  }
  const loadMs = now() - loadStart;
  const watch = watchMemory(model, deps);
  const tasks: FitTaskResult[] = [];
  let peakMemoryBytes: number | null = null;
  try {
    for (const [i, task] of set.tasks.entries()) {
      deps.progress?.(`${modelId}: task ${i + 1}/${set.tasks.length} ${task.name}`);
      tasks.push(await runOneTask(task, model, deps));
    }
  } finally {
    // Read before release, so the peak is this model's alone.
    peakMemoryBytes = await watch.stop();
    await model.release().catch((err: unknown) => deps.progress?.(`${modelId}: unload failed: ${message(err)}`));
  }
  return { modelId, loadError: null, loadMs, peakMemoryBytes, tasks };
}

export async function runFitTest(
  set: FitTaskSet,
  modelIds: readonly string[],
  deps: FitTestDeps,
  extra: { gpuBudgetGb?: number | null; createdAt?: string } = {},
): Promise<FitTestRun> {
  const models: FitModelResult[] = [];
  for (const modelId of modelIds) models.push(await runOneModel(set, modelId, deps));
  return {
    kind: FIT_TEST_RUN_KIND,
    version: FIT_TEST_RUN_VERSION,
    createdAt: extra.createdAt ?? new Date().toISOString(),
    taskSetCreatedAt: set.createdAt,
    taskIds: set.tasks.map((t) => t.id),
    gpuBudgetGb: extra.gpuBudgetGb ?? null,
    models,
  };
}
