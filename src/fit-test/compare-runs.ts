/**
 * Before/after on the user's own task set (ATO-1105): two fit-test runs
 * of the same set, e.g. a base model and the same model with a LoRA
 * adapter, compared task by task. Pure; `models fit-test --compare`
 * reads the files and prints {@link formatFitComparison}.
 */
import { summarizeModel } from "./fit-test-report.js";
import {
  FIT_TEST_RUN_KIND,
  FIT_TEST_RUN_VERSION,
  type FitModelResult,
  type FitTaskResult,
  type FitTestRun,
} from "./fit-test-types.js";

export interface FitTaskDelta {
  taskId: string;
  before: FitTaskResult | null;
  after: FitTaskResult | null;
  /** after - before; `null` when either side has no score. */
  scoreDelta: number | null;
  durationDeltaMs: number | null;
  tokensDelta: number | null;
}

export interface FitComparison {
  beforeModel: string;
  afterModel: string;
  /** True when both runs came from the same task set file. */
  sameTaskSet: boolean;
  tasks: FitTaskDelta[];
  total: {
    meanScoreBefore: number | null;
    meanScoreAfter: number | null;
    meanScoreDelta: number | null;
    passedDelta: number;
    durationDeltaMs: number;
    tokensDelta: number | null;
    /** Tasks only one of the runs has. */
    unmatched: number;
  };
}

/** Parse a run file's JSON. Throws with a plain reason when it is not one. */
export function parseFitTestRun(raw: unknown): FitTestRun {
  if (raw === null || typeof raw !== "object") throw new Error("run is not a JSON object");
  const run = raw as Partial<FitTestRun>;
  if (run.kind !== FIT_TEST_RUN_KIND) throw new Error(`not a fit-test run (kind must be "${FIT_TEST_RUN_KIND}")`);
  if (run.version !== FIT_TEST_RUN_VERSION) throw new Error(`unsupported run version: ${String(run.version)}`);
  if (!Array.isArray(run.models) || !Array.isArray(run.taskIds)) throw new Error("run has no models or taskIds");
  return run as FitTestRun;
}

/** The model to compare from a run: the named one, else the first that loaded. */
export function pickModel(run: FitTestRun, modelId: string | null): FitModelResult {
  const found =
    modelId === null
      ? run.models.find((m) => m.loadError === null)
      : run.models.find((m) => m.modelId === modelId);
  if (found === undefined) {
    throw new Error(modelId === null ? "the run has no model that loaded" : `the run has no model ${modelId}`);
  }
  return found;
}

function diff(a: number | null | undefined, b: number | null | undefined): number | null {
  return typeof a === "number" && typeof b === "number" ? b - a : null;
}

export function compareFitRuns(
  before: FitTestRun,
  after: FitTestRun,
  models: { before?: string | null; after?: string | null } = {},
): FitComparison {
  const a = pickModel(before, models.before ?? null);
  const b = pickModel(after, models.after ?? null);
  const byId = (m: FitModelResult) => new Map(m.tasks.map((t) => [t.taskId, t]));
  const aTasks = byId(a);
  const bTasks = byId(b);
  const ids = [...new Set([...before.taskIds, ...after.taskIds])];
  const tasks: FitTaskDelta[] = ids.map((taskId) => {
    const x = aTasks.get(taskId) ?? null;
    const y = bTasks.get(taskId) ?? null;
    return {
      taskId,
      before: x,
      after: y,
      scoreDelta: diff(x?.score, y?.score),
      durationDeltaMs: diff(x?.durationMs, y?.durationMs),
      tokensDelta: diff(x?.tokens, y?.tokens),
    };
  });
  const matched = tasks.filter((t) => t.before !== null && t.after !== null);
  // Totals over tasks both runs have, so a missing task does not read as a gain or a loss.
  const keep = new Set(matched.map((t) => t.taskId));
  const only = (m: FitModelResult): FitModelResult => ({ ...m, tasks: m.tasks.filter((t) => keep.has(t.taskId)) });
  const sa = summarizeModel(only(a));
  const sb = summarizeModel(only(b));
  const tokenDeltas = matched.map((t) => t.tokensDelta);
  return {
    beforeModel: a.modelId,
    afterModel: b.modelId,
    sameTaskSet: before.taskSetCreatedAt === after.taskSetCreatedAt,
    tasks,
    total: {
      meanScoreBefore: sa.meanScore,
      meanScoreAfter: sb.meanScore,
      meanScoreDelta: diff(sa.meanScore, sb.meanScore),
      passedDelta: sb.passed - sa.passed,
      durationDeltaMs: sb.totalMs - sa.totalMs,
      tokensDelta: tokenDeltas.length > 0 && tokenDeltas.every((d) => d !== null)
        ? (tokenDeltas as number[]).reduce((s, d) => s + d, 0)
        : null,
      unmatched: tasks.length - matched.length,
    },
  };
}

function signed(n: number | null, digits = 0, unit = ""): string {
  if (n === null) return "n/a";
  const text = n.toFixed(digits);
  return `${n > 0 ? "+" : ""}${text}${unit}`;
}

function score(t: FitTaskResult | null): string {
  if (t === null) return "missing";
  return t.score === null ? "n/a" : String(t.score);
}

/** Plain-text report: one row per task, then the totals. */
export function formatFitComparison(c: FitComparison): string {
  const rows = c.tasks.map((t) => [
    t.taskId,
    `${score(t.before)} -> ${score(t.after)}`,
    signed(t.scoreDelta),
    signed(t.durationDeltaMs === null ? null : t.durationDeltaMs / 1000, 1, "s"),
    signed(t.tokensDelta),
  ]);
  const header = ["task", "score", "change", "time", "tokens"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  const t = c.total;
  const mean = (n: number | null) => (n === null ? "n/a" : n.toFixed(2));
  const out = [
    `before: ${c.beforeModel}   after: ${c.afterModel}`,
    ...(c.sameTaskSet ? [] : ["note: the two runs used different task sets; only tasks in both are totalled"]),
    line(header),
    ...rows.map(line),
    `total: score ${mean(t.meanScoreBefore)} -> ${mean(t.meanScoreAfter)} (${signed(t.meanScoreDelta, 2)}), passed ${signed(t.passedDelta)}, time ${signed(t.durationDeltaMs / 1000, 1, "s")}, tokens ${signed(t.tokensDelta)}`,
    ...(t.unmatched > 0 ? [`${t.unmatched} task(s) are in only one run and not totalled`] : []),
  ];
  return `${out.join("\n")}\n`;
}
