import type { SkillEvalCheckOutcome } from "./checks.js";

/**
 * The Skill Lab result file (ATO-1099): one JSON document per
 * `skill eval` run, stored under `<stateDir>/skill-evals/<skill>/`.
 * Shaped so a with/without table (accuracy, wall time, tokens, cost) is
 * a read of `summary`, with no recomputation: the TUI table (ATO-1100)
 * and the desktop "Test skill" button (ATO-1102) only read it.
 * Field-by-field description: README.md next to this file.
 */
export const SKILL_EVAL_RESULT_SCHEMA = "atomic-agent.skill-eval/1";

export type SkillEvalVariant = "with" | "without";
export const SKILL_EVAL_VARIANTS: readonly SkillEvalVariant[] = ["with", "without"];

/** How a run ended: the agent loop's reason, or what stopped it outside the loop. */
export type SkillEvalRunEnd = "reply" | "finish" | "max_steps" | "cancelled" | "failed" | "timeout" | "error";

/** One task run in one variant. */
export interface SkillEvalRunRecord {
  taskId: string;
  variant: SkillEvalVariant;
  /** 1-based, up to `options.repeat`. */
  attempt: number;
  /** Every check passed. A run that ended in `error` or `timeout` never passes. */
  passed: boolean;
  checks: SkillEvalCheckOutcome[];
  end: SkillEvalRunEnd;
  /** The agent's final reply; null when it gave none. */
  reply: string | null;
  error: string | null;
  wallMs: number;
  steps: number | null;
  /** Null when the provider reported no usage for the run. */
  promptTokens: number | null;
  completionTokens: number | null;
  /** Estimated USD; 0 on a local model, null when no pricing applied. */
  costUsd: number | null;
  /** Approval requests the eval refused because nobody can answer them. */
  approvalsDenied: number;
  /** Whether the skill was loaded (`skill.view`) during the run. */
  skillLoaded: boolean;
}

export interface SkillEvalVariantSummary {
  runs: number;
  passed: number;
  /** passed / runs, 0..1. */
  accuracy: number;
  wallMsTotal: number;
  wallMsMean: number;
  /** Sums over runs that reported usage; null when none did. */
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  /** Runs that ended in `error`, `timeout` or `failed`. */
  errors: number;
  /** Runs in which the skill was loaded. */
  skillLoadedRuns: number;
}

/** `with` minus `without`. Positive accuracy = the skill helps; positive tokens/cost/time = it costs more. */
export interface SkillEvalDelta {
  accuracy: number;
  wallMsMean: number;
  totalTokens: number | null;
  costUsd: number | null;
}

export interface SkillEvalTaskRow {
  taskId: string;
  with: SkillEvalVariantSummary | null;
  without: SkillEvalVariantSummary | null;
}

export interface SkillEvalSummary {
  with: SkillEvalVariantSummary | null;
  without: SkillEvalVariantSummary | null;
  /** Null unless both variants ran. */
  delta: SkillEvalDelta | null;
  perTask: SkillEvalTaskRow[];
}

export interface SkillEvalResult {
  schema: typeof SKILL_EVAL_RESULT_SCHEMA;
  runId: string;
  /** False when the eval was stopped before every planned run finished. */
  complete: boolean;
  skill: { name: string; version: string | null; source: string | null };
  tasks: { file: string; sha256: string; count: number };
  startedAt: string;
  finishedAt: string;
  agentVersion: string;
  model: { provider: string | null; model: string | null };
  options: {
    repeat: number;
    variants: SkillEvalVariant[];
    maxSteps: number | null;
    approvalLevel: number;
  };
  runs: SkillEvalRunRecord[];
  summary: SkillEvalSummary;
}

export function summarizeRuns(runs: readonly SkillEvalRunRecord[]): SkillEvalVariantSummary {
  const passed = runs.filter((r) => r.passed).length;
  const wallMsTotal = runs.reduce((sum, r) => sum + r.wallMs, 0);
  const promptTokens = sumReported(runs.map((r) => r.promptTokens));
  const completionTokens = sumReported(runs.map((r) => r.completionTokens));
  const totalTokens =
    promptTokens === null && completionTokens === null ? null : (promptTokens ?? 0) + (completionTokens ?? 0);
  return {
    runs: runs.length,
    passed,
    accuracy: runs.length === 0 ? 0 : passed / runs.length,
    wallMsTotal,
    wallMsMean: runs.length === 0 ? 0 : Math.round(wallMsTotal / runs.length),
    promptTokens,
    completionTokens,
    totalTokens,
    costUsd: sumReported(runs.map((r) => r.costUsd)),
    errors: runs.filter((r) => r.end === "error" || r.end === "timeout" || r.end === "failed").length,
    skillLoadedRuns: runs.filter((r) => r.skillLoaded).length,
  };
}

export function buildSummary(
  runs: readonly SkillEvalRunRecord[],
  taskIds: readonly string[],
): SkillEvalSummary {
  const of = (variant: SkillEvalVariant, taskId?: string): SkillEvalVariantSummary | null => {
    const subset = runs.filter((r) => r.variant === variant && (taskId === undefined || r.taskId === taskId));
    return subset.length === 0 ? null : summarizeRuns(subset);
  };
  const withSkill = of("with");
  const withoutSkill = of("without");
  return {
    with: withSkill,
    without: withoutSkill,
    delta: withSkill && withoutSkill ? deltaOf(withSkill, withoutSkill) : null,
    perTask: taskIds.map((taskId) => ({ taskId, with: of("with", taskId), without: of("without", taskId) })),
  };
}

function deltaOf(a: SkillEvalVariantSummary, b: SkillEvalVariantSummary): SkillEvalDelta {
  return {
    accuracy: a.accuracy - b.accuracy,
    wallMsMean: a.wallMsMean - b.wallMsMean,
    totalTokens: a.totalTokens === null || b.totalTokens === null ? null : a.totalTokens - b.totalTokens,
    costUsd: a.costUsd === null || b.costUsd === null ? null : a.costUsd - b.costUsd,
  };
}

function sumReported(values: ReadonlyArray<number | null>): number | null {
  let total: number | null = null;
  for (const v of values) if (v !== null) total = (total ?? 0) + v;
  return total;
}
