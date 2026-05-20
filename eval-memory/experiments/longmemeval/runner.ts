/**
 * LongMemEval runner. Single (row, profile) shape: feed each haystack
 * session as one user prompt → ask the question → score.
 *
 * Per-axis (not per-question) summary lets us report PLAN.md Phase 3
 * stop-gates: `full_v2` must beat `hybrid` on `knowledge_updates` and
 * `abstention` by ≥ 3 pp on substring + abstention accuracy.
 *
 * The runner is intentionally a near-clone of the LoCoMo runner — the
 * two benchmarks ask the same shape of question (long context + one
 * focused query) and benefit from the same drain knobs / state-dir
 * isolation. Sharing more code via a generic "long-context QA driver"
 * is deferred until a third benchmark of this shape lands.
 */

import type { CampaignProfileName } from "../../config/campaign-profiles.js";
import { runCampaignScenario } from "../../harness/run-campaign-scenario.js";
import type { TurnRecord } from "../../harness/multi-turn-driver.js";
import {
  renderHaystackPrompts,
  type LongMemEvalAxis,
  type LongMemEvalRow,
} from "./dataset.js";

const ABSTENTION_PATTERNS = [
  /\bi\s*do(?:n['’]?t|\s*not)\s*know\b/i,
  /\bnot\s+(?:mentioned|provided|stated|available|in\s+the\s+conversation)\b/i,
  /\bno\s+(?:information|mention|record)\b/i,
  /\bне\s+знаю\b/i,
  /\bне\s+(?:упоминается|указан[оа]?|сказан[оа]?)\b/i,
  /\bcannot\s+answer\b/i,
];

export interface LongMemEvalRunOptions {
  profile: CampaignProfileName;
  llamaUrl: string;
  row: LongMemEvalRow;
  maxStepsPerTurn?: number;
  timeoutMs?: number;
  interPromptDrainMs?: number;
  postLastReplyDrainMs?: number;
  label?: string;
}

export interface LongMemEvalQuestionResult {
  questionId: string;
  profile: CampaignProfileName;
  axis: LongMemEvalAxis;
  questionType: string;
  question: string;
  goldAnswer: string;
  isAbstention: boolean;
  assistantReply: string;
  substringMatch: number;
  /**
   * For abstention rows: 1 when the reply patterns indicate "I don't
   * know"; 0 otherwise. For non-abstention rows: 1 when the substring
   * check found the gold answer AND the reply did NOT spuriously
   * abstain (false-positive abstention is the hallmark failure mode
   * of over-cautious memory layers).
   */
  abstainCorrect: number;
  stepCount: number;
  durationMs: number;
  promptTokens: number;
  predictedTokens: number;
}

export interface LongMemEvalRowResult {
  questionId: string;
  profile: CampaignProfileName;
  sessionsFed: number;
  question: LongMemEvalQuestionResult;
  loadPhaseDurationMs: number;
  loadPhasePromptTokens: number;
  ok: boolean;
}

export async function runLongMemEvalRow(
  opts: LongMemEvalRunOptions,
): Promise<LongMemEvalRowResult> {
  const row = opts.row;
  const sessionPrompts = renderHaystackPrompts(row);
  const questionPrompt = formatQuestionPrompt(row);
  const allPrompts = [...sessionPrompts, questionPrompt];

  const scenario = await runCampaignScenario({
    profile: opts.profile,
    configOptions: { llamaUrl: opts.llamaUrl, maxSteps: opts.maxStepsPerTurn ?? 16 },
    driver: {
      prompts: allPrompts,
      maxSteps: opts.maxStepsPerTurn ?? 16,
      timeoutMs:
        opts.timeoutMs ?? Math.max(900_000, allPrompts.length * 60_000),
      interPromptDrainMs: opts.interPromptDrainMs ?? 0,
      postLastReplyDrainMs: opts.postLastReplyDrainMs ?? 0,
    },
    label: opts.label ?? `lme-${row.questionId}-${opts.profile}`,
  });

  const turns = scenario.result.turns;
  const sessionTurns = turns.slice(0, sessionPrompts.length);
  const qaTurn = turns[sessionPrompts.length] ?? null;

  const loadPhaseDurationMs = sessionTurns.reduce(
    (sum, t) => sum + t.durationMs,
    0,
  );
  const loadPhasePromptTokens = sessionTurns.reduce(
    (sum, t) => sum + t.promptTokens,
    0,
  );

  return {
    questionId: row.questionId,
    profile: opts.profile,
    sessionsFed: sessionPrompts.length,
    question: scoreRow(opts.profile, row, qaTurn),
    loadPhaseDurationMs,
    loadPhasePromptTokens,
    ok: scenario.result.exitCode === 0 && !scenario.result.timedOut,
  };
}

function formatQuestionPrompt(row: LongMemEvalRow): string {
  return (
    `Question: ${row.question}\n` +
    "Answer concisely from what you remember about the earlier sessions. " +
    "If the answer is not present in those sessions, say so explicitly."
  );
}

function scoreRow(
  profile: CampaignProfileName,
  row: LongMemEvalRow,
  turn: TurnRecord | null,
): LongMemEvalQuestionResult {
  const reply = (turn?.assistantReply ?? "").trim();
  const sub = hasSubstringMatch(reply, row.goldAnswer) ? 1 : 0;
  const abstained = isAbstention(reply);
  const abstainCorrect = row.isAbstention
    ? abstained
      ? 1
      : 0
    : abstained
      ? 0 // false-positive abstention on a row that DID have the answer
      : sub;
  return {
    questionId: row.questionId,
    profile,
    axis: row.axis,
    questionType: row.questionType,
    question: row.question,
    goldAnswer: row.goldAnswer,
    isAbstention: row.isAbstention,
    assistantReply: reply,
    substringMatch: sub,
    abstainCorrect,
    stepCount: turn?.stepCount ?? 0,
    durationMs: turn?.durationMs ?? 0,
    promptTokens: turn?.promptTokens ?? 0,
    predictedTokens: turn?.predictedTokens ?? 0,
  };
}

function hasSubstringMatch(reply: string, gold: string): boolean {
  const r = reply.toLowerCase();
  const g = gold.toLowerCase().trim();
  if (g.length === 0) return false;
  if (g.length <= 32) return r.includes(g);
  const tokens = g.split(/\s+/).filter((t) => t.length > 3).slice(0, 5);
  if (tokens.length === 0) return r.includes(g.slice(0, 32));
  return tokens.every((t) => r.includes(t));
}

function isAbstention(reply: string): boolean {
  return ABSTENTION_PATTERNS.some((re) => re.test(reply));
}

export interface LongMemEvalAxisSummary {
  profile: CampaignProfileName;
  axis: LongMemEvalAxis;
  rows: number;
  substringAccuracy: number;
  abstentionAccuracy: number;
  meanPromptTokens: number;
  meanDurationMs: number;
  meanStepCount: number;
}

export function summariseByAxis(
  results: readonly LongMemEvalRowResult[],
): LongMemEvalAxisSummary[] {
  const buckets = new Map<string, LongMemEvalQuestionResult[]>();
  for (const r of results) {
    const key = `${r.profile}::${r.question.axis}`;
    const arr = buckets.get(key) ?? [];
    arr.push(r.question);
    buckets.set(key, arr);
  }
  const out: LongMemEvalAxisSummary[] = [];
  for (const [key, items] of buckets.entries()) {
    if (items.length === 0) continue;
    const [profile, axis] = key.split("::") as [
      CampaignProfileName,
      LongMemEvalAxis,
    ];
    out.push({
      profile,
      axis,
      rows: items.length,
      substringAccuracy: mean(items.map((q) => q.substringMatch)),
      abstentionAccuracy: mean(items.map((q) => q.abstainCorrect)),
      meanPromptTokens: mean(items.map((q) => q.promptTokens)),
      meanDurationMs: mean(items.map((q) => q.durationMs)),
      meanStepCount: mean(items.map((q) => q.stepCount)),
    });
  }
  out.sort((a, b) => {
    if (a.profile !== b.profile) return a.profile.localeCompare(b.profile);
    return a.axis.localeCompare(b.axis);
  });
  return out;
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}
