import { estimateTokens } from "../../prompt/token-budget.js";
import { MIN_USEFUL_SUMMARY_TOKENS } from "../../prompt/plan-compaction.js";
import { buildExtractiveSummary, clipMiddle } from "../../runtime/compaction-extractive.js";
import type { ConversationTurn } from "../../session/conversation-turn.js";
import {
  compactionBoundaryHash,
  finishedTurnCompactionCuts,
  safeCompactionCuts,
} from "../../session/session-compaction.js";
import type { SessionState } from "../../session/session-state.js";

/**
 * Fit a handed-off transcript into a local model's window (ATO-1155).
 *
 * A Claude Code session that ran into its usage limit is often far
 * larger than a local model's window (200k tokens of history against a
 * 32k window). Left as is, the first turn would spend minutes asking the
 * local model to summarise it, or overflow. So the handoff writes the
 * checkpoint itself, without a model, before the chat is saved:
 *
 *  - the newest records stay verbatim, as many as fit `tailShare` of the
 *    history budget, cut at a safe boundary (never between a call and
 *    its result; a finished turn is preferred);
 *  - everything before them becomes an extractive summary — the same
 *    builder the runtime uses when a model summary is not available —
 *    stored as a normal `SessionCompaction`, so the prompt shows it with
 *    the original request and the latest user message pinned verbatim;
 *  - very long tool outputs in the kept tail are clipped in the middle.
 *
 * The transcript itself is not rewritten (only the tail's long outputs
 * are clipped), so the full history stays in the chat and the runtime's
 * own compaction takes over from this checkpoint later.
 */

/** Share of the window the carried history may take; the rest is the system prompt, tools and the reply. */
export const HANDOFF_HISTORY_SHARE = 0.5;
/** Share of the history budget kept verbatim; the rest is the summary. */
export const HANDOFF_TAIL_SHARE = 0.65;
/** A tool output in the kept tail longer than this is clipped in the middle. */
export const HANDOFF_TAIL_RESULT_MAX_CHARS = 6_000;
/** Window assumed when nothing better is known: the smallest auto context a managed local model gets. */
export const HANDOFF_DEFAULT_WINDOW = 32_768;

/** Ceiling for a pinned window: "the model's maximum" (1M) is clamped to the trained context we cannot see here. */
export const HANDOFF_MAX_WINDOW = 131_072;

/**
 * The window to fit when `--context` is not given: the managed local
 * model's pinned `contextSize`, else the smallest auto context.
 */
export function defaultHandoffWindow(managedContextSize: number): number {
  if (!Number.isFinite(managedContextSize) || managedContextSize <= 0) return HANDOFF_DEFAULT_WINDOW;
  return Math.min(Math.floor(managedContextSize), HANDOFF_MAX_WINDOW);
}

export interface FitContextOptions {
  /** The target model's context window, tokens. */
  windowTokens: number;
  now?: number;
}

export interface FitContextResult {
  session: SessionState;
  /** False when the history already fit (or could not be cut safely). */
  compacted: boolean;
  tokensBefore: number;
  tokensAfter: number;
  /** Records summarised (`coveredThrough`), 0 when not compacted. */
  summarizedTurns: number;
  /** Tool outputs clipped in the kept tail. */
  clippedResults: number;
  /** Why it was left as is, when it was. */
  skipped?: "fits" | "no_safe_cut" | "no_window";
}

/** Rough prompt cost of one record, the way the conversation section renders it. */
export function turnTokens(turn: ConversationTurn): number {
  switch (turn.kind) {
    case "user":
      return estimateTokens(turn.text) + 4;
    case "assistant_reply":
      return estimateTokens(turn.text) + 4;
    case "assistant_tool_call":
      return estimateTokens(`${turn.tool} ${JSON.stringify(turn.args)}`) + 8;
    case "tool_result":
      return estimateTokens(turn.summary) + 8;
  }
}

export function fitHandoffContext(
  session: SessionState,
  options: FitContextOptions,
): FitContextResult {
  const turns = session.turns;
  const costs = turns.map(turnTokens);
  const tokensBefore = sum(costs, 0);
  const unchanged = (skipped: FitContextResult["skipped"]): FitContextResult => ({
    session,
    compacted: false,
    tokensBefore,
    tokensAfter: tokensBefore,
    summarizedTurns: 0,
    clippedResults: 0,
    skipped,
  });

  if (!Number.isFinite(options.windowTokens) || options.windowTokens <= 0) {
    return unchanged("no_window");
  }
  const historyBudget = Math.floor(options.windowTokens * HANDOFF_HISTORY_SHARE);
  if (tokensBefore <= historyBudget) return unchanged("fits");

  const tailBudget = Math.floor(historyBudget * HANDOFF_TAIL_SHARE);
  const summaryBudget = Math.max(MIN_USEFUL_SUMMARY_TOKENS, historyBudget - tailBudget);

  const cut = chooseCut(turns, costs, tailBudget);
  if (cut === null) return unchanged("no_safe_cut");

  // Clip only the kept tail; covered records live on in the summary and
  // the boundary hash is taken from the record before the cut.
  let clippedResults = 0;
  const nextTurns = turns.map((turn, index) => {
    if (index < cut || turn.kind !== "tool_result") return turn;
    if (turn.summary.length <= HANDOFF_TAIL_RESULT_MAX_CHARS) return turn;
    clippedResults += 1;
    return { ...turn, summary: clipMiddle(turn.summary, HANDOFF_TAIL_RESULT_MAX_CHARS), truncated: true as const };
  });

  const summary = buildExtractiveSummary(nextTurns, 0, cut, { maxTokens: summaryBudget });
  const tokensAfter = estimateTokens(summary) + sum(nextTurns.slice(cut).map(turnTokens), 0);

  const next: SessionState = {
    ...session,
    turns: nextTurns,
    compaction: {
      version: 1,
      summary,
      coveredThrough: cut,
      boundaryHash: compactionBoundaryHash(nextTurns[cut - 1]!),
      createdAt: options.now ?? Date.now(),
      reason: "threshold",
      model: null,
      kind: "extractive",
      tokensBefore,
      tokensAfter,
    },
  };
  // A fresh checkpoint supersedes any mechanical cut or rolling summary.
  delete next.conversationPackStart;
  delete next.rollingSummary;
  delete next.compactionWarning;

  return {
    session: next,
    compacted: true,
    tokensBefore,
    tokensAfter,
    summarizedTurns: cut,
    clippedResults,
  };
}

/**
 * The earliest safe cut whose tail fits `tailBudget` — finished-turn
 * cuts first, then any safe cut. When no tail fits, the latest safe cut
 * (the smallest tail there is). `null` when there is no safe cut past 0.
 */
function chooseCut(
  turns: readonly ConversationTurn[],
  costs: readonly number[],
  tailBudget: number,
): number | null {
  const tailFrom = (cut: number) => sum(costs, cut);
  const fits = (cut: number) => cut > 0 && tailFrom(cut) <= tailBudget;
  const finished = finishedTurnCompactionCuts(turns).find(fits);
  if (finished !== undefined) return finished;
  const safe = safeCompactionCuts(turns).filter((c) => c > 0);
  const any = safe.find(fits);
  if (any !== undefined) return any;
  return safe.length > 0 ? safe[safe.length - 1]! : null;
}

function sum(values: readonly number[], from: number): number {
  let total = 0;
  for (let i = from; i < values.length; i += 1) total += values[i]!;
  return total;
}
