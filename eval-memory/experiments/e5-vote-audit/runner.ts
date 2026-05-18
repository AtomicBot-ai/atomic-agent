/**
 * E5 — vote decision audit runner.
 *
 *  1. For each dataset case, call the vote sub-call in isolation via
 *     `runIsolatedVote` (LLM + GBNF + parser; no `VoteStore` writes).
 *  2. For every gold candidate of the case, determine which class
 *     the produced votes fall into:
 *       - correct_upvote      — UPVOTE on helpful
 *       - correct_downvote    — DOWNVOTE on noise
 *       - correct_abstain     — no vote on neutral
 *       - missed_signal       — no vote on helpful  (false negative)
 *       - false_upvote        — UPVOTE on noise or neutral
 *       - false_downvote      — DOWNVOTE on helpful (or on neutral)
 *  3. Score each decision via the judge (1..5) using the per-case
 *     rubric. Aggregate per-case + global rates.
 *
 * NOTE on the abstain semantics: gold labels `neutral` mean "no
 * strong opinion either way"; the model is allowed to abstain or
 * mildly DOWNVOTE without losing points. A *helpful* item with no
 * vote is a missed signal — we want the curator to be active when
 * it matters.
 */

import { runIsolatedVote } from "../../harness/vote-isolated.js";
import { scoreWithRetry, type JudgeClient } from "../../harness/judge.js";
import type { LlmCompleteParams, LlmCompleteResult } from "../../harness/llm-client.js";
import type { ParsedVote, ParseRejection } from "../../../src/memory/voting/index.js";

import {
  VOTE_AUDIT_CASES,
  type GoldCandidate,
  type GoldLabel,
  type VoteAuditCase,
} from "./dataset.js";

export type DecisionClass =
  | "correct_upvote"
  | "correct_downvote"
  | "correct_abstain"
  | "missed_signal"
  | "false_upvote"
  | "false_downvote";

export interface GradedDecision {
  caseId: string;
  candidateKey: string;
  gold: GoldLabel;
  produced: "UPVOTE" | "DOWNVOTE" | "NONE";
  decision: DecisionClass;
  score: number;
  reason: string;
  judgeMs: number;
}

export interface CaseResult {
  caseId: string;
  label: string;
  raw: string;
  durationMs: number;
  /** Outcome of the vote sub-call: how the model framed the turn. */
  parseKind: "votes" | "none" | "http_failed";
  /** Parsed votes (after allowlist enforcement). */
  votes: readonly ParsedVote[];
  /** Parser rejections — already filtered by allowlist + dedup. */
  rejected: readonly ParseRejection[];
  /** One row per gold candidate. */
  decisions: readonly GradedDecision[];
  /** Average judge score across decisions in this case. */
  meanScore: number;
}

export interface E5Aggregate {
  cases: number;
  decisions: number;
  correctness: number;
  /** P(missed_signal) — share of helpful items left without UPVOTE. */
  missedSignalRate: number;
  /** P(false_upvote OR false_downvote) — actively wrong votes. */
  falseVoteRate: number;
  /** Mean per-decision judge score across the whole campaign. */
  meanScore: number;
  /** http_failed / parse-bound cases, surfaced for ops. */
  httpFailures: number;
  /** Allowlist rejections — should always be 0 for synthetic data. */
  notSurfacedRejections: number;
}

export interface E5Report {
  cases: readonly CaseResult[];
  aggregate: E5Aggregate;
}

export interface E5RunnerDeps {
  llmComplete: (params: LlmCompleteParams) => Promise<LlmCompleteResult>;
  judge: JudgeClient;
}

export interface E5RunnerOptions {
  caseIds?: readonly string[];
  temperature?: number;
  /** Per-case wall-clock timeout (ms). Defaults to 60 s. */
  timeoutMs?: number;
}

export async function runE5(deps: E5RunnerDeps, opts: E5RunnerOptions = {}): Promise<E5Report> {
  const selected = opts.caseIds
    ? VOTE_AUDIT_CASES.filter((c) => opts.caseIds!.includes(c.id))
    : VOTE_AUDIT_CASES;
  const cases: CaseResult[] = [];

  for (const c of selected) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
    try {
      const voteDeps: Parameters<typeof runIsolatedVote>[1] = {
        llmComplete: deps.llmComplete,
      };
      if (opts.temperature !== undefined) voteDeps.temperature = opts.temperature;
      const outcome = await runIsolatedVote(
        {
          userMessage: c.userMessage,
          assistantReply: c.assistantReply,
          candidates: c.candidates,
          sessionId: `e5-${c.id}`,
          signal: controller.signal,
        },
        voteDeps,
      );

      if (outcome.kind === "http_failed") {
        cases.push({
          caseId: c.id,
          label: c.label,
          raw: outcome.reason,
          durationMs: 0,
          parseKind: "http_failed",
          votes: [],
          rejected: [],
          decisions: [],
          meanScore: 0,
        });
        continue;
      }

      const votes = outcome.kind === "votes" ? outcome.votes : [];
      const rejected = outcome.kind === "votes" ? outcome.rejected : [];
      const decisions = await gradeCase(c, votes, deps.judge);
      const mean =
        decisions.length === 0
          ? 0
          : decisions.reduce((s, d) => s + d.score, 0) / decisions.length;
      cases.push({
        caseId: c.id,
        label: c.label,
        raw: outcome.raw,
        durationMs: outcome.durationMs,
        parseKind: outcome.kind,
        votes,
        rejected,
        decisions,
        meanScore: mean,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return { cases, aggregate: aggregate(cases) };
}

async function gradeCase(
  c: VoteAuditCase,
  votes: readonly ParsedVote[],
  judge: JudgeClient,
): Promise<readonly GradedDecision[]> {
  const out: GradedDecision[] = [];
  for (const gold of c.gold) {
    const matching = votes.find((v) => v.kind === gold.kind && v.targetId === gold.id);
    const produced: GradedDecision["produced"] =
      !matching ? "NONE" : matching.direction === 1 ? "UPVOTE" : "DOWNVOTE";
    const decision = classify(gold.label, produced);
    const graded = await gradeOne(c, gold, produced, decision, judge);
    out.push(graded);
  }
  return out;
}

function classify(label: GoldLabel, produced: GradedDecision["produced"]): DecisionClass {
  if (label === "helpful") {
    if (produced === "UPVOTE") return "correct_upvote";
    if (produced === "DOWNVOTE") return "false_downvote";
    return "missed_signal";
  }
  if (label === "noise") {
    if (produced === "DOWNVOTE") return "correct_downvote";
    if (produced === "UPVOTE") return "false_upvote";
    return "correct_abstain"; // abstaining on noise is acceptable
  }
  // neutral
  if (produced === "NONE") return "correct_abstain";
  if (produced === "UPVOTE") return "false_upvote";
  return "false_downvote";
}

async function gradeOne(
  c: VoteAuditCase,
  gold: GoldCandidate,
  produced: GradedDecision["produced"],
  decision: DecisionClass,
  judge: JudgeClient,
): Promise<GradedDecision> {
  const candidate = c.candidates.find((cand) => cand.kind === gold.kind && cand.id === gold.id);
  const preview = candidate?.preview ?? "(unknown)";
  const prompt = [
    "== USER MESSAGE ==",
    c.userMessage,
    "",
    "== ASSISTANT REPLY ==",
    c.assistantReply,
    "",
    `== SURFACED ITEM (${gold.kind}:${gold.id}) ==`,
    preview,
    `gold label : ${gold.label}`,
    `gold reason: ${gold.why}`,
    "",
    "== VOTE DECISION BY THE MODEL ==",
    produced,
    "",
    `Decision class: ${decision}.`,
    "Score the vote decision under the rubric. Be strict: confidently correct = high; inverted or missed-when-clear = low; ambiguous-neutral cases earn middle.",
  ].join("\n");
  const verdict = await scoreWithRetry(judge, {
    prompt,
    reply: produced,
    rubric: c.rubric,
  });
  return {
    caseId: c.id,
    candidateKey: `${gold.kind}:${gold.id}`,
    gold: gold.label,
    produced,
    decision,
    score: verdict.score,
    reason: verdict.reason,
    judgeMs: verdict.durationMs,
  };
}

function aggregate(cases: readonly CaseResult[]): E5Aggregate {
  const all = cases.flatMap((c) => c.decisions);
  const httpFailures = cases.filter((c) => c.parseKind === "http_failed").length;
  const notSurfacedRejections = cases.reduce(
    (s, c) => s + c.rejected.filter((r) => r.reason === "not_surfaced").length,
    0,
  );
  const helpful = all.filter((d) => d.gold === "helpful");
  const missed = helpful.filter((d) => d.decision === "missed_signal").length;
  const falseVotes = all.filter(
    (d) => d.decision === "false_upvote" || d.decision === "false_downvote",
  ).length;
  const correct = all.filter(
    (d) =>
      d.decision === "correct_upvote" ||
      d.decision === "correct_downvote" ||
      d.decision === "correct_abstain",
  ).length;
  const sum = all.reduce((s, d) => s + d.score, 0);
  return {
    cases: cases.length,
    decisions: all.length,
    correctness: all.length === 0 ? 0 : correct / all.length,
    missedSignalRate: helpful.length === 0 ? 0 : missed / helpful.length,
    falseVoteRate: all.length === 0 ? 0 : falseVotes / all.length,
    meanScore: all.length === 0 ? 0 : sum / all.length,
    httpFailures,
    notSurfacedRejections,
  };
}
