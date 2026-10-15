import type { CompactionPlan } from "../prompt/plan-compaction.js";
import { estimateTokens } from "../prompt/token-budget.js";
import { renderTurnForPrompt, type ConversationTurn } from "../session/conversation-turn.js";
import { safeCompactionCuts, validRollingSummary, type RollingCompactionSummary } from "../session/session-compaction.js";
import type { SessionState } from "../session/session-state.js";
import { buildExtractiveSummary, clipMiddle } from "./compaction-extractive.js";

/** Ceiling, in estimated tokens, of the new records one background job reads. */
export const ROLLING_JOB_MAX_SOURCE_TOKENS = 12_000;
/** One record's rendered line is cut in the middle beyond this many characters. */
export const ROLLING_RECORD_MAX_CHARS = 2_000;
/**
 * Share of the planned summary size the rolling summary may use, leaving
 * the rest for the extractive summary of the records written after it.
 */
export const ROLLING_SUMMARY_SHARE = 0.6;
/** Smallest extractive tail worth appending; below it the rolling summary is not used. */
const MIN_TAIL_TOKENS = 96;
/**
 * Largest share of the checkpoint's records (by rendered size) left to the
 * extractive tail. Beyond it the checkpoint would be mostly extractive and
 * the usual method summarizes the whole range instead.
 */
export const ROLLING_MAX_UNCOVERED_SHARE = 0.5;
/** A job whose new records render smaller than this is not worth a call. */
export const ROLLING_MIN_SOURCE_TOKENS = 256;

function renderedTokens(turns: readonly ConversationTurn[], from: number, through: number): number {
  let total = 0;
  for (let index = from; index < through; index++) total += estimateTokens(renderTurnForPrompt(turns[index]!, { inCurrentMacroTurn: false }));
  return total;
}

function clipToTokens(text: string, maxTokens: number): string {
  let max = Math.floor(maxTokens * 3.6);
  let clipped = clipMiddle(text, max);
  while (max > 0 && estimateTokens(clipped) > maxTokens) {
    max = Math.floor(max * 0.9);
    clipped = clipMiddle(text, max);
  }
  return clipped;
}

/**
 * The records one background job summarizes: from `from` up to the latest
 * safe cut at or before `limit` whose rendering fits `maxTokens`. Records are
 * rendered as history (the prompt's own capped renderer), never as raw JSON.
 * When even the first complete call/result group is larger, it is taken
 * alone and cut in the middle to the cap, so a job's input stays bounded.
 * Null when no safe cut lies in `(from, limit]`.
 */
export function renderRollingSource(turns: readonly ConversationTurn[], from: number, limit: number, maxTokens: number): { text: string; through: number } | null {
  const cuts = safeCompactionCuts(turns).filter((cut) => cut > from && cut <= limit);
  const lines: string[] = [];
  let used = 0;
  let through = 0;
  let index = from;
  for (const cut of cuts) {
    const group: string[] = [];
    for (; index < cut; index++) {
      const line = renderTurnForPrompt(turns[index]!, { inCurrentMacroTurn: false });
      group.push(`Record ${index}: ${clipMiddle(line, ROLLING_RECORD_MAX_CHARS)}`);
    }
    const cost = group.reduce((sum, line) => sum + estimateTokens(line) + 1, 0);
    if (through && used + cost > maxTokens) break;
    lines.push(...group);
    used += cost;
    through = cut;
    if (used >= maxTokens) break;
  }
  if (!through) return null;
  return { text: clipToTokens(lines.join("\n"), maxTokens), through };
}

export interface RollingCheckpoint {
  summary: string;
  /** Exclusive end of the checkpoint: the planned cut, or the rolling watermark when that is later. */
  through: number;
  rolling: RollingCompactionSummary;
}

/**
 * The checkpoint made from a ready rolling summary, without a model call:
 * the rolling summary, then an extractive summary of the records between its
 * watermark and the cut. Null when there is no valid rolling summary for this
 * checkpoint, it covers under half of the checkpoint's records, or it leaves
 * too little room for the rest; the caller then makes the checkpoint as before.
 *
 * A watermark past the planned cut moves the cut to it: the planner picks the
 * earliest cut that fits, so a later one keeps a smaller fresh tail and still
 * fits. It must leave at least one record uncovered.
 */
export function compactFromRolling(state: SessionState, plan: CompactionPlan): RollingCheckpoint | null {
  const rolling = validRollingSummary(state);
  if (!rolling || rolling.from !== plan.from || rolling.coveredThrough >= state.turns.length) return null;
  const through = Math.max(plan.through, rolling.coveredThrough);
  if (renderedTokens(state.turns, rolling.coveredThrough, through) > renderedTokens(state.turns, plan.from, through) * ROLLING_MAX_UNCOVERED_SHARE) return null;
  const used = estimateTokens(rolling.summary);
  if (used > plan.summaryMaxTokens) return null;
  if (through === rolling.coveredThrough) return { summary: rolling.summary, through, rolling };
  const tailBudget = plan.summaryMaxTokens - used - 2;
  if (tailBudget < MIN_TAIL_TOKENS) return null;
  const tail = buildExtractiveSummary(state.turns, rolling.coveredThrough, through, { maxTokens: tailBudget });
  const summary = `${rolling.summary}\n\n${tail}`;
  if (estimateTokens(summary) > plan.summaryMaxTokens) return null;
  return { summary, through, rolling };
}
