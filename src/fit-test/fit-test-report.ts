/**
 * The table `models fit-test` prints: one row per model with its mean
 * judge score, how many tasks passed (score >= 4, the eval harness's
 * default threshold), total task time, and peak memory.
 */
import type { FitModelResult, FitTestRun } from "./fit-test-types.js";

export const PASS_SCORE = 4;

export interface FitModelSummary {
  modelId: string;
  meanScore: number | null;
  passed: number;
  scored: number;
  totalMs: number;
  tokens: number | null;
  peakMemoryBytes: number | null;
  loadError: string | null;
}

export function summarizeModel(model: FitModelResult): FitModelSummary {
  const scores = model.tasks.map((t) => t.score).filter((s): s is number => s !== null);
  const tokenCounts = model.tasks.map((t) => t.tokens).filter((n): n is number => n !== null);
  return {
    modelId: model.modelId,
    meanScore: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
    passed: scores.filter((s) => s >= PASS_SCORE).length,
    scored: scores.length,
    totalMs: model.tasks.reduce((sum, t) => sum + t.durationMs, 0),
    tokens: tokenCounts.length > 0 ? tokenCounts.reduce((a, b) => a + b, 0) : null,
    peakMemoryBytes: model.peakMemoryBytes,
    loadError: model.loadError,
  };
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function gb(bytes: number | null): string {
  return bytes === null ? "n/a" : `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

function pad(cells: readonly string[], widths: readonly number[]): string {
  return cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
}

/** Plain-text table, best mean score first. */
export function formatFitTable(run: FitTestRun): string {
  const total = run.taskIds.length;
  const rows = run.models
    .map(summarizeModel)
    .sort((a, b) => (b.meanScore ?? -1) - (a.meanScore ?? -1))
    .map((s) =>
      s.loadError !== null
        ? [s.modelId, "-", "-", "-", "-", `not loaded: ${s.loadError}`]
        : [
            s.modelId,
            s.meanScore === null ? "n/a" : s.meanScore.toFixed(2),
            `${s.passed}/${total}`,
            seconds(s.totalMs),
            gb(s.peakMemoryBytes),
            s.tokens === null ? "" : `${s.tokens} tokens`,
          ],
    );
  const header = ["model", "score", "passed", "time", "peak memory", ""];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const lines = [pad(header, widths), ...rows.map((r) => pad(r, widths))];
  if (run.gpuBudgetGb !== null) lines.push(`GPU memory budget on this machine: ${run.gpuBudgetGb.toFixed(1)} GB`);
  return `${lines.join("\n")}\n`;
}
