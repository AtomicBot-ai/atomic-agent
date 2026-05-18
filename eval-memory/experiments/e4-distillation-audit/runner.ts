/**
 * E4 — distillation-quality runner.
 *
 *  1. For each cluster, call distill in isolation with the seeded
 *     episodes + sharedTags.
 *  2. For each produced lesson, ask the judge three separate scores
 *     (activation match, principle match, coverage) — each 1..5.
 *  3. Aggregate per-cluster and globally.
 *
 * `none` and `parse_failed` outcomes are counted but do not get a
 * judge score — they are "model declined to distill" / "model
 * emitted unparseable garbage" respectively, both bad.
 */

import { runIsolatedDistill, type IsolatedDistillOutcome } from "../../harness/distill-isolated.js";
import { scoreWithRetry, type JudgeClient } from "../../harness/judge.js";
import type { LlmCompleteParams, LlmCompleteResult } from "../../harness/llm-client.js";

import { DISTILL_CLUSTERS, type DistillCluster, type GoldLesson } from "./dataset.js";

export type DistillStatus = "lesson" | "none" | "parse_failed" | "http_failed";

export interface DistillAxisScore {
  axis: "activation" | "principle" | "coverage";
  score: number;
  reason: string;
}

export interface ClusterResult {
  clusterId: string;
  label: string;
  status: DistillStatus;
  gold: GoldLesson;
  produced: { activation: string; principle: string; tags: readonly string[] } | null;
  raw: string;
  axisScores: readonly DistillAxisScore[];
  /** Average across the three axes; 0 when status !== "lesson". */
  meanScore: number;
  durationMs: number;
}

export interface E4Aggregate {
  clusters: number;
  lessons: number;
  abstentions: number;
  parseFailures: number;
  httpFailures: number;
  /** Mean of per-cluster meanScore where status === "lesson". */
  meanLessonScore: number;
  /** P(meanScore >= 4 OR (status==="lesson" AND each axis >=3)). */
  usefulLessonsRate: number;
  /** P(any axis <= 1) across produced lessons. */
  wrongLessonsRate: number;
}

export interface E4Report {
  clusters: readonly ClusterResult[];
  aggregate: E4Aggregate;
}

export interface E4RunnerDeps {
  llmComplete: (params: LlmCompleteParams) => Promise<LlmCompleteResult>;
  judge: JudgeClient;
}

export interface E4RunnerOptions {
  clusterIds?: readonly string[];
  temperature?: number;
  /** Per-cluster wall-clock cap. Default 90s. */
  timeoutMs?: number;
}

const DEFAULT_RUBRIC = [
  "Score 5 when the produced text matches the gold's intent and specificity precisely.",
  "Score 4 when it captures the same idea but loses one specific detail.",
  "Score 3 when it captures the general topic but misses the key actionable insight.",
  "Score 2 when it is on-topic but largely wrong or vague.",
  "Score 1 when it contradicts the gold or invents unrelated content.",
].join("\n");

export async function runE4(deps: E4RunnerDeps, opts: E4RunnerOptions = {}): Promise<E4Report> {
  const selected = opts.clusterIds
    ? DISTILL_CLUSTERS.filter((c) => opts.clusterIds!.includes(c.id))
    : DISTILL_CLUSTERS;
  const clusters: ClusterResult[] = [];
  for (const c of selected) {
    const result = await runOneCluster(c, deps, opts);
    clusters.push(result);
  }
  return { clusters, aggregate: aggregate(clusters) };
}

async function runOneCluster(
  c: DistillCluster,
  deps: E4RunnerDeps,
  opts: E4RunnerOptions,
): Promise<ClusterResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 90_000);
  try {
    const distillOpts: Parameters<typeof runIsolatedDistill>[1] = {
      llmComplete: deps.llmComplete,
    };
    if (opts.temperature !== undefined) distillOpts.temperature = opts.temperature;
    const outcome = await runIsolatedDistill(
      {
        episodes: c.episodes,
        sharedTags: c.sharedTags,
        sessionId: `e4-${c.id}`,
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
  c: DistillCluster,
  outcome: IsolatedDistillOutcome,
  judge: JudgeClient,
): Promise<ClusterResult> {
  if (outcome.kind === "none") {
    return {
      clusterId: c.id,
      label: c.label,
      status: "none",
      gold: c.gold,
      produced: null,
      raw: outcome.raw,
      axisScores: [],
      meanScore: 0,
      durationMs: outcome.durationMs,
    };
  }
  if (outcome.kind === "parse_failed") {
    return {
      clusterId: c.id,
      label: c.label,
      status: "parse_failed",
      gold: c.gold,
      produced: null,
      raw: outcome.raw,
      axisScores: [],
      meanScore: 0,
      durationMs: outcome.durationMs,
    };
  }
  if (outcome.kind === "http_failed") {
    return {
      clusterId: c.id,
      label: c.label,
      status: "http_failed",
      gold: c.gold,
      produced: null,
      raw: outcome.reason,
      axisScores: [],
      meanScore: 0,
      durationMs: 0,
    };
  }

  const produced = {
    activation: outcome.parsed.activation,
    principle: outcome.parsed.principle,
    tags: outcome.parsed.tags,
  };
  const axisScores = await Promise.all([
    judgeAxis(c, "activation", produced.activation, c.gold.activation, judge),
    judgeAxis(c, "principle", produced.principle, c.gold.principle, judge),
    judgeAxis(c, "coverage", `${produced.activation}\n${produced.principle}`, `${c.gold.activation}\n${c.gold.principle}`, judge),
  ]);
  const meanScore = axisScores.reduce((s, a) => s + a.score, 0) / axisScores.length;
  return {
    clusterId: c.id,
    label: c.label,
    status: "lesson",
    gold: c.gold,
    produced,
    raw: outcome.raw,
    axisScores,
    meanScore,
    durationMs: outcome.durationMs,
  };
}

async function judgeAxis(
  c: DistillCluster,
  axis: DistillAxisScore["axis"],
  produced: string,
  gold: string,
  judge: JudgeClient,
): Promise<DistillAxisScore> {
  const axisInstruction = axis === "activation"
    ? "Compare the activation strings. Does the produced one trigger on the same conditions as the gold?"
    : axis === "principle"
      ? "Compare the principle. Does the produced one capture the same actionable insight as the gold?"
      : "Compare the lesson as a whole. Does the produced lesson cover the same scope and specificity as the gold?";
  const prompt = [
    `== EPISODES (cluster: ${c.label}) ==`,
    c.episodes.map((e, i) => `${i + 1}. ${e.content}`).join("\n"),
    "",
    "== GOLD LESSON (operator-authored) ==",
    `activation: ${gold.split("\n")[0]}`,
    gold.includes("\n") ? `principle: ${gold.split("\n").slice(1).join(" ")}` : "",
    "",
    "== PRODUCED ==",
    produced,
    "",
    `Axis: ${axis}. ${axisInstruction}`,
  ].filter((line) => line.length > 0).join("\n");
  const verdict = await scoreWithRetry(judge, {
    prompt,
    reply: produced,
    rubric: c.rubric ?? DEFAULT_RUBRIC,
  });
  return { axis, score: verdict.score, reason: verdict.reason };
}

function aggregate(clusters: readonly ClusterResult[]): E4Aggregate {
  const lessons = clusters.filter((c) => c.status === "lesson");
  const abstentions = clusters.filter((c) => c.status === "none").length;
  const parseFailures = clusters.filter((c) => c.status === "parse_failed").length;
  const httpFailures = clusters.filter((c) => c.status === "http_failed").length;
  const mean = lessons.length === 0
    ? 0
    : lessons.reduce((s, c) => s + c.meanScore, 0) / lessons.length;
  const useful = lessons.filter((c) => c.meanScore >= 4 || c.axisScores.every((a) => a.score >= 3)).length;
  const wrong = lessons.filter((c) => c.axisScores.some((a) => a.score <= 1)).length;
  return {
    clusters: clusters.length,
    lessons: lessons.length,
    abstentions,
    parseFailures,
    httpFailures,
    meanLessonScore: mean,
    usefulLessonsRate: clusters.length === 0 ? 0 : useful / clusters.length,
    wrongLessonsRate: clusters.length === 0 ? 0 : wrong / clusters.length,
  };
}
