import { cp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { runChecks } from "./checks.js";
import {
  buildSummary,
  SKILL_EVAL_RESULT_SCHEMA,
  type SkillEvalResult,
  type SkillEvalRunEnd,
  type SkillEvalRunRecord,
  type SkillEvalVariant,
} from "./eval-result.js";
import type { SkillEvalJudge, SkillEvalJudgeUsage } from "./judge.js";
import { makeRunId } from "./run-store.js";
import type { SkillEvalTask, SkillEvalTaskSet } from "./task-set.js";

/** What the driver reports for one run; the runner adds timing and checks. */
export interface SkillEvalDriverRun {
  reply: string | null;
  end: SkillEvalRunEnd;
  error: string | null;
  steps: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
  approvalsDenied: number;
  skillLoaded: boolean;
}

/**
 * The part that talks to the agent. The CLI wires a real runtime
 * (`src/cli/skill-eval-command.ts`); tests pass a fake. Runs are strictly
 * sequential: `setVariant` is called before the first run of a variant
 * and whenever the variant changes.
 */
export interface SkillEvalDriver {
  /** Show the skill to the model (`with`) or hide it (`without`) for the runs that follow. */
  setVariant(variant: SkillEvalVariant): Promise<void>;
  runTask(input: {
    task: SkillEvalTask;
    variant: SkillEvalVariant;
    workingDir: string;
    signal: AbortSignal;
  }): Promise<SkillEvalDriverRun>;
}

export type SkillEvalProgress =
  | { type: "run_started"; taskId: string; variant: SkillEvalVariant; attempt: number; index: number; total: number }
  | { type: "run_finished"; record: SkillEvalRunRecord; index: number; total: number };

export interface RunSkillEvalOptions {
  skill: { name: string; version: string | null; source: string | null };
  taskSet: SkillEvalTaskSet;
  driver: SkillEvalDriver;
  /**
   * An empty folder the eval owns. Each run gets it emptied and refilled
   * with the task's fixtures; it is the agent's working folder and where
   * `command` checks run.
   */
  workRoot: string;
  repeat: number;
  variants: readonly SkillEvalVariant[];
  /** `--max-steps`; a task's own `maxSteps` wins. */
  maxSteps: number | null;
  approvalLevel: number;
  agentVersion: string;
  model: { provider: string | null; model: string | null };
  /** Grades `judge` checks (ATO-1101); null or absent, a `judge` check fails as "no judge configured". */
  judge?: SkillEvalJudge | null;
  /** Stops the eval between runs and cancels the run in flight. */
  signal?: AbortSignal;
  onProgress?: (event: SkillEvalProgress) => void;
  now?: () => Date;
  clock?: () => number;
}

/**
 * Run every task `repeat` times in each variant and return the result
 * document (not yet saved; see `saveSkillEvalResult`). The order of the
 * two variants alternates from run to run, so neither always goes first
 * on a warm cache. Memory cannot carry anything between them: the driver
 * runs every turn with memory read-only (`memoryReadOnly`).
 */
export async function runSkillEval(options: RunSkillEvalOptions): Promise<SkillEvalResult> {
  const now = options.now ?? (() => new Date());
  const clock = options.clock ?? Date.now;
  const started = now();
  const plan = planRuns(options.taskSet.tasks, options.repeat, options.variants);
  const runs: SkillEvalRunRecord[] = [];
  // One judge can grade several evals (`--all`): count only this one's calls.
  const judgeBefore = options.judge?.usage() ?? null;
  let current: SkillEvalVariant | null = null;
  let complete = true;

  for (const [index, step] of plan.entries()) {
    if (options.signal?.aborted) {
      complete = false;
      break;
    }
    if (step.variant !== current) {
      await options.driver.setVariant(step.variant);
      current = step.variant;
    }
    options.onProgress?.({
      type: "run_started", taskId: step.task.id, variant: step.variant, attempt: step.attempt, index, total: plan.length,
    });
    await prepareWorkRoot(options.workRoot, step.task.fixturesDir);
    const task = step.task.maxSteps === null && options.maxSteps !== null ? { ...step.task, maxSteps: options.maxSteps } : step.task;
    const t0 = clock();
    const outcome = await runOne(options.driver, task, step.variant, options.workRoot, options.signal);
    const wallMs = Math.max(0, clock() - t0);
    if (outcome.end === "cancelled" && options.signal?.aborted) {
      // The person stopped the eval mid-run: that run says nothing about the skill.
      complete = false;
      break;
    }
    const answer = outcome.reply ?? "";
    const ranToEnd = outcome.end !== "error" && outcome.end !== "timeout";
    const checks = ranToEnd ? await runChecks(task.checks, { answer, workingDir: options.workRoot, prompt: task.prompt, judge: options.judge ?? null }) : [];
    const record: SkillEvalRunRecord = {
      taskId: task.id,
      variant: step.variant,
      attempt: step.attempt,
      passed: ranToEnd && checks.length > 0 && checks.every((c) => c.passed),
      checks,
      end: outcome.end,
      reply: outcome.reply,
      error: outcome.error,
      wallMs,
      steps: outcome.steps,
      promptTokens: outcome.promptTokens,
      completionTokens: outcome.completionTokens,
      costUsd: outcome.costUsd,
      approvalsDenied: outcome.approvalsDenied,
      skillLoaded: outcome.skillLoaded,
    };
    runs.push(record);
    options.onProgress?.({ type: "run_finished", record, index, total: plan.length });
  }

  return {
    schema: SKILL_EVAL_RESULT_SCHEMA,
    runId: makeRunId(started),
    complete,
    skill: options.skill,
    tasks: { file: options.taskSet.sourcePath, sha256: options.taskSet.sha256, count: options.taskSet.tasks.length },
    startedAt: started.toISOString(),
    finishedAt: now().toISOString(),
    agentVersion: options.agentVersion,
    model: options.model,
    judge: options.judge ? { provider: options.judge.providerId, model: options.judge.model, url: options.judge.baseUrl } : null,
    judgeUsage: options.judge && judgeBefore ? judgeUsageSince(judgeBefore, options.judge.usage()) : null,
    options: {
      repeat: options.repeat,
      variants: [...options.variants],
      maxSteps: options.maxSteps,
      approvalLevel: options.approvalLevel,
    },
    runs,
    summary: buildSummary(runs, options.taskSet.tasks.map((t) => t.id)),
  };
}

export interface PlannedRun {
  task: SkillEvalTask;
  variant: SkillEvalVariant;
  attempt: number;
}

/**
 * The run order: attempt by attempt, task by task, both variants of a
 * task back to back. Which variant goes first flips with every task and
 * every attempt.
 */
export function planRuns(
  tasks: readonly SkillEvalTask[],
  repeat: number,
  variants: readonly SkillEvalVariant[],
): PlannedRun[] {
  const plan: PlannedRun[] = [];
  for (let attempt = 1; attempt <= repeat; attempt += 1) {
    tasks.forEach((task, i) => {
      const order: SkillEvalVariant[] = (i + attempt) % 2 === 1 ? ["with", "without"] : ["without", "with"];
      for (const variant of order) if (variants.includes(variant)) plan.push({ task, variant, attempt });
    });
  }
  return plan;
}

async function runOne(
  driver: SkillEvalDriver,
  task: SkillEvalTask,
  variant: SkillEvalVariant,
  workingDir: string,
  outer: AbortSignal | undefined,
): Promise<SkillEvalDriverRun> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, task.timeoutMs);
  const onOuterAbort = (): void => controller.abort();
  outer?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    const run = await driver.runTask({ task, variant, workingDir, signal: controller.signal });
    if (timedOut) return { ...run, end: "timeout", error: run.error ?? `timed out after ${task.timeoutMs}ms` };
    return run;
  } catch (err) {
    return {
      reply: null,
      end: timedOut ? "timeout" : "error",
      error: err instanceof Error ? err.message : String(err),
      steps: null,
      promptTokens: null,
      completionTokens: null,
      costUsd: null,
      approvalsDenied: 0,
      skillLoaded: false,
    };
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
  }
}

/** Empty `workRoot` (never the folder itself) and copy the task's fixtures in. */
async function prepareWorkRoot(workRoot: string, fixturesDir: string | null): Promise<void> {
  for (const name of await readdir(workRoot)) {
    await rm(join(workRoot, name), { recursive: true, force: true });
  }
  if (fixturesDir !== null) await cp(fixturesDir, workRoot, { recursive: true });
}

/** The judge's usage between two of its running totals. */
export function judgeUsageSince(before: SkillEvalJudgeUsage, after: SkillEvalJudgeUsage): SkillEvalJudgeUsage {
  const diff = (a: number | null, b: number | null): number | null => (b === null ? null : b - (a ?? 0));
  return {
    calls: after.calls - before.calls,
    promptTokens: diff(before.promptTokens, after.promptTokens),
    completionTokens: diff(before.completionTokens, after.completionTokens),
    totalTokens: diff(before.totalTokens, after.totalTokens),
    costUsd: diff(before.costUsd, after.costUsd),
  };
}
