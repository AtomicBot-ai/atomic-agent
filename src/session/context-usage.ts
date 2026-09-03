import type { BuiltPrompt } from "../prompt/build-prompt-types.js";

/**
 * What the last built prompt actually put in the model's context window.
 *
 * Lives in the session module (not the TUI) because the figure is a
 * property of the *session*, not of the screen that happens to render
 * it: `executeTurn` stamps the latest snapshot onto `SessionState` so a
 * session reopened tomorrow — or switched to from another thread —
 * shows its window fill immediately instead of a blank chip until the
 * next turn rebuilds a prompt.
 *
 * Every field is a snapshot of the most recent `prompt_built`, refined by
 * the completion's own token count when the provider reports one.
 */
export interface ContextUsageState {
  /**
   * Tokens in the last prompt. An estimate at `prompt_built` time
   * (`estimateTokens` over-counts by design), replaced by the real
   * tokenizer count once the step completes and the provider reports
   * `promptTokens`.
   */
  tokens: number | null;
  /**
   * Physical window the prompt was built against, when the runtime knows
   * it. `null` on cloud providers, where the model profile carries no
   * window — the chip resolves those from the model catalogue instead.
   */
  contextWindow: number | null;
  /** Turns `packConversation` dropped to make the transcript fit. */
  droppedTurns: number;
  /** Tokens the `### conversation` section actually rendered to. */
  conversationTokens: number;
  /**
   * Ceiling that section is packed to — `conversationCapEffective`. The
   * one number that says when older turns start being dropped, and the
   * only budget figure that is defined even when nobody knows the
   * physical window (the clamp falls back to the configured cap).
   */
  conversationCap: number | null;
  /**
   * The cap as configured (`agent.conversationMaxTokens`), before the
   * window clamp. Equal to `conversationCap` when config is what binds;
   * larger when the window is. That comparison is the only way to tell
   * an operator which knob actually moves their limit.
   */
  conversationCapConfigured: number | null;
  /**
   * The configured cap is `0` — auto. `conversationCapConfigured` is
   * then a fallback rather than a ceiling, so the comparison above says
   * nothing and the panel must not name `agent.conversationMaxTokens`
   * as what is holding the transcript down. Nothing is: the window is.
   */
  conversationCapAuto: boolean;
  /** Macro-turns the prompt carried. */
  conversationPairs: number;
  /** Macro-turns dropped whole. */
  droppedPairs: number;
  /** `agent.conversationMaxPairs` in force. */
  conversationPairsCap: number;
  /** Which limit trimmed history, when either did. */
  conversationBoundBy: "pairs" | "tokens" | null;
  /**
   * Token cost of each macro-turn, oldest first — enough to price a
   * different pair count without building another prompt, so moving the
   * dial redraws the gauge while the operator is looking at it.
   */
  pairCosts: readonly number[];
  /** Per-section breakdown, for the detail view. Empty before the first prompt. */
  sections: readonly ContextUsageSection[];
}

export interface ContextUsageSection {
  label: string;
  tokens: number;
}

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
 * The transcript's row label. Exported because the context panel has to
 * find that one row to recalculate it when the task count changes, and
 * matching on a literal string in two files is a bug waiting for someone
 * to reword one of them.
 */
export const CONVERSATION_SECTION_LABEL = "conversation";

/**
 * Order the sections are shown in: the fixed cost first, then the
 * transcript, then everything the memory fabric contributed, then the
 * small stuff. Not the order `BuiltPrompt.tokens` declares them in —
 * that one follows the prompt's own assembly, which is not how anyone
 * reads a bill.
 */
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
