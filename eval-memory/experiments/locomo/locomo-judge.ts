/**
 * LLM-as-judge post-pass for LoCoMo question results. Reuses the
 * shared `JudgeClient` from `eval-memory/harness/judge.ts` (which in
 * turn reuses the same HTTP path / config / .env knobs as `eval/`).
 *
 * Why a post-pass instead of inline judging during the run:
 *
 *  - Keeps the run-loop fast and deterministic (no extra HTTP hop per
 *    question; the run can finish, the operator can decide to grade
 *    later or grade with a different judge model).
 *  - Lets the judge run in parallel (pLimit) without contending for
 *    the chat llama-server slot.
 *  - Replayable: the same `questions.ndjson` can be re-graded by a
 *    stronger judge later without rerunning the (expensive) agent
 *    sessions.
 *
 * Outputs:
 *  - `judge.ndjson` — one verdict per question, joined back by
 *    (profile, conversationId, question).
 *  - Aggregates are folded into `LocomoCategorySummary` so the
 *    existing `summary.md` / `by-category.csv` writer picks them up
 *    with the same column convention.
 *
 * Errors are non-fatal: a judge call that times out / 5xx is recorded
 * as `score: 1, parseFallback: true, reason: "judge unavailable"` so
 * the aggregator sees a worst-case score (publication-safe — we never
 * silently drop a failed judge call into the mean).
 */

import type { CampaignProfileName } from "../../config/campaign-profiles.js";
import type { JudgeClient } from "../../harness/judge.js";
import { scoreWithRetry } from "../../harness/judge.js";
import { pLimit } from "../../harness/p-limit.js";
import type { LocomoCategoryLabel, LocomoQuestion } from "./dataset.js";
import {
  buildLocomoJudgePrompt,
  buildLocomoRubric,
  type RubricOptions,
} from "./locomo-rubric.js";
import type { LocomoQuestionResult } from "./runner.js";

export interface LocomoJudgeVerdict {
  conversationId: string;
  profile: CampaignProfileName;
  category: LocomoCategoryLabel;
  question: string;
  goldAnswer: string;
  reply: string;
  /** 1..5; 1 also used as "judge unavailable" fallback (see `available`). */
  score: number;
  /** Free-form judge reason; capped at ~400 chars by the judge client. */
  reason: string;
  /** False when the judge call failed; score is then the worst-case 1. */
  available: boolean;
  durationMs: number;
}

export interface LocomoJudgeRunOptions {
  judge: JudgeClient;
  /** Per-question (question + rubric) inputs to grade. Required. */
  inputs: ReadonlyArray<{
    profile: CampaignProfileName;
    conversationId: string;
    question: LocomoQuestion;
    reply: string;
  }>;
  /** Hard cap on simultaneous judge HTTP calls. Default 3. */
  concurrency?: number;
  /** Retries per judge call. Default 1 (one retry on transient errors). */
  retries?: number;
  /** Backoff between retries (ms). Default 500. */
  backoffMs?: number;
  /** Forwarded to the rubric builder. Default `{}`. */
  rubricOptions?: RubricOptions;
}

/**
 * Score every question in `inputs` against the judge and return one
 * verdict per question, in input order. Never throws — individual
 * failures land as `available: false` verdicts.
 */
export async function judgeLocomoResults(
  opts: LocomoJudgeRunOptions,
): Promise<LocomoJudgeVerdict[]> {
  const limit = pLimit(opts.concurrency ?? 3);
  const retries = opts.retries ?? 1;
  const backoffMs = opts.backoffMs ?? 500;
  const rubricOpts = opts.rubricOptions ?? {};

  const tasks = opts.inputs.map((input) =>
    limit(async (): Promise<LocomoJudgeVerdict> => {
      const promptText = buildLocomoJudgePrompt(input.question);
      const rubric = buildLocomoRubric(input.question, rubricOpts);
      const reply = input.reply.trim();
      const empty = reply.length === 0;
      if (empty) {
        return {
          conversationId: input.conversationId,
          profile: input.profile,
          category: input.question.categoryLabel,
          question: input.question.question,
          goldAnswer: input.question.answer,
          reply,
          score: 1,
          reason: "empty reply — score floored to 1 without invoking the judge",
          available: true,
          durationMs: 0,
        };
      }
      try {
        const verdict = await scoreWithRetry(
          opts.judge,
          { prompt: promptText, reply, rubric },
          { retries, backoffMs },
        );
        return {
          conversationId: input.conversationId,
          profile: input.profile,
          category: input.question.categoryLabel,
          question: input.question.question,
          goldAnswer: input.question.answer,
          reply,
          score: verdict.score,
          reason: verdict.reason,
          available: !verdict.parseFallback,
          durationMs: verdict.durationMs,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          conversationId: input.conversationId,
          profile: input.profile,
          category: input.question.categoryLabel,
          question: input.question.question,
          goldAnswer: input.question.answer,
          reply,
          score: 1,
          reason: `judge unavailable: ${msg.slice(0, 180)}`,
          available: false,
          durationMs: 0,
        };
      }
    }),
  );

  return Promise.all(tasks);
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface LocomoJudgeCategorySummary {
  profile: CampaignProfileName;
  category: LocomoCategoryLabel;
  graded: number;
  /** Number of verdicts where the judge call did not fail. */
  judgeAvailable: number;
  meanJudgeScore: number;
  /** Fraction of replies scoring >= 4 (the headline "passing" rate). */
  judgeAccAtFour: number;
  /** Fraction of replies scoring 5 (strict-correct). */
  judgeAccAtFive: number;
}

/**
 * Group verdicts by (profile, category) and roll up the publication
 * metrics. Mirrors `summariseByCategory` in `runner.ts` so the two
 * tables align column-for-column in the final `summary.md`.
 */
export function summariseJudgeByCategory(
  verdicts: readonly LocomoJudgeVerdict[],
): LocomoJudgeCategorySummary[] {
  const buckets = new Map<string, LocomoJudgeVerdict[]>();
  for (const v of verdicts) {
    const key = `${v.profile}::${v.category}`;
    const arr = buckets.get(key) ?? [];
    arr.push(v);
    buckets.set(key, arr);
  }
  const out: LocomoJudgeCategorySummary[] = [];
  for (const [key, items] of buckets.entries()) {
    if (items.length === 0) continue;
    const [profile, category] = key.split("::") as [
      CampaignProfileName,
      LocomoCategoryLabel,
    ];
    const judgeAvailable = items.filter((v) => v.available).length;
    const scores = items.map((v) => v.score);
    out.push({
      profile,
      category,
      graded: items.length,
      judgeAvailable,
      meanJudgeScore: mean(scores),
      judgeAccAtFour: items.filter((v) => v.score >= 4).length / items.length,
      judgeAccAtFive: items.filter((v) => v.score >= 5).length / items.length,
    });
  }
  out.sort((a, b) => {
    if (a.profile !== b.profile) return a.profile.localeCompare(b.profile);
    return a.category.localeCompare(b.category);
  });
  return out;
}

/**
 * Pair each judge verdict with the matching runner-side
 * `LocomoQuestionResult` so callers can join cheaply for downstream
 * reporting. Returns `[verdict, runnerResult]` pairs in `verdicts`
 * order, with `runnerResult: null` when no match was found (should be
 * rare — would indicate the runner / judge inputs drifted).
 */
export function alignVerdictsWithRunner(
  verdicts: readonly LocomoJudgeVerdict[],
  runnerResults: readonly LocomoQuestionResult[],
): Array<[LocomoJudgeVerdict, LocomoQuestionResult | null]> {
  const byKey = new Map<string, LocomoQuestionResult>();
  for (const r of runnerResults) {
    byKey.set(`${r.profile}::${r.conversationId}::${r.question}`, r);
  }
  return verdicts.map((v) => {
    const key = `${v.profile}::${v.conversationId}::${v.question}`;
    return [v, byKey.get(key) ?? null] as [
      LocomoJudgeVerdict,
      LocomoQuestionResult | null,
    ];
  });
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}
