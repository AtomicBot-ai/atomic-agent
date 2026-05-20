/**
 * LoCoMo runner. Drives one conversation under one campaign memory
 * profile through the multi-turn driver:
 *
 *  1. Feed each LoCoMo session as one user prompt — gives the
 *     memory layer N legitimate chances to extract facts.
 *  2. Then iterate over the conversation's QA set. Each question is
 *     sent as its **own** prompt in the same session, so the agent
 *     uses its accumulated memory to answer.
 *  3. The assistant reply, gold answer, latency, prompt-token count,
 *     and trace metadata are recorded per question and grouped by
 *     LoCoMo category for cross-profile comparison.
 *
 * Scoring is intentionally **runner-local**: a naive substring +
 * abstention check that lets the runner produce a usable summary
 * without an LLM judge. When the judge is wired in (see
 * `harness/judge.ts`), the spec can re-grade the same NDJSON for a
 * more discerning score; the runner itself stays cheap and
 * deterministic.
 */

import {
  getProfilePromptBudgetMs,
  type CampaignProfileName,
} from "../../config/campaign-profiles.js";
import { runCampaignScenario } from "../../harness/run-campaign-scenario.js";
import type { TurnRecord } from "../../harness/multi-turn-driver.js";
import { percentile } from "../../harness/percentile.js";
import {
  renderConversationPrompts,
  type LocomoCategoryLabel,
  type LocomoConversation,
  type LocomoQuestion,
} from "./dataset.js";

/** Heuristic patterns the runner recognises as "I don't know" replies. */
const ABSTENTION_PATTERNS = [
  /\bi\s*do(?:n['’]?t|\s*not)\s*know\b/i,
  /\bnot\s+(?:mentioned|provided|stated|available|in\s+the\s+conversation)\b/i,
  /\bno\s+(?:information|mention|record)\b/i,
  /\bне\s+знаю\b/i,
  /\bне\s+(?:упоминается|указан[оа]?|сказан[оа]?)\b/i,
  /\bcannot\s+answer\b/i,
];

export interface LocomoRunOptions {
  profile: CampaignProfileName;
  llamaUrl: string;
  conversation: LocomoConversation;
  /** Cap on QA pairs evaluated. Defaults to all. */
  maxQuestions?: number;
  /**
   * Cap on conversation sessions fed into the agent before any
   * question is asked. Defaults to all. LoCoMo `conv-26` ships ~56
   * sessions — feeding every one of them through `full_v2` (which
   * runs reflection + consolidation after each turn) easily takes
   * 30+ minutes on a 3B-active MoE. Smoke runs should clamp this to
   * 5–10 so the QA phase is reachable within the vitest timeout.
   *
   * Skipped sessions are recorded in `sessionsSkipped` on the
   * result — the QA scoring sees only the gold answers; whether the
   * agent could plausibly know them with truncated history is a
   * known tradeoff of the smoke knob.
   */
  maxSessions?: number;
  /**
   * Forwarded to `multi-turn-driver`. Larger budgets are wise for
   * `full_v2` (lessons + voting add steps to early QA replies).
   */
  maxStepsPerTurn?: number;
  /** Hard cap on the subprocess wall clock. */
  timeoutMs?: number;
  /**
   * Drain windows between conversation prompts. Forwarded to the
   * driver — the larger v2 stacks legitimately need a few seconds
   * of reflection time between sessions or the next prompt aborts
   * the pending reflection.
   */
  interPromptDrainMs?: number;
  postLastReplyDrainMs?: number;
  /** Optional override for the temp dir slug. */
  label?: string;
  /**
   * Debug knob — when `true`, the temp `<stateDir>` and `<workingDir>`
   * are kept on disk after the run. Use for postmortem when a long
   * prefill produces empty replies: the state dir's `traces/<id>.ndjson`
   * reveals which session the child agent died on. Off by default.
   */
  keepStateDir?: boolean;
}

export interface LocomoQuestionResult {
  conversationId: string;
  profile: CampaignProfileName;
  category: LocomoCategoryLabel;
  question: string;
  goldAnswer: string;
  adversarial: boolean;
  assistantReply: string;
  /** Substring match score (0 / 1). Cheap baseline; judge supersedes. */
  substringMatch: number;
  /**
   * For adversarial questions, 1 when the reply patterns indicate
   * abstention; 0 otherwise. For non-adversarial, this is 1 when
   * `substringMatch === 1` (the agent did not falsely abstain).
   */
  abstainCorrect: number;
  stepCount: number;
  durationMs: number;
  promptTokens: number;
  predictedTokens: number;
}

export interface LocomoConversationResult {
  conversationId: string;
  profile: CampaignProfileName;
  sessionsFed: number;
  /** Sessions dropped because of `maxSessions`. 0 when uncapped. */
  sessionsSkipped: number;
  questionsAsked: number;
  questions: LocomoQuestionResult[];
  /**
   * Conversation-load phase metrics (the N session prompts). Useful
   * for cost accounting separate from the QA phase.
   */
  loadPhaseDurationMs: number;
  loadPhasePromptTokens: number;
  /** Synthetic — true when the agent subprocess exited cleanly. */
  ok: boolean;
  /** Exit code of the child agent subprocess. -1 == timed out. */
  exitCode: number;
  /** True when `driveMultiTurn` enforced the wall-clock timeout. */
  timedOut: boolean;
  /** Last ~2 KB of subprocess stderr — diagnostic for failed runs. */
  stderrTail: string;
  /** When `keepStateDir: true`, the absolute path to the kept state dir; null otherwise. */
  keptStateDir: string | null;
  /** When `keepStateDir: true`, the absolute path to the kept working dir; null otherwise. */
  keptWorkingDir: string | null;
}

/**
 * Drive one (conversation, profile) pair end-to-end. Throws only on
 * orchestration failures (config seed error, temp dir creation, etc.).
 * A non-zero subprocess exit still returns a populated result with
 * `ok: false` so caller can keep the campaign moving.
 */
export async function runLocomoConversation(
  opts: LocomoRunOptions,
): Promise<LocomoConversationResult> {
  const conv = opts.conversation;
  const allConversationPrompts = renderConversationPrompts(conv);
  const totalSessions = allConversationPrompts.length;
  const conversationPrompts = opts.maxSessions
    ? allConversationPrompts.slice(0, opts.maxSessions)
    : allConversationPrompts;
  const sessionCount = conversationPrompts.length;
  const sessionsSkipped = totalSessions - sessionCount;
  const qa = opts.maxQuestions
    ? conv.qa.slice(0, opts.maxQuestions)
    : conv.qa;
  const questionPrompts = qa.map(formatQuestionPrompt);

  const allPrompts = [...conversationPrompts, ...questionPrompts];
  // Wall-clock budget per scenario prompt is profile-dependent: the
  // legacy `prompts × 60_000` heuristic killed `full_v2` mid-prefill
  // because each reflection-heavy session reply takes ~120-180s, not
  // 60s. `getProfilePromptBudgetMs` carries the calibrated table.
  const perPromptBudgetMs = getProfilePromptBudgetMs(opts.profile);
  const resolvedTimeoutMs =
    opts.timeoutMs ?? Math.max(900_000, allPrompts.length * perPromptBudgetMs);
  const scenario = await runCampaignScenario({
    profile: opts.profile,
    configOptions: { llamaUrl: opts.llamaUrl, maxSteps: opts.maxStepsPerTurn ?? 16 },
    driver: {
      prompts: allPrompts,
      maxSteps: opts.maxStepsPerTurn ?? 16,
      timeoutMs: resolvedTimeoutMs,
      interPromptDrainMs: opts.interPromptDrainMs ?? 0,
      postLastReplyDrainMs: opts.postLastReplyDrainMs ?? 0,
    },
    label: opts.label ?? `locomo-${conv.sampleId}-${opts.profile}`,
    cleanup: opts.keepStateDir ? false : true,
  });

  const turns = scenario.result.turns;
  const loadTurns = turns.slice(0, sessionCount);
  const qaTurns = turns.slice(sessionCount, sessionCount + qa.length);

  const loadPhaseDurationMs = loadTurns.reduce((sum, t) => sum + t.durationMs, 0);
  const loadPhasePromptTokens = loadTurns.reduce(
    (sum, t) => sum + t.promptTokens,
    0,
  );

  const questions: LocomoQuestionResult[] = qa.map((q, i) =>
    scoreQuestion(conv.sampleId, opts.profile, q, qaTurns[i] ?? null),
  );

  return {
    conversationId: conv.sampleId,
    profile: opts.profile,
    sessionsFed: sessionCount,
    sessionsSkipped,
    questionsAsked: qa.length,
    questions,
    loadPhaseDurationMs,
    loadPhasePromptTokens,
    ok: scenario.result.exitCode === 0 && !scenario.result.timedOut,
    exitCode: scenario.result.exitCode,
    timedOut: scenario.result.timedOut,
    stderrTail: scenario.result.stderrTail ?? "",
    keptStateDir: opts.keepStateDir ? scenario.stateDir : null,
    keptWorkingDir: opts.keepStateDir ? scenario.workingDir : null,
  };
}

function formatQuestionPrompt(q: LocomoQuestion): string {
  return (
    `Question: ${q.question}\n` +
    "Answer concisely from what you remember about the earlier conversation. " +
    "If the answer is not present in the conversation, say so explicitly."
  );
}

function scoreQuestion(
  conversationId: string,
  profile: CampaignProfileName,
  q: LocomoQuestion,
  turn: TurnRecord | null,
): LocomoQuestionResult {
  const reply = (turn?.assistantReply ?? "").trim();
  const adversarial = q.category === 5;
  const substringMatch = hasSubstringMatch(reply, q.answer) ? 1 : 0;
  const abstain = isAbstention(reply);
  const abstainCorrect = adversarial
    ? abstain
      ? 1
      : 0
    : substringMatch;
  return {
    conversationId,
    profile,
    category: q.categoryLabel,
    question: q.question,
    goldAnswer: q.answer,
    adversarial,
    assistantReply: reply,
    substringMatch,
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
  // For longer gold answers, look for the first 5 content words
  // (skipping stopwords). Substring match on long sentences is too
  // strict — the LLM judge picks up the slack when wired in.
  const tokens = g.split(/\s+/).filter((t) => t.length > 3).slice(0, 5);
  if (tokens.length === 0) return r.includes(g.slice(0, 32));
  return tokens.every((t) => r.includes(t));
}

function isAbstention(reply: string): boolean {
  return ABSTENTION_PATTERNS.some((re) => re.test(reply));
}

// ---------------------------------------------------------------------------
// Aggregation helpers used by the spec / orchestrator to roll up
// per-conversation results into a per-profile per-category matrix.
// ---------------------------------------------------------------------------

export interface LocomoCategorySummary {
  profile: CampaignProfileName;
  category: LocomoCategoryLabel;
  questions: number;
  substringAccuracy: number;
  abstentionAccuracy: number;
  meanPromptTokens: number;
  /** 50th-percentile of prompt-token counts across questions in this bucket. */
  p50PromptTokens: number;
  /** 95th-percentile of prompt-token counts. Heavy-tail signal. */
  p95PromptTokens: number;
  meanDurationMs: number;
  /** 50th-percentile of per-question wall clock. */
  p50DurationMs: number;
  /** 95th-percentile of per-question wall clock. Heavy-tail signal. */
  p95DurationMs: number;
  meanStepCount: number;
}

export function summariseByCategory(
  results: readonly LocomoConversationResult[],
): LocomoCategorySummary[] {
  const buckets = new Map<string, LocomoQuestionResult[]>();
  for (const conv of results) {
    for (const q of conv.questions) {
      const key = `${q.profile}::${q.category}`;
      const arr = buckets.get(key) ?? [];
      arr.push(q);
      buckets.set(key, arr);
    }
  }
  const out: LocomoCategorySummary[] = [];
  for (const [key, items] of buckets.entries()) {
    if (items.length === 0) continue;
    const [profile, category] = key.split("::") as [
      CampaignProfileName,
      LocomoCategoryLabel,
    ];
    const promptTokens = items.map((q) => q.promptTokens);
    const durationsMs = items.map((q) => q.durationMs);
    out.push({
      profile,
      category,
      questions: items.length,
      substringAccuracy: mean(items.map((q) => q.substringMatch)),
      abstentionAccuracy: mean(items.map((q) => q.abstainCorrect)),
      meanPromptTokens: mean(promptTokens),
      p50PromptTokens: percentile(promptTokens, 0.5),
      p95PromptTokens: percentile(promptTokens, 0.95),
      meanDurationMs: mean(durationsMs),
      p50DurationMs: percentile(durationsMs, 0.5),
      p95DurationMs: percentile(durationsMs, 0.95),
      meanStepCount: mean(items.map((q) => q.stepCount)),
    });
  }
  // Stable order: by profile then category for readable CSVs.
  out.sort((a, b) => {
    if (a.profile !== b.profile) return a.profile.localeCompare(b.profile);
    return a.category.localeCompare(b.category);
  });
  return out;
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}
