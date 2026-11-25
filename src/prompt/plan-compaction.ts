import type { SessionState } from "../session/session-state.js";
import type { CompactionConfig } from "../config/agent/compaction-config.js";
import { compactionPins, preferredCompactionCuts, projectSessionConversation, renderCompactionContext, type CompactionReason } from "../session/session-compaction.js";
import { findCurrentMacroTurnStart, macroTurnBoundaries, renderTurnForPrompt } from "../session/conversation-turn.js";
import { renderPackedConversation } from "./build-prompt-world-conversation.js";
import type { BuiltPrompt } from "./build-prompt-types.js";
import { estimateTokens } from "./token-budget.js";
import { cloudContextEntries, renderCloudTurn } from "../session/cloud-context.js";
import type { PrefixReuse } from "../llm/model-profile.js";

/**
 * Target share of the history allowance after compaction on a model without
 * prefix reuse. Every step after a cut re-reads the whole prompt there, so a
 * smaller kept tail makes each of those re-reads cheaper and the next
 * compaction further away. A lower configured `targetRatio` still wins, and
 * when no cut fits this share the configured one is tried (see
 * {@link decideCompaction}).
 */
export const NO_PREFIX_REUSE_TARGET_RATIO = 0.35;

export interface CompactionPlan {
  reason: CompactionReason;
  from: number;
  through: number;
  summaryMaxTokens: number;
  targetTokens: number;
  tokensBefore: number;
}

/**
 * Smallest summary reserve the history allowance can give before a manual
 * compaction is pointless. On a small window (a 16k local model leaves about 100 tokens)
 * a model summary cannot fit and every attempt failed after a model call.
 */
export const MIN_USEFUL_SUMMARY_TOKENS = 128;

/**
 * Summary reserve a plan gets whenever half its target can hold it, even
 * where 20% of the history allowance is less. On a mid-size allowance
 * (roughly 1k to 2.5k tokens) the 20% share alone gave a summary too
 * short to carry the goal, constraints and next step, so the model's
 * reply came back oversized or truncated. The configured maximum still
 * wins when it is lower.
 */
export const MIN_SUMMARY_RESERVE_TOKENS = 512;

/**
 * The summary reserve a history allowance `cap` gives for a kept-tail
 * target `target`: 20% of the allowance and half the target, raised to
 * {@link MIN_SUMMARY_RESERVE_TOKENS} when half the target holds that.
 */
export function summaryReserve(cap: number, target: number): number {
  const half = Math.floor(target * 0.5);
  const share = Math.min(Math.floor(cap * 0.2), half);
  return half >= MIN_SUMMARY_RESERVE_TOKENS ? Math.max(MIN_SUMMARY_RESERVE_TOKENS, share) : share;
}

/**
 * A manual request is skipped when the summary reserve is bound by the small
 * current history (not by the window or the configured maximum) and the saved
 * checkpoint summary already takes this share of it. A repeated `/compact`
 * with little added since targets a share of an already compacted history,
 * so the new summary would have to be about as large as the one it replaces
 * and the model call could only fail.
 */
export const ALREADY_COMPACT_SUMMARY_SHARE = 0.75;

/**
 * Why no plan was made when compaction was due or requested:
 * `window_too_small` (no useful summary fits the model's history allowance:
 * a manual request stops before any cut is tried, an automatic or overflow
 * one only after no cut fitted, so its extractive fallback still runs where
 * a cut fits),
 * `already_compact` (a repeated manual request with nothing worth
 * summarizing again), `no_reduction` (no safe cut keeps a fresh tail within
 * the target).
 */
export type CompactionSkip = "window_too_small" | "already_compact" | "no_reduction";

/** A plan, or no plan with the reason when compaction was due or requested. */
export type CompactionDecision = { plan: CompactionPlan; skip?: undefined } | { plan: null; skip?: CompactionSkip };

/**
 * Share of the automatic trigger, below and above, inside which the
 * heuristic's margin can decide whether compaction is due, so an exact
 * count is worth asking for (ATO-656). Below the low end even a 20%
 * under-count stays under the trigger; above the high end even a 20%
 * over-count is past it.
 */
export const EXACT_COUNT_TRIGGER_BAND = { low: 0.8, high: 1.25 } as const;

/**
 * What the decision knows about the model: its prefix reuse, and the
 * history's exact size in tokens when a counter measured
 * {@link exactCountCandidate}'s text. The measured size replaces the
 * heuristic one for the automatic trigger only; cut fitting stays on the
 * conservative heuristic.
 */
export interface CompactionDecisionModel {
  prefixReuse?: PrefixReuse;
  measuredActiveTokens?: number;
}

/**
 * The history text whose exact size settles an automatic threshold
 * decision, or `null` when the heuristic alone settles it: compaction was
 * requested, automatic compaction is off, the pair cap is what is due,
 * the prompt is a cloud context (its history is counted differently), or
 * the estimate is outside {@link EXACT_COUNT_TRIGGER_BAND}. The text is
 * what `buildPrompt` prices as `compactionBudget.activeTokens`: the saved
 * summary and the packed visible conversation.
 */
export function exactCountCandidate(state: SessionState, prompt: BuiltPrompt, config: CompactionConfig, requested?: "manual" | "overflow"): string | null {
  const budget = prompt.compactionBudget;
  if (requested || !config.auto || !budget || state.turns.length < 2 || prompt.cloudContext) return null;
  if (budget.activePairs > prompt.conversationPairsCap) return null;
  const trigger = budget.cap * config.triggerRatio;
  if (!(trigger > 0)) return null;
  if (budget.activeTokens < trigger * EXACT_COUNT_TRIGGER_BAND.low || budget.activeTokens > trigger * EXACT_COUNT_TRIGGER_BAND.high) return null;
  const projection = projectSessionConversation(state);
  const conversation = renderPackedConversation({ visibleTurns: projection.turns, droppedSummary: null });
  return [projection.summary, conversation].filter(Boolean).join("\n");
}

export function planCompaction(state: SessionState, prompt: BuiltPrompt, config: CompactionConfig, requested?: "manual" | "overflow", model: CompactionDecisionModel = {}): CompactionPlan | null {
  return decideCompaction(state, prompt, config, requested, model).plan;
}

export function decideCompaction(state: SessionState, prompt: BuiltPrompt, config: CompactionConfig, requested?: "manual" | "overflow", model: CompactionDecisionModel = {}): CompactionDecision {
  const reduced = model.prefixReuse === "none" && NO_PREFIX_REUSE_TARGET_RATIO < config.targetRatio;
  const measured = model.measuredActiveTokens;
  const decision = decideAtRatio(state, prompt, config, requested, reduced ? NO_PREFIX_REUSE_TARGET_RATIO : config.targetRatio, measured);
  // The smaller tail is a preference, not a requirement. On a small window
  // (a 16k model leaves about 3k of history) 35% of the allowance minus the
  // summary reserve is about 500 tokens, less than one tool step, so no cut
  // fitted, nothing was compacted and trimming dropped turns instead. The
  // configured target is still tried before giving up.
  if (reduced && decision.plan === null && decision.skip !== undefined && decision.skip !== "already_compact") {
    const wider = decideAtRatio(state, prompt, config, requested, config.targetRatio, measured);
    if (wider.plan) return wider;
  }
  return decision;
}

function decideAtRatio(state: SessionState, prompt: BuiltPrompt, config: CompactionConfig, requested: "manual" | "overflow" | undefined, targetRatio: number, measured?: number): CompactionDecision {
  const budget = prompt.compactionBudget;
  if (!budget || state.turns.length < 2) return { plan: null };
  const reason = requested ?? (budget.activePairs > prompt.conversationPairsCap ? "pairs" : "threshold");
  // The exact size, when measured, decides whether the threshold is reached.
  const triggerTokens = measured !== undefined && Number.isFinite(measured) && measured >= 0 ? measured : budget.activeTokens;
  if (!requested && (!config.auto || (reason !== "pairs" && triggerTokens < budget.cap * config.triggerRatio))) return { plan: null };
  const projection = projectSessionConversation(state);
  const targetTokens = Math.floor(targetRatio * (requested === "manual" ? Math.min(budget.cap, budget.activeTokens) : budget.cap));
  const summaryMaxTokens = Math.min(config.summaryMaxTokens, summaryReserve(budget.cap, targetTokens));
  // The window's own room, independent of the configured maximum and of how much history there is now.
  const windowTooSmall = summaryReserve(budget.cap, Math.floor(targetRatio * budget.cap)) < MIN_USEFUL_SUMMARY_TOKENS;
  // Manual stops here: automatic and overflow compaction keep their extractive
  // fallback, which needs no model call and can still free room on a small window,
  // and say the window is too small only when no cut fits either.
  if (requested === "manual" && windowTooSmall) return { plan: null, skip: "window_too_small" };
  const nothingFits: CompactionDecision = { plan: null, skip: windowTooSmall ? "window_too_small" : "no_reduction" };
  if (requested === "manual" && projection.checkpoint && Math.floor(targetTokens * 0.5) < Math.min(config.summaryMaxTokens, Math.floor(budget.cap * 0.2)) &&
      estimateTokens(projection.checkpoint.summary) >= summaryMaxTokens * ALREADY_COMPACT_SUMMARY_SHARE) return { plan: null, skip: "already_compact" };
  if (summaryMaxTokens < 64) return nothingFits;
  // Finished-turn cuts first, so a request stays with its answer; then cuts inside a turn.
  const cuts = preferredCompactionCuts(state.turns);
  if (prompt.cloudContext) {
    for (const through of cuts) {
      if (through <= projection.offset || through >= state.turns.length) continue;
      const entries = cloudContextEntries(prompt.cloudContext, through);
      const tokens = estimateTokens(entries.map((entry) => renderCloudTurn(entry.turn)).join("\n")) + entries.length * 12;
      const pins = estimateTokens(renderCompactionContext("", compactionPins(state, through)));
      if (tokens + pins + summaryMaxTokens + 12 > targetTokens) continue;
      return { plan: { reason, from: projection.offset, through, summaryMaxTokens, targetTokens, tokensBefore: budget.activeTokens } };
    }
    return nothingFits;
  }
  const boundaries = macroTurnBoundaries(state.turns, state.macroTurnStarts);
  const pairsTarget = Math.max(1, Math.floor(prompt.conversationPairsCap * targetRatio));
  // Conservative suffix costs avoid rendering the entire remaining transcript
  // for every candidate (quadratic on a long, tool-heavy task). Repeated reads
  // may render smaller; the exact shared renderer validates the chosen tail.
  const currentStart = findCurrentMacroTurnStart(state.turns);
  const suffixCosts = new Array<number>(state.turns.length + 1).fill(0);
  for (let i = state.turns.length - 1; i >= projection.offset; i--) {
    suffixCosts[i] = suffixCosts[i + 1]! + estimateTokens(renderTurnForPrompt(state.turns[i]!, { inCurrentMacroTurn: i >= currentStart })) + 1;
  }
  // Earliest conservatively fitting cut of each kind, keeping the newest complete unit.
  for (const through of cuts) {
    if (through <= projection.offset || through >= state.turns.length) continue;
    if (suffixCosts[through]! + summaryMaxTokens > targetTokens) continue;
    const tail = state.turns.slice(through);
    const tailTokens = estimateTokens(renderPackedConversation({ visibleTurns: tail, droppedSummary: null }));
    const overhead = estimateTokens(renderCompactionContext("", compactionPins(state, through)));
    const pairs = 1 + boundaries.filter((i) => i > through).length;
    if (reason === "pairs" && pairs > pairsTarget) continue;
    if (tailTokens + overhead + summaryMaxTokens > targetTokens) continue;
    return { plan: { reason, from: projection.offset, through, summaryMaxTokens, targetTokens, tokensBefore: budget.activeTokens } };
  }
  return nothingFits;
}
