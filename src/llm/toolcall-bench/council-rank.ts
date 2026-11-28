/**
 * Peer ranking, the second stage of Karpathy's llm-council (ATO-2432):
 * every member that answered reads the OTHER members' answers, with the
 * names hidden, and ranks them best first. The positions are averaged
 * per member into the council's leaderboard, which the chairman then
 * sees beside the answers.
 *
 * A ranker never sees its own answer, and the answers it does see are
 * relettered A, B, ... for it alone, so a gap in the letters cannot tell
 * it which one was its own.
 *
 * Pure: prompt, parser and the average. The calls live in `run-council`.
 */

import { boundedAnswer, councilLabel, type CouncilMember } from "./model-council.js";

/** Fewer answers than this and a ranking says nothing: each ranker would see one. */
export const COUNCIL_MIN_MEMBERS_TO_RANK = 3;

/** What one ranker sees: the other members under its own letters. */
export interface RankBallot {
  ranker: string;
  /** Letter the ranker sees -> member model (seat id). */
  lettered: CouncilMember[];
}

/** One ranker's order, best first, as seat ids. */
export interface PeerRanking {
  ranker: string;
  order: string[];
  /** Set when the ranker's call failed or its reply named no answer. */
  error?: string;
}

/** One member's place on the leaderboard. */
export interface RankStanding {
  model: string;
  /** Mean position over the rankings that placed it (1 is best). */
  averageRank: number;
  /** How many rankings placed it. */
  votes: number;
}

/** The ballot for `ranker`: every other member, relettered from A. */
export function rankBallot(ranker: string, members: readonly CouncilMember[]): RankBallot {
  const lettered = members
    .filter((m) => m.model !== ranker)
    .map((m, i) => ({ ...m, label: councilLabel(i) }));
  return { ranker, lettered };
}

/** The ranking prompt for one ballot. Model names never appear in it. */
export function buildRankPrompt(question: string, ballot: RankBallot, maxAnswerChars?: number): string {
  const answers = ballot.lettered
    .map((m) => `### Answer ${m.label}\n${boundedAnswer(m.text, maxAnswerChars)}`)
    .join("\n\n");
  const example = ballot.lettered.map((m, i) => `${i + 1}. Answer ${m.label}`).join("\n");
  return [
    "You are a reviewer on a model council. Other models answered the same question on their own.",
    "Their answers are labeled by letter; the names are hidden on purpose so you judge the content.",
    "",
    "## Question",
    question.trim(),
    "",
    "## Answers",
    answers,
    "",
    "First say in one or two sentences per answer what it gets right and what it gets wrong.",
    "Then rank every answer from best to worst: correctness first, then usefulness, then clarity.",
    "End your reply with exactly this block, every answer listed once, nothing after it:",
    "",
    "FINAL RANKING:",
    example,
  ].join("\n");
}

// Capital letter only, so "answer a question" is not read as answer A.
const ANSWER_REF = /\b(?:[Aa]nswer|[Rr]esponse)\s+([A-Z]|M\d+)\b/g;

/**
 * The ranker's order, as seat ids, from its reply. Reads the block after
 * `FINAL RANKING:` when there is one, else every `Answer X` in the reply
 * in order (as llm-council's parser falls back). Unknown and repeated
 * letters are dropped. Empty when nothing usable was found.
 */
export function parseRanking(reply: string, ballot: RankBallot): string[] {
  const marker = /final\s+ranking\s*:?/i.exec(reply);
  const tail = marker ? reply.slice(marker.index + marker[0].length) : reply;
  const order: string[] = [];
  for (const match of tail.matchAll(ANSWER_REF)) {
    const label = match[1]!.toUpperCase();
    const member = ballot.lettered.find((m) => m.label.toUpperCase() === label);
    if (member && !order.includes(member.model)) order.push(member.model);
  }
  if (order.length === 0 && marker) {
    // `1. C` style lines without the word "Answer".
    for (const line of tail.split(/\r?\n/)) {
      const bare = /^\s*\d+[.)]\s*\**([A-Z]|M\d+)\**\s*$/.exec(line);
      if (!bare) continue;
      const member = ballot.lettered.find((m) => m.label.toUpperCase() === bare[1]!.toUpperCase());
      if (member && !order.includes(member.model)) order.push(member.model);
    }
  }
  return order;
}

/**
 * Mean position per member over the usable rankings, best first; ties
 * keep the named order. A member no ranking placed is left out.
 */
export function aggregateRankings(
  rankings: readonly PeerRanking[],
  members: readonly CouncilMember[],
): RankStanding[] {
  const sums = new Map<string, { total: number; votes: number }>();
  for (const ranking of rankings) {
    ranking.order.forEach((model, index) => {
      const cell = sums.get(model) ?? { total: 0, votes: 0 };
      cell.total += index + 1;
      cell.votes += 1;
      sums.set(model, cell);
    });
  }
  const order = new Map(members.map((m, i) => [m.model, i]));
  return [...sums.entries()]
    .filter(([model]) => order.has(model))
    .map(([model, cell]) => ({ model, averageRank: cell.total / cell.votes, votes: cell.votes }))
    .sort((a, b) => a.averageRank - b.averageRank || order.get(a.model)! - order.get(b.model)!);
}
