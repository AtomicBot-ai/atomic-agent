/**
 * E6 — combined lesson+procedure distill audit (phase 7b).
 *
 * For each cluster:
 *   1. Call the combined distill LLM call via
 *      `runIsolatedDistillWithProcedure`.
 *   2. Decide whether procedure extraction was correct
 *      (procedural ⇒ procedure expected; conceptual ⇒ procedure
 *      must be absent).
 *   3. When the model emitted a procedure for a procedural cluster,
 *      grade `stepCoherence` with the judge: one score per step,
 *      mean folded into the cluster-level score.
 *   4. Lesson presence is graded by a single boolean (kind === "lesson")
 *      — invariant 21 requires that even abstained procedures keep
 *      the lesson half.
 *
 * Aggregate:
 *   - procedureExtractionRate (over procedural clusters)
 *   - falseProcedureRate (over conceptual clusters)
 *   - meanStepCoherence (over procedural-and-emitted)
 *   - lessonStillProducedRate (over all clusters)
 */

import {
  runIsolatedDistillWithProcedure,
  type IsolatedProcDistillOutcome,
} from "../../harness/distill-with-procedure-isolated.js";
import { scoreWithRetry, type JudgeClient } from "../../harness/judge.js";
import type {
  LlmCompleteParams,
  LlmCompleteResult,
} from "../../harness/llm-client.js";

import {
  PROCEDURE_DISTILL_CASES,
  type ProcDistillCase,
  type ProceduralExpectations,
} from "./dataset.js";

export type DistillStatus = "lesson" | "none" | "parse_failed" | "http_failed";

export interface StepScore {
  index: number;
  description: string;
  toolHint: string | null;
  score: number;
  reason: string;
}

export interface ClusterResult {
  clusterId: string;
  label: string;
  kind: "procedural" | "conceptual";
  status: DistillStatus;
  /**
   * Whether the produced output matched the procedure decision the
   * gold expected: `extracted` ⇔ `procedure_present === procedural`.
   */
  decision:
    | "correct_extracted"
    | "correct_abstained"
    | "missed_extraction"
    | "false_extraction";
  produced: {
    activation: string;
    principle: string;
    procedure: null | {
      activation: string;
      steps: ReadonlyArray<{ description: string; toolHint: string | null }>;
      tags: readonly string[];
    };
  } | null;
  raw: string;
  /** Per-step coherence scores, only for procedural+extracted. */
  stepScores: readonly StepScore[];
  meanStepScore: number;
  /** True when ANY lesson was emitted. */
  lessonPresent: boolean;
  durationMs: number;
}

export interface E6Aggregate {
  clusters: number;
  procedural: number;
  conceptual: number;
  extractionsCorrect: number;
  extractionsMissed: number;
  abstentionsCorrect: number;
  abstentionsFalseExtraction: number;
  procedureExtractionRate: number;
  falseProcedureRate: number;
  meanStepCoherence: number;
  lessonStillProducedRate: number;
  httpFailures: number;
  parseFailures: number;
}

export interface E6Report {
  clusters: readonly ClusterResult[];
  aggregate: E6Aggregate;
}

export interface E6RunnerDeps {
  llmComplete: (params: LlmCompleteParams) => Promise<LlmCompleteResult>;
  judge: JudgeClient;
}

export interface E6RunnerOptions {
  clusterIds?: readonly string[];
  temperature?: number;
  timeoutMs?: number;
}

const STEP_RUBRIC = [
  "Score 5 — the step describes the same action as the canonical sketch using the same tool family.",
  "Score 4 — the step captures the same action but paraphrases or omits a minor detail.",
  "Score 3 — the step is on-topic but generic (e.g. 'run a tool') without nailing the canonical action.",
  "Score 2 — the step is in the right phase but wrong action (e.g. 'verify health' written as 'restart service').",
  "Score 1 — the step is irrelevant, hallucinated, or contradicts the cluster.",
].join("\n");

export async function runE6(
  deps: E6RunnerDeps,
  opts: E6RunnerOptions = {},
): Promise<E6Report> {
  const selected = opts.clusterIds
    ? PROCEDURE_DISTILL_CASES.filter((c) => opts.clusterIds!.includes(c.id))
    : PROCEDURE_DISTILL_CASES;
  const clusters: ClusterResult[] = [];
  for (const c of selected) {
    const result = await runOneCluster(c, deps, opts);
    clusters.push(result);
  }
  return { clusters, aggregate: aggregate(clusters) };
}

async function runOneCluster(
  c: ProcDistillCase,
  deps: E6RunnerDeps,
  opts: E6RunnerOptions,
): Promise<ClusterResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 90_000);
  try {
    const distillOpts: Parameters<typeof runIsolatedDistillWithProcedure>[1] = {
      llmComplete: deps.llmComplete,
    };
    if (opts.temperature !== undefined) distillOpts.temperature = opts.temperature;
    const outcome = await runIsolatedDistillWithProcedure(
      {
        episodes: c.episodes,
        sharedTags: c.sharedTags,
        sessionId: `e6-${c.id}`,
        signal: controller.signal,
      },
      distillOpts,
    );
    return await buildClusterResult(c, outcome, deps.judge);
  } finally {
    clearTimeout(timer);
  }
}

async function buildClusterResult(
  c: ProcDistillCase,
  outcome: IsolatedProcDistillOutcome,
  judge: JudgeClient,
): Promise<ClusterResult> {
  if (outcome.kind === "none") {
    return makeResult(c, {
      status: "none",
      decision: c.kind === "procedural" ? "missed_extraction" : "correct_abstained",
      produced: null,
      raw: outcome.raw,
      stepScores: [],
      lessonPresent: false,
      durationMs: outcome.durationMs,
    });
  }
  if (outcome.kind === "parse_failed") {
    return makeResult(c, {
      status: "parse_failed",
      decision: c.kind === "procedural" ? "missed_extraction" : "correct_abstained",
      produced: null,
      raw: outcome.raw,
      stepScores: [],
      lessonPresent: false,
      durationMs: outcome.durationMs,
    });
  }
  if (outcome.kind === "http_failed") {
    return makeResult(c, {
      status: "http_failed",
      decision: c.kind === "procedural" ? "missed_extraction" : "correct_abstained",
      produced: null,
      raw: outcome.reason,
      stepScores: [],
      lessonPresent: false,
      durationMs: 0,
    });
  }

  const lessonPresent = true;
  const procPresent = outcome.procedure !== null;
  const decision: ClusterResult["decision"] = procPresent
    ? c.kind === "procedural"
      ? "correct_extracted"
      : "false_extraction"
    : c.kind === "procedural"
      ? "missed_extraction"
      : "correct_abstained";

  let stepScores: StepScore[] = [];
  if (procPresent && c.kind === "procedural" && c.procedural && outcome.procedure) {
    stepScores = await gradeSteps(c, c.procedural, outcome.procedure.steps, judge);
  }

  return makeResult(c, {
    status: "lesson",
    decision,
    produced: {
      activation: outcome.parsed.activation,
      principle: outcome.parsed.principle,
      procedure: outcome.procedure
        ? {
            activation: outcome.procedure.activation,
            steps: outcome.procedure.steps,
            tags: outcome.procedure.tags,
          }
        : null,
    },
    raw: outcome.raw,
    stepScores,
    lessonPresent,
    durationMs: outcome.durationMs,
  });
}

interface PartialResult {
  status: DistillStatus;
  decision: ClusterResult["decision"];
  produced: ClusterResult["produced"];
  raw: string;
  stepScores: readonly StepScore[];
  lessonPresent: boolean;
  durationMs: number;
}

function makeResult(c: ProcDistillCase, p: PartialResult): ClusterResult {
  const mean =
    p.stepScores.length === 0
      ? 0
      : p.stepScores.reduce((s, x) => s + x.score, 0) / p.stepScores.length;
  return {
    clusterId: c.id,
    label: c.label,
    kind: c.kind,
    status: p.status,
    decision: p.decision,
    produced: p.produced,
    raw: p.raw,
    stepScores: p.stepScores,
    meanStepScore: mean,
    lessonPresent: p.lessonPresent,
    durationMs: p.durationMs,
  };
}

async function gradeSteps(
  c: ProcDistillCase,
  procedural: ProceduralExpectations,
  producedSteps: ReadonlyArray<{ description: string; toolHint: string | null }>,
  judge: JudgeClient,
): Promise<StepScore[]> {
  const out: StepScore[] = [];
  for (let i = 0; i < producedSteps.length; i += 1) {
    const step = producedSteps[i]!;
    const sketch = procedural.expectedStepShape[i];
    const sketchSummary = sketch
      ? `Expected step ${i + 1}: action keywords [${sketch.keywords.join(", ")}]` +
        (sketch.toolHint ? `, expected tool '${sketch.toolHint}'.` : ".")
      : `No canonical sketch for step ${i + 1} (the gold sequence has ${procedural.expectedStepShape.length} steps; the model produced ${producedSteps.length}). Extra steps are acceptable if they fit the cluster.`;
    const prompt = [
      `== EPISODES (cluster: ${c.label}) ==`,
      c.episodes.map((e, idx) => `${idx + 1}. ${e.content}`).join("\n"),
      "",
      `== PRODUCED STEP ${i + 1} ==`,
      `description: ${step.description}`,
      step.toolHint ? `tool_hint: ${step.toolHint}` : "tool_hint: (none)",
      "",
      "== GOLD SKETCH ==",
      sketchSummary,
      "",
      "Score this single step on how well it matches the cluster's action chain.",
    ].join("\n");
    const verdict = await scoreWithRetry(judge, {
      prompt,
      reply: step.description,
      rubric: STEP_RUBRIC,
    });
    out.push({
      index: i,
      description: step.description,
      toolHint: step.toolHint,
      score: verdict.score,
      reason: verdict.reason,
    });
  }
  return out;
}

function aggregate(clusters: readonly ClusterResult[]): E6Aggregate {
  const procedural = clusters.filter((c) => c.kind === "procedural");
  const conceptual = clusters.filter((c) => c.kind === "conceptual");
  const extractionsCorrect = procedural.filter((c) => c.decision === "correct_extracted").length;
  const extractionsMissed = procedural.filter((c) => c.decision === "missed_extraction").length;
  const abstentionsCorrect = conceptual.filter((c) => c.decision === "correct_abstained").length;
  const abstentionsFalseExtraction = conceptual.filter((c) => c.decision === "false_extraction").length;
  const extractedWithScores = procedural.filter(
    (c) => c.decision === "correct_extracted" && c.stepScores.length > 0,
  );
  const meanStep =
    extractedWithScores.length === 0
      ? 0
      : extractedWithScores.reduce((s, c) => s + c.meanStepScore, 0) /
        extractedWithScores.length;
  const lessonPresentCount = clusters.filter((c) => c.lessonPresent).length;
  return {
    clusters: clusters.length,
    procedural: procedural.length,
    conceptual: conceptual.length,
    extractionsCorrect,
    extractionsMissed,
    abstentionsCorrect,
    abstentionsFalseExtraction,
    procedureExtractionRate:
      procedural.length === 0 ? 0 : extractionsCorrect / procedural.length,
    falseProcedureRate:
      conceptual.length === 0 ? 0 : abstentionsFalseExtraction / conceptual.length,
    meanStepCoherence: meanStep,
    lessonStillProducedRate:
      clusters.length === 0 ? 0 : lessonPresentCount / clusters.length,
    httpFailures: clusters.filter((c) => c.status === "http_failed").length,
    parseFailures: clusters.filter((c) => c.status === "parse_failed").length,
  };
}
