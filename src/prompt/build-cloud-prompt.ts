import { getConfig } from "../config/index.js";
import { getReasoningTurnFraming } from "../llm/model-profile.js";
import { thinkingDisabledOnBuiltPrompt } from "../llm/server-template-policy.js";
import { extendCloudContext, cloudContextEntries, renderCloudTurn } from "../session/cloud-context.js";
import { projectSessionConversation } from "../session/session-compaction.js";
import { macroTurnBoundaries } from "../session/conversation-turn.js";
import type { BuildPromptInput, BuiltPrompt } from "./build-prompt-types.js";
import { cloudContextSections } from "./cloud-context-sections.js";
import { defaultBudget, estimateTokens } from "./token-budget.js";

/** Separate cloud projection: local allocation/rendering is deliberately untouched. */
export function buildCloudPrompt(input: BuildPromptInput, stablePrefix: string): BuiltPrompt {
  const config = getConfig();
  const sections = cloudContextSections(input);
  const cloudContext = extendCloudContext(input.session.cloudContext, input.session.turns, sections);
  const projection = projectSessionConversation(input.session);
  const entries = cloudContextEntries(cloudContext, projection.offset);
  const conversation = entries.map((entry) => renderCloudTurn(entry.turn)).join("\n");
  const parts = [
    ...(projection.summary ? ["### context-summary", projection.summary, ""] : []),
    "### conversation", conversation, "",
  ];
  const suppressPrefill = input.suppressReasoningPrefill === true;
  const framing = input.profile && !suppressPrefill ? getReasoningTurnFraming(input.profile) : undefined;
  if (framing) parts.push(framing.turnClose.trimEnd(), framing.assistantOpen.trimEnd(), "");
  else if (!suppressPrefill && input.profile?.requiresPromptThinkPrefix && input.profile.reasoningStyle !== "none") {
    parts.push(thinkingDisabledOnBuiltPrompt(input.thinking ?? config.localModels.thinking, input.profile)
      ? input.profile.promptThinkingDisabledMarker?.trimEnd() ?? input.profile.reasoningOpenTag.trimEnd()
      : input.profile.reasoningOpenTag.trimEnd(), "");
  }
  const tail = parts.join("\n");
  const text = `${stablePrefix}\n${tail}`;
  const window = (input.profileWindowApplies ?? true) ? input.profile?.contextWindow ?? input.contextWindow ?? null : input.contextWindow ?? null;
  const replyReserve = input.completionMaxTokens ?? config.localModels.completionMaxTokens;
  const schemaTokens = input.toolSchemaTokens ?? 0;
  const historyTokens = estimateTokens(conversation) + entries.length * 12;
  const summaryTokens = projection.summary ? estimateTokens(projection.summary) + 12 : 0;
  const fixedTokens = estimateTokens(stablePrefix) + schemaTokens + 32;
  const cap = window === null ? Number.MAX_SAFE_INTEGER : Math.max(0, window - fixedTokens - replyReserve - 1024);
  const boundaries = macroTurnBoundaries(input.session.turns, input.session.macroTurnStarts).filter((i) => i >= projection.offset);
  const costs = new Array<number>(Math.max(1, boundaries.length)).fill(0);
  for (const entry of entries) {
    let pair = 0;
    for (let i = 0; i < boundaries.length; i++) if (boundaries[i]! < entry.through) pair = i;
    costs[pair] = (costs[pair] ?? 0) + estimateTokens(renderCloudTurn(entry.turn)) + 12;
  }
  const sectionTokens = (key: string) => estimateTokens(sections.get(key) ?? "");
  const prefixTokens = (prefix: string) => [...sections].reduce((n, [key, body]) => n + (key.startsWith(prefix) ? estimateTokens(body) : 0), 0);
  const total = estimateTokens(text) + schemaTokens + entries.length * 12 + 32;
  return {
    text, stablePrefix, tail, cloudContext, modelMode: input.modelMode,
    messages: { system: stablePrefix, turns: entries.map((entry) => entry.turn), tail: "", droppedSummary: null,
      ...(projection.summary ? { contextSummary: projection.summary } : {}) },
    tokens: { stablePrefix: estimateTokens(stablePrefix), loadedSkills: prefixTokens("skill:"),
      loadedTools: prefixTokens("tool:"), sessionFacts: sectionTokens("session-facts"),
      profile: sectionTokens("profile"), worldSnapshot: sectionTokens("world"),
      recalled: sectionTokens("recalled"), memoryIndex: sectionTokens("memory-index"),
      taskPolicy: sectionTokens("task-policy"), conversation: historyTokens, compaction: summaryTokens, total },
    limits: defaultBudget(window ?? Number.MAX_SAFE_INTEGER, { conversation: cap, session: cap, worldSnapshot: cap }),
    truncated: false,
    truncation: { loadedSkills: false, sessionFacts: false, loadedTools: false, profile: false,
      worldSnapshot: false, conversation: false, recalled: false, memoryIndex: false },
    contextWindow: window, conversationCapEffective: cap, conversationCapAuto: true,
    droppedTurns: 0, droppedPairs: 0, conversationPairs: costs.length,
    conversationPairsCap: Number.MAX_SAFE_INTEGER, conversationBoundBy: null, conversationPackStart: null,
    compactionBudget: { cap, activeTokens: historyTokens + summaryTokens, activePairs: costs.length }, pairCosts: costs,
    contextBudget: { window, replyReserve },
  };
}
