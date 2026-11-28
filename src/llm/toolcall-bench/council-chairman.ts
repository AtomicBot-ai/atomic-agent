/**
 * The chairman, the last stage of Karpathy's llm-council (ATO-2432): one
 * model reads the question, every answer, the peer ranking and the
 * judge's agree / disagree notes, and writes the single final answer the
 * person reads first. Perplexity Model Council works the same way: a
 * synthesiser whose only job is reading the answers.
 *
 * The answers keep their letters here too, so the chairman weighs the
 * content and the ranking rather than a model's name.
 *
 * Pure: the prompt only. The call lives in `run-council`.
 */

import { boundedAnswer, type CouncilMember, type CouncilSummary } from "./model-council.js";
import type { RankStanding } from "./council-rank.js";

function letterOf(model: string, members: readonly CouncilMember[]): string {
  return members.find((m) => m.model === model)?.label ?? "?";
}

function rankingLines(standings: readonly RankStanding[], members: readonly CouncilMember[]): string[] {
  if (standings.length === 0) return [];
  return [
    "## Peer ranking (each answer ranked by the other council members, 1 is best)",
    ...standings.map((s, i) => `${i + 1}. Answer ${letterOf(s.model, members)}: average place ${s.averageRank.toFixed(1)}`),
    "",
  ];
}

function summaryLines(summary: CouncilSummary | undefined): string[] {
  if (!summary?.parsed) return [];
  const list = (points: readonly string[]) => (points.length === 0 ? ["- none"] : points.map((p) => `- ${p}`));
  return ["## Where the answers agree", ...list(summary.agree), "## Where they disagree", ...list(summary.disagree), ""];
}

/** The prompt the chairman model gets. Model names never appear in it. */
export function buildChairmanPrompt(options: {
  question: string;
  members: readonly CouncilMember[];
  standings?: readonly RankStanding[];
  summary?: CouncilSummary;
  maxAnswerChars?: number;
}): string {
  const answers = options.members
    .map((m) => `### Answer ${m.label}\n${boundedAnswer(m.text, options.maxAnswerChars)}`)
    .join("\n\n");
  return [
    "You are the chairman of a model council. Several models answered the same question on their own,",
    "then reviewed each other. Write the single best final answer to the question for the person who asked.",
    "",
    "## Question",
    options.question.trim(),
    "",
    "## Answers",
    answers,
    "",
    ...rankingLines(options.standings ?? [], options.members),
    ...summaryLines(options.summary),
    "Use what the answers get right, settle their disagreements on the merits, and drop what is wrong.",
    "Answer the question directly, as one voice. Do not mention the council, the letters or the ranking.",
  ].join("\n");
}
