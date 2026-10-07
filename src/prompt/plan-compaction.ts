import type { SessionState } from "../session/session-state.js";
import type { CompactionConfig } from "../config/agent/compaction-config.js";
import { compactionPins, projectSessionConversation, renderCompactionContext, safeCompactionCuts, type CompactionReason } from "../session/session-compaction.js";
import { findCurrentMacroTurnStart, macroTurnBoundaries, renderTurnForPrompt } from "../session/conversation-turn.js";
import { renderPackedConversation } from "./build-prompt-world-conversation.js";
import type { BuiltPrompt } from "./build-prompt-types.js";
import { estimateTokens } from "./token-budget.js";

export interface CompactionPlan {
  reason: CompactionReason;
  from: number;
  through: number;
  summaryMaxTokens: number;
  targetTokens: number;
  tokensBefore: number;
}

export function planCompaction(state: SessionState, prompt: BuiltPrompt, config: CompactionConfig, requested?: "manual" | "overflow"): CompactionPlan | null {
  const budget = prompt.compactionBudget;
  if (!budget || state.turns.length < 2) return null;
  const reason = requested ?? (budget.activePairs > prompt.conversationPairsCap ? "pairs" : "threshold");
  if (!requested && (!config.auto || (reason !== "pairs" && budget.activeTokens < budget.cap * config.triggerRatio))) return null;
  const projection = projectSessionConversation(state);
  const targetTokens = Math.floor(config.targetRatio * (requested === "manual" ? Math.min(budget.cap, budget.activeTokens) : budget.cap));
  const summaryMaxTokens = Math.min(config.summaryMaxTokens, Math.floor(budget.cap * 0.2), Math.floor(targetTokens * 0.5));
  if (summaryMaxTokens < 64) return null;
  const boundaries = macroTurnBoundaries(state.turns, state.macroTurnStarts);
  const pairsTarget = Math.max(1, Math.floor(prompt.conversationPairsCap * config.targetRatio));
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
