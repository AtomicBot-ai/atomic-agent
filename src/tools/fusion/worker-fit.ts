/**
 * Will a local worker fit its time limit? (ATO-1363)
 *
 * The planner sometimes hands a local 27B worker a task beyond what the
 * machine can write in the worker's time (one 1,500-line file at a few
 * tokens a second). The guards that exist fire late: the half-budget
 * hand-back and the timeout both cost the whole wait before the planner
 * hears "split it". The planner already sees the slots, the context and
 * the measured tok/s in the `### fusion` block; this module adds the one
 * number only the planner has, its estimate of the task's OUTPUT size,
 * and checks it against the speed and the limit before anything runs.
 *
 * - `readOutputEstimate`: the optional `outputTokens` / `outputLines` on
 *   a task, validated with bounds. Absent is the old behaviour.
 * - `checkWorkerFit`: per task on the local worker leg, the single-stream
 *   time (tokens / tok/s) and the shared-GPU time (× the workers running
 *   at once) against the task's time limit. Over it: a WARNING that rides
 *   the task's row. Never a refusal: an estimate is the planner's guess,
 *   so every task is dispatched. A task that even running alone needs
 *   more than the longest limit a task may ask for (no `timeoutMs` could
 *   hold it) is "oversized": its row says to split it and the result
 *   carries a note to the planner. Speed unknown: nothing.
 * - `renderEstimateBlock`: after the fan-out, estimated vs actual size
 *   and time per task that carried an estimate, so the next plan in the
 *   same turn is sized from what this machine really did.
 */

/** Rough tokens per written line of code or prose, for a line estimate. */
export const TOKENS_PER_OUTPUT_LINE = 10;
/** Bounds on the estimate: a runaway number is a malformed call. */
export const MAX_OUTPUT_TOKENS_ESTIMATE = 1_000_000;
export const MAX_OUTPUT_LINES_ESTIMATE = 100_000;

export interface OutputEstimate {
  outputTokens?: number;
  outputLines?: number;
}

function readBoundedCount(
  value: unknown,
  label: string,
  max: number,
  problems: string[],
): number | null {
  if (value === undefined || value === null) return null;
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 1) {
    problems.push(`${label} must be a positive number`);
    return null;
  }
  const whole = Math.floor(n);
  if (whole > max) {
    problems.push(
      `${label} is ${whole.toLocaleString("en-US")}; at most ${max.toLocaleString("en-US")}`,
    );
    return null;
  }
  return whole;
}

/**
 * A task's output-size estimate. Both fields are optional; a bad value
 * is named like any other field problem, so one regeneration fixes it.
 */
export function readOutputEstimate(
  entry: Record<string, unknown>,
  label: string,
  problems: string[],
): OutputEstimate {
  const outputTokens = readBoundedCount(
    entry.outputTokens,
    `${label}.outputTokens`,
    MAX_OUTPUT_TOKENS_ESTIMATE,
    problems,
  );
  const outputLines = readBoundedCount(
    entry.outputLines,
    `${label}.outputLines`,
    MAX_OUTPUT_LINES_ESTIMATE,
    problems,
  );
  return {
    ...(outputTokens === null ? {} : { outputTokens }),
    ...(outputLines === null ? {} : { outputLines }),
  };
}

/** Tokens the task says it will write: `outputTokens`, else lines × 10. */
export function estimatedOutputTokens(task: OutputEstimate): number | null {
  if (task.outputTokens !== undefined) return task.outputTokens;
  if (task.outputLines !== undefined) {
    return task.outputLines * TOKENS_PER_OUTPUT_LINE;
  }
  return null;
}

/** `1h05m`, `12m`, `1m20s`, `40s`: minutes once the seconds stop mattering. */
export function formatEstimateMs(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 600) {
    return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function describeSize(task: OutputEstimate, tokens: number): string {
  const n = (v: number) => v.toLocaleString("en-US");
  return task.outputTokens === undefined && task.outputLines !== undefined
    ? `~${n(task.outputLines)} lines (~${n(tokens)} tokens)`
    : `~${n(tokens)} tokens`;
}

export interface FitTask extends OutputEstimate {
  id: string;
  timeoutMs?: number;
}

export interface WorkerFitInput {
  /** The tasks that run on the local worker leg. */
  tasks: readonly FitTask[];
  /** Measured single-stream speed; `null` and the check does nothing. */
  tokensPerSecond: number | null;
  /** Workers running at once on the leg (they share one GPU). */
  concurrency: number;
  /** The time limit the task will run under, in ms. */
  budgetMsFor: (task: FitTask) => number;
  /** The longest limit any task may ask for (`timeoutMs` ceiling). */
  maxBudgetMs: number;
}

export interface WorkerFit {
  /** A warning per task id, for its row. */
  warnings: Map<string, string>;
  /** Tasks no allowed limit could hold, even running alone. */
  oversized: string[];
  /** For the result, when any task is oversized; the tasks still ran. */
  plannerNote?: string;
}

/**
 * Check every task with an estimate against its limit. Pure, and only
 * ever advisory: nothing here stops a task from running.
 */
export function checkWorkerFit(input: WorkerFitInput): WorkerFit {
  const warnings = new Map<string, string>();
  const oversized: string[] = [];
  const tps = input.tokensPerSecond;
  if (tps === null || !Number.isFinite(tps) || tps <= 0) {
    return { warnings, oversized };
  }
  const width = Math.max(1, Math.floor(input.concurrency));
  for (const task of input.tasks) {
    const tokens = estimatedOutputTokens(task);
    if (tokens === null) continue;
    const budgetMs = input.budgetMsFor(task);
    const aloneMs = (tokens / tps) * 1000;
    const sharedMs = aloneMs * width;
    const size = describeSize(task, tokens);
    if (aloneMs > input.maxBudgetMs) {
      oversized.push(task.id);
      warnings.set(
        task.id,
        `fit: ${size} at ${tps} tok/s is ~${formatEstimateMs(aloneMs)} even running alone, over its ${formatEstimateMs(budgetMs)} limit and over the longest limit a task may ask for (${formatEstimateMs(input.maxBudgetMs)}); it was run anyway and will likely time out — split it into smaller tasks`,
      );
      continue;
    }
    if (sharedMs <= budgetMs) continue;
    const sharing =
      width === 1 ? "" : ` with ${width} workers sharing the GPU`;
    const fix = `split it, or give it timeoutMs of at least ${Math.min(Math.ceil(sharedMs * 1.2), input.maxBudgetMs)}`;
    warnings.set(
      task.id,
      `fit: ${size} at ${tps} tok/s${sharing} is ~${formatEstimateMs(sharedMs)}, over its ${formatEstimateMs(budgetMs)} limit; it was run anyway and may time out — next time ${fix}`,
    );
  }
  if (oversized.length === 0) return { warnings, oversized };
  const list = oversized.map((id) => `[${id}]`).join(", ");
  return {
    warnings,
    oversized,
    plannerNote:
      `\n\nNote: ${list} stated more output than any time limit this machine allows could hold, even running alone; ` +
      `${oversized.length === 1 ? "it was" : "they were"} dispatched anyway. If ${oversized.length === 1 ? "it comes" : "they come"} back unfinished, split into smaller tasks (one file or one part each) rather than re-sending as is.`,
  };
}

export interface EstimatedTask extends OutputEstimate {
  id: string;
  etaSeconds?: number;
}

export interface ActualTask {
  id: string;
  durationMs: number;
  usage?: { completionTokens: number };
}

export interface EstimateRow {
  id: string;
  estimatedTokens: number | null;
  estimatedMs: number | null;
  actualTokens: number | null;
  actualMs: number;
}

/**
 * Estimated vs actual per task that carried an estimate (size or time).
 * The estimated time is the planner's `etaSeconds` when it gave one,
 * else the fit arithmetic when the speed is known.
 */
export function estimateRows(
  tasks: readonly EstimatedTask[],
  results: readonly ActualTask[],
  tokensPerSecond: number | null,
  concurrency: number,
): EstimateRow[] {
  const byId = new Map(results.map((r) => [r.id, r]));
  const rows: EstimateRow[] = [];
  const width = Math.max(1, Math.floor(concurrency));
  for (const task of tasks) {
    const tokens = estimatedOutputTokens(task);
    if (tokens === null && task.etaSeconds === undefined) continue;
    const result = byId.get(task.id);
    if (result === undefined) continue;
    const derivedMs =
      tokens !== null && tokensPerSecond !== null && tokensPerSecond > 0
        ? (tokens / tokensPerSecond) * 1000 * width
        : null;
    rows.push({
      id: task.id,
      estimatedTokens: tokens,
      estimatedMs:
        task.etaSeconds === undefined ? derivedMs : task.etaSeconds * 1000,
      actualTokens: result.usage?.completionTokens ?? null,
      actualMs: result.durationMs,
    });
  }
  return rows;
}

/** The block appended to the fan-out's result, or `""` with no rows. */
export function renderEstimateBlock(rows: readonly EstimateRow[]): string {
  if (rows.length === 0) return "";
  const n = (v: number) => v.toLocaleString("en-US");
  const lines = rows.map((r) => {
    const est = [
      r.estimatedTokens === null ? null : `~${n(r.estimatedTokens)} tokens`,
      r.estimatedMs === null ? null : `~${formatEstimateMs(r.estimatedMs)}`,
    ].filter((s): s is string => s !== null);
    const actual = [
      r.actualTokens === null ? null : `${n(r.actualTokens)} tokens out`,
      formatEstimateMs(r.actualMs),
    ].filter((s): s is string => s !== null);
    const ratio =
      r.estimatedMs !== null && r.estimatedMs > 0
        ? ` (${(r.actualMs / r.estimatedMs).toFixed(1)}x the time estimate)`
        : "";
    return `- [${r.id}] estimated ${est.join(", ")}; actual ${actual.join(", ")}${ratio}`;
  });
  return `\n\nEstimates vs actual (size the next tasks from these):\n${lines.join("\n")}`;
}
