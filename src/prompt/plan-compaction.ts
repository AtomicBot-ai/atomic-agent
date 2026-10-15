import type { SessionState } from "../session/session-state.js";
import type { CompactionConfig } from "../config/agent/compaction-config.js";
import { compactionPins, projectSessionConversation, renderCompactionContext, safeCompactionCuts, type CompactionReason } from "../session/session-compaction.js";
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
 * compaction further away. A lower configured `targetRatio` still wins.
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

export function planCompaction(state: SessionState, prompt: BuiltPrompt, config: CompactionConfig, requested?: "manual" | "overflow", model: { prefixReuse?: PrefixReuse } = {}): CompactionPlan | null {
  const budget = prompt.compactionBudget;
  if (!budget || state.turns.length < 2) return null;
  const reason = requested ?? (budget.activePairs > prompt.conversationPairsCap ? "pairs" : "threshold");
  if (!requested && (!config.auto || (reason !== "pairs" && budget.activeTokens < budget.cap * config.triggerRatio))) return null;
  const projection = projectSessionConversation(state);
  const targetRatio = model.prefixReuse === "none" ? Math.min(config.targetRatio, NO_PREFIX_REUSE_TARGET_RATIO) : config.targetRatio;
  const targetTokens = Math.floor(targetRatio * (requested === "manual" ? Math.min(budget.cap, budget.activeTokens) : budget.cap));
  const summaryMaxTokens = Math.min(config.summaryMaxTokens, Math.floor(budget.cap * 0.2), Math.floor(targetTokens * 0.5));
  if (summaryMaxTokens < 64) return null;
  if (prompt.cloudContext) {
    for (const through of safeCompactionCuts(state.turns)) {
      if (through <= projection.offset || through >= state.turns.length) continue;
      const entries = cloudContextEntries(prompt.cloudContext, through);
      const tokens = estimateTokens(entries.map((entry) => renderCloudTurn(entry.turn)).join("\n")) + entries.length * 12;
      const pins = estimateTokens(renderCompactionContext("", compactionPins(state, through)));
      if (tokens + pins + summaryMaxTokens + 12 > targetTokens) continue;
      return { reason, from: projection.offset, through, summaryMaxTokens, targetTokens, tokensBefore: budget.activeTokens };
    }
    return null;
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
  // Earliest conservatively fitting safe cut, keeping the newest complete unit.
  for (const through of safeCompactionCuts(state.turns)) {
    if (through <= projection.offset || through >= state.turns.length) continue;
    if (suffixCosts[through]! + summaryMaxTokens > targetTokens) continue;
    const tail = state.turns.slice(through);
    const tailTokens = estimateTokens(renderPackedConversation({ visibleTurns: tail, droppedSummary: null }));
    const overhead = estimateTokens(renderCompactionContext("", compactionPins(state, through)));
    const pairs = 1 + boundaries.filter((i) => i > through).length;
    if (reason === "pairs" && pairs > pairsTarget) continue;
    if (tailTokens + overhead + summaryMaxTokens > targetTokens) continue;
    return { reason, from: projection.offset, through, summaryMaxTokens, targetTokens, tokensBefore: budget.activeTokens };
  }
  return null;
}
