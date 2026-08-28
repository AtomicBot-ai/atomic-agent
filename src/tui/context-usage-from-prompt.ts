import type { BuiltPrompt } from "../prompt/build-prompt-types.js";
import type { ContextUsageSection, ContextUsageState } from "./tui-state.js";

/** A window nothing has been built against yet. */
export const EMPTY_CONTEXT_USAGE: ContextUsageState = {
  tokens: null,
  contextWindow: null,
  droppedTurns: 0,
  conversationTokens: 0,
  conversationCap: null,
  conversationCapConfigured: null,
  conversationCapAuto: false,
  conversationPairs: 0,
  droppedPairs: 0,
  conversationPairsCap: 0,
  conversationBoundBy: null,
  pairCosts: [],
  sections: [],
};

/**
 * Order the sections are shown in: the fixed cost first, then the
 * transcript, then everything the memory fabric contributed, then the
 * small stuff. Not the order `BuiltPrompt.tokens` declares them in —
 * that one follows the prompt's own assembly, which is not how anyone
 * reads a bill.
 */
/**
 * The transcript's row label. Exported because the context panel has to
 * find that one row to recalculate it when the task count changes, and
 * matching on a literal string in two files is a bug waiting for someone
 * to reword one of them.
 */
export const CONVERSATION_SECTION_LABEL = "conversation";

const SECTIONS: readonly {
  key: keyof BuiltPrompt["tokens"];
  label: string;
}[] = [
  { key: "stablePrefix", label: "prompt scaffold" },
  { key: "conversation", label: CONVERSATION_SECTION_LABEL },
  { key: "recalled", label: "recalled memory" },
  { key: "memoryIndex", label: "memory index" },
  { key: "worldSnapshot", label: "world snapshot" },
  { key: "loadedTools", label: "loaded tools" },
  { key: "loadedSkills", label: "loaded skills" },
  { key: "sessionFacts", label: "session facts" },
  { key: "profile", label: "profile" },
  { key: "taskPolicy", label: "task policy" },
];

/**
 * Project a built prompt into the readout the composer shows.
 *
 * Sections that cost nothing are dropped rather than listed as zeros: a
 * session with no skills loaded should not have to read the word
 * "skills" to find that out.
 */
export function contextUsageFromPrompt(prompt: BuiltPrompt): ContextUsageState {
  const sections: ContextUsageSection[] = [];
  for (const { key, label } of SECTIONS) {
    const tokens = prompt.tokens[key];
    if (tokens > 0) sections.push({ label, tokens });
  }
  return {
    tokens: prompt.tokens.total,
    contextWindow: prompt.contextWindow,
    droppedTurns: prompt.droppedTurns,
    conversationTokens: prompt.tokens.conversation,
    conversationCap: prompt.conversationCapEffective,
    conversationCapConfigured: prompt.limits.conversation,
    conversationCapAuto: prompt.conversationCapAuto,
    conversationPairs: prompt.conversationPairs,
    droppedPairs: prompt.droppedPairs,
    conversationPairsCap: prompt.conversationPairsCap,
    conversationBoundBy: prompt.conversationBoundBy,
    pairCosts: prompt.pairCosts,
    sections,
  };
}
