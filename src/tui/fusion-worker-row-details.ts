import type { WorkerTaskStatus } from "../tools/fusion/worker-result.js";
import { formatTokens } from "./components/format-tokens.js";

/**
 * The parts of a fan-out worker's row that say how far it got and why
 * it came back (ATO-1364, ATO-78), kept apart from the clock and the
 * stuck flag in `fusion-live-workers.ts`.
 */

/**
 * What an ended leg's row says instead of `done`, so a task that came
 * back can be told from one that finished: the planner reads the status
 * on the result row, and the operator watching the chat had only
 * "done" for all of them.
 */
const OUTCOME_LABELS: Record<WorkerTaskStatus, string> = {
  ok: "done",
  no_changes: "done, no changes",
  needs_orchestrator: "returned to planner",
  max_steps: "hit max steps",
  timeout: "timed out",
  failed: "failed",
  cancelled: "cancelled",
  queued: "never served",
};

export function describeOutcome(outcome: WorkerTaskStatus | null | undefined): string {
  return outcome == null ? "done" : OUTCOME_LABELS[outcome];
}

/**
 * The longest title the row keeps before it clips it. A planner's task
 * title can be a sentence; past this it pushes the model, the clock and
 * the outcome off a narrow terminal, and those are what the row is for.
 */
export const MAX_ROW_TITLE_CHARS = 40;

export function clipRowTitle(title: string): string {
  const flat = title.replace(/\s+/g, " ").trim();
  return flat.length > MAX_ROW_TITLE_CHARS
    ? `${flat.slice(0, MAX_ROW_TITLE_CHARS - 1)}…`
    : flat;
}

/**
 * ` · 12/40 steps · 3 files`, or less of it when that is all that is
 * known. Steps are shown once the budget is known — `0/40 steps` on a
 * leg that has not finished a step is the budget, which is news — and
 * files only once one is written.
 */
export function describeProgress(row: {
  readonly stepCount?: number | null;
  readonly stepBudget?: number | null;
  readonly filesWritten?: number | null;
}): string {
  const steps =
    row.stepBudget != null && row.stepBudget > 0
      ? ` · ${row.stepCount ?? 0}/${row.stepBudget} steps`
      : row.stepCount != null && row.stepCount > 0
        ? ` · ${row.stepCount} step${row.stepCount === 1 ? "" : "s"}`
        : "";
  const files =
    row.filesWritten != null && row.filesWritten > 0
      ? ` · ${row.filesWritten} file${row.filesWritten === 1 ? "" : "s"}`
      : "";
  return `${steps}${files}`;
}

/**
 * ` · 41.2k tok (3.2k out) · $0.031`, or less of it when that is all
 * that is known. The reply part is shown because the total is mostly
 * the context re-read on every step; what the worker generated is the
 * part that says it is producing something.
 */
export function describeSpend(row: {
  readonly tokens?: number | null;
  readonly tokensOut?: number | null;
  readonly spentUsd?: number | null;
}): string {
  const out =
    row.tokensOut == null || row.tokensOut <= 0
      ? ""
      : ` (${formatTokens(row.tokensOut)} out)`;
  const tokens =
    row.tokens == null || row.tokens <= 0
      ? ""
      : ` · ${formatTokens(row.tokens)} tok${out}`;
  const usd =
    row.spentUsd == null
      ? ""
      : ` · ${row.spentUsd > 0 && row.spentUsd < 0.01 ? `$${row.spentUsd.toFixed(4)}` : `$${row.spentUsd.toFixed(2)}`}`;
  return `${tokens}${usd}`;
}
