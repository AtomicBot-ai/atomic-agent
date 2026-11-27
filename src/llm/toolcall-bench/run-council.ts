/**
 * The whole model council in one call (ATO-2432), shared by the
 * `models council` command, the TUI's `/council` and `POST /api/council`
 * (the desktop view). The stages follow Karpathy's llm-council:
 *
 * 1. every seat answers the question at once (a seat may be one model
 *    several times, Self-MoA);
 * 2. at the same time: the judge lists Agree / Disagree / Unique
 *    (ATO-2232), and every member ranks the others' answers, names hidden;
 * 3. the chairman reads all of it and writes the final answer.
 *
 * Every stage degrades instead of failing the council: a failed seat is
 * left out, a failed judge or ranker is reported beside the rest, and a
 * failed chairman still leaves the answers, summary and ranking.
 */

import { askManyModels, type ModelAnswer } from "./ask-many-models.js";
import { buildChairmanPrompt } from "./council-chairman.js";
import {
  COUNCIL_MIN_MEMBERS_TO_RANK,
  aggregateRankings,
  buildRankPrompt,
  parseRanking,
  rankBallot,
  type PeerRanking,
  type RankStanding,
} from "./council-rank.js";
import type { CouncilSeat } from "./council-seats.js";
import {
  COUNCIL_MAX_ANSWER_CHARS,
  buildCouncilPrompt,
  councilMembers,
  parseCouncilSummary,
  type CouncilSummary,
} from "./model-council.js";

/** Output bound of one seat's answer. */
export const COUNCIL_ANSWER_MAX_TOKENS = 2048;
/** The judge writes three short lists. */
export const COUNCIL_JUDGE_MAX_TOKENS = 2048;
/** A ranker writes a line per answer and the final block. */
export const COUNCIL_RANK_MAX_TOKENS = 1024;
/** The chairman writes the final answer. */
export const COUNCIL_CHAIRMAN_MAX_TOKENS = 3072;
/** Room for the instructions around the quoted answers in a prompt. */
const PROMPT_FRAME_CHARS = 1_500;
/** Never cut an answer shorter than this, even for a small request bound. */
const MIN_ANSWER_CHARS = 500;

/** One request of the council. May throw; a throw counts as that call failing. */
export interface CouncilCall {
  spec: string;
  prompt: string;
  maxTokens: number;
  temperature?: number;
  signal?: AbortSignal;
}
export type CouncilComplete = (call: CouncilCall) => Promise<string>;

export type CouncilProgress =
  | { stage: "answering"; total: number }
  | { stage: "answered"; seat: string; ok: boolean; done: number; total: number }
  | { stage: "reviewing"; judge: string; rankers: number }
  | { stage: "chairman"; chairman: string }
  | { stage: "done" };

export interface CouncilChairmanResult {
  model: string;
  text?: string;
  error?: string;
}

/** Everything the council produced; what `--json` and `POST /api/council` return. */
export interface CouncilReport {
  question: string;
  seats: CouncilSeat[];
  answers: ModelAnswer[];
  judge: string;
  summary?: CouncilSummary;
  judgeError?: string;
  /** Per ranker; absent when the ranking was off or there were too few answers. */
  rankings?: PeerRanking[];
  /** The leaderboard, best first. */
  standings?: RankStanding[];
  chairman?: CouncilChairmanResult;
  /** Why a stage was skipped, in plain words (`only one answer; nothing to compare`). */
  notes: string[];
  cancelled?: boolean;
}

export interface RunCouncilOptions {
  question: string;
  seats: readonly CouncilSeat[];
  /** Spec of the judge; defaults to the first seat's. */
  judge?: string;
  /** Spec of the chairman; defaults to the judge. `null` skips the chairman. */
  chairman?: string | null;
  /** Peer ranking on (default) or off. */
  rank?: boolean;
  complete: CouncilComplete;
  signal?: AbortSignal;
  onProgress?: (event: CouncilProgress) => void;
  /** Longest prompt one request may carry (the runtime's plain route has a bound). */
  maxPromptChars?: number;
  now?: () => number;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Per-answer cut so a prompt quoting `count` answers fits `maxPromptChars`. */
export function councilAnswerBudget(question: string, count: number, maxPromptChars?: number): number {
  if (maxPromptChars === undefined || count <= 0) return COUNCIL_MAX_ANSWER_CHARS;
  const room = Math.floor((maxPromptChars - question.length - PROMPT_FRAME_CHARS) / count);
  return Math.max(MIN_ANSWER_CHARS, Math.min(COUNCIL_MAX_ANSWER_CHARS, room));
}

export async function runCouncil(options: RunCouncilOptions): Promise<CouncilReport> {
  const { question, seats, complete, signal } = options;
  const emit = options.onProgress ?? (() => undefined);
  const judge = options.judge ?? seats[0]?.spec ?? "";
  const chairman = options.chairman === null ? null : (options.chairman ?? judge);
  const report: CouncilReport = { question, seats: [...seats], answers: [], judge, notes: [] };
  const cancelled = () => {
    if (!signal?.aborted) return false;
    report.cancelled = true;
    return true;
  };
  if (seats.length === 0 || cancelled()) return report;

  const bySeat = new Map(seats.map((s) => [s.id, s]));
  let done = 0;
  emit({ stage: "answering", total: seats.length });
  report.answers = await askManyModels({
    models: seats.map((s) => s.id),
    prompt: question,
    ...(options.now ? { now: options.now } : {}),
    complete: async (seatId, prompt) => {
      const seat = bySeat.get(seatId)!;
      let ok = false;
      try {
        const text = await complete({
          spec: seat.spec,
          prompt,
          maxTokens: COUNCIL_ANSWER_MAX_TOKENS,
          ...(seat.temperature !== undefined ? { temperature: seat.temperature } : {}),
          ...(signal ? { signal } : {}),
        });
        ok = text.trim() !== "";
        return text;
      } finally {
        done += 1;
        emit({ stage: "answered", seat: seatId, ok, done, total: seats.length });
      }
    },
  });
  if (cancelled()) return report;

  const members = councilMembers(report.answers);
  if (members.length === 0) {
    report.notes.push("every model failed; nothing to judge");
    emit({ stage: "done" });
    return report;
  }
  if (members.length === 1) {
    report.notes.push("only one answer; nothing to compare");
    emit({ stage: "done" });
    return report;
  }

  const rank = options.rank !== false && members.length >= COUNCIL_MIN_MEMBERS_TO_RANK;
  if (options.rank !== false && !rank) {
    report.notes.push(`ranking needs ${COUNCIL_MIN_MEMBERS_TO_RANK} answers; skipped`);
  }
  emit({ stage: "reviewing", judge, rankers: rank ? members.length : 0 });
  const judgeBudget = councilAnswerBudget(question, members.length, options.maxPromptChars);
  const rankBudget = councilAnswerBudget(question, members.length - 1, options.maxPromptChars);
  const judging = (async () => {
    try {
      const reply = await complete({
        spec: judge,
        prompt: buildCouncilPrompt(question, members, judgeBudget),
        maxTokens: COUNCIL_JUDGE_MAX_TOKENS,
        ...(signal ? { signal } : {}),
      });
      report.summary = parseCouncilSummary(reply, members);
    } catch (err) {
      report.judgeError = errorText(err);
    }
  })();
  const ranking = rank
    ? Promise.all(
        members.map(async (member): Promise<PeerRanking> => {
          const ballot = rankBallot(member.model, members);
          try {
            const reply = await complete({
              spec: bySeat.get(member.model)?.spec ?? member.model,
              prompt: buildRankPrompt(question, ballot, rankBudget),
              maxTokens: COUNCIL_RANK_MAX_TOKENS,
              ...(signal ? { signal } : {}),
            });
            const order = parseRanking(reply, ballot);
            return order.length > 0
              ? { ranker: member.model, order }
              : { ranker: member.model, order: [], error: "the reply named no answer" };
          } catch (err) {
            return { ranker: member.model, order: [], error: errorText(err) };
          }
        }),
      )
    : Promise.resolve(undefined);
  const [, rankings] = await Promise.all([judging, ranking]);
  if (rankings) {
    report.rankings = rankings;
    report.standings = aggregateRankings(rankings, members);
  }
  if (cancelled()) return report;

  if (chairman !== null) {
    emit({ stage: "chairman", chairman });
    // The chairman also reads the summary and the ranking; leave room for them.
    const extra =
      (report.summary ? [...report.summary.agree, ...report.summary.disagree].join("\n").length + 200 : 0) +
      (report.standings?.length ?? 0) * 60;
    const chairmanBudget = councilAnswerBudget(
      question,
      members.length,
      options.maxPromptChars === undefined ? undefined : options.maxPromptChars - extra,
    );
    try {
      const text = await complete({
        spec: chairman,
        prompt: buildChairmanPrompt({
          question,
          members,
          ...(report.standings ? { standings: report.standings } : {}),
          ...(report.summary ? { summary: report.summary } : {}),
          maxAnswerChars: chairmanBudget,
        }),
        maxTokens: COUNCIL_CHAIRMAN_MAX_TOKENS,
        ...(signal ? { signal } : {}),
      });
      report.chairman = text.trim() === ""
        ? { model: chairman, error: "the chairman returned no answer" }
        : { model: chairman, text: text.trim() };
    } catch (err) {
      report.chairman = { model: chairman, error: errorText(err) };
    }
    if (cancelled()) return report;
  }
  emit({ stage: "done" });
  return report;
}
