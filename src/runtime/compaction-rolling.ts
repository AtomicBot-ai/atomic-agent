import { estimateTokens } from "../prompt/token-budget.js";
import { renderTurnForPrompt, type ConversationTurn } from "../session/conversation-turn.js";
import { safeCompactionCuts } from "../session/session-compaction.js";
import { clipMiddle } from "./compaction-extractive.js";

/** Ceiling, in estimated tokens, of the new records one background job reads. */
export const ROLLING_JOB_MAX_SOURCE_TOKENS = 12_000;
/** One record's rendered line is cut in the middle beyond this many characters. */
export const ROLLING_RECORD_MAX_CHARS = 2_000;
/**
 * Share of the planned summary size the rolling summary may use, leaving
 * the rest for the extractive summary of the records written after it.
 */
export const ROLLING_SUMMARY_SHARE = 0.6;
/** A job whose new records render smaller than this is not worth a call. */
export const ROLLING_MIN_SOURCE_TOKENS = 256;

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
