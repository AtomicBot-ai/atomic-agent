import type { FusionOutcomeRow, OutcomeSize } from "./outcome-log.js";

/**
 * What the outcome log says about this machine, as short facts for the
 * planner (ATO-949): "`qwen3-27b` (local) on large tasks: failed 3 of 3
 * here; split them or send them to a cloud model".
 *
 * Deterministic for a given set of rows: grouped by leg, model and size,
 * ordered by a fixed key, numbers rounded. Only a group with at least
 * `minSamples` judged tasks is stated: one bad run is an anecdote, and a
 * sentence in the stable prefix is something the model will plan by.
 *
 * `cancelled` (the operator stopped it) and `queued` (it never got a
 * slot, a width problem, not the model's) say nothing about whether the
 * model can do the task, so they are not counted. Only `ok` is a
 * success: a worker that handed the task back or ran out of steps or
 * time did not deliver it.
 */

export const OUTCOME_MIN_SAMPLES = 3;
export const OUTCOME_MAX_FACTS = 6;

const NOT_JUDGED: ReadonlySet<string> = new Set(["cancelled", "queued"]);
const SIZE_ORDER: Record<OutcomeSize, number> = {
  large: 0,
  medium: 1,
  small: 2,
};

interface Group {
  leg: FusionOutcomeRow["leg"];
  model: string;
  size: OutcomeSize;
  total: number;
  ok: number;
  durations: number[];
  costs: number[];
}

export interface SummarizeOptions {
  minSamples?: number;
  maxFacts?: number;
}

export function summarizeOutcomes(
  rows: readonly FusionOutcomeRow[],
  options: SummarizeOptions = {},
): string[] {
  const minSamples = Math.max(1, options.minSamples ?? OUTCOME_MIN_SAMPLES);
  const maxFacts = Math.max(0, options.maxFacts ?? OUTCOME_MAX_FACTS);
  const groups = new Map<string, Group>();
  for (const row of rows) {
    if (NOT_JUDGED.has(row.status)) continue;
    const key = `${row.leg}\u0000${row.model}\u0000${row.size}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        leg: row.leg,
        model: row.model,
        size: row.size,
        total: 0,
        ok: 0,
        durations: [],
        costs: [],
      };
      groups.set(key, group);
    }
    group.total += 1;
    if (row.status === "ok") {
      group.ok += 1;
      group.durations.push(row.durationMs);
    }
    if (row.costUsd !== null && row.costUsd > 0) group.costs.push(row.costUsd);
  }
  const stated = [...groups.values()].filter((g) => g.total >= minSamples);
  // Failing groups first (they change a plan), then the most tried;
  // ties broken by a fixed key so the bytes never depend on row order.
  stated.sort(
    (a, b) =>
      Number(isFailing(b)) - Number(isFailing(a)) ||
      b.total - a.total ||
      SIZE_ORDER[a.size] - SIZE_ORDER[b.size] ||
      a.leg.localeCompare(b.leg) ||
      a.model.localeCompare(b.model),
  );
  return stated.slice(0, maxFacts).map(formatGroup);
}

/** At least half of the judged tasks did not deliver. */
function isFailing(group: Group): boolean {
  return group.total - group.ok >= group.total / 2;
}

function formatGroup(group: Group): string {
  const head = `\`${group.model}\` (${group.leg}) on ${group.size} tasks`;
  const failed = group.total - group.ok;
  if (isFailing(group)) {
    const remedy =
      group.leg === "local"
        ? "split them or send them to a cloud model"
        : "split them smaller";
    return `${head}: failed ${failed} of ${group.total} here; ${remedy}`;
  }
  const time =
    group.durations.length === 0
      ? ""
      : `, ~${formatDuration(median(group.durations))} each`;
  const cost =
    group.costs.length === 0
      ? ""
      : `, ~$${formatUsd(median(group.costs))} each`;
  return `${head}: ${group.ok} of ${group.total} ok${time}${cost}`;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** "40 s" under a minute (to 10 s), "3 min" above (whole minutes). */
export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 55) return `${Math.max(10, Math.round(seconds / 10) * 10)} s`;
  return `${Math.round(seconds / 60)} min`;
}

/** Short and rounded: "1.2", "0.04", "0.003" (never below 0.001). */
export function formatUsd(usd: number): string {
  if (usd >= 1) return (Math.round(usd * 10) / 10).toString();
  if (usd >= 0.01) return (Math.round(usd * 100) / 100).toString();
  return Math.max(0.001, Math.round(usd * 1000) / 1000).toString();
}
