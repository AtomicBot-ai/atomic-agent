import type { BuiltPrompt } from "../prompt/build-prompt-types.js";
import {
  loadedToolsParts,
  prefixOffersToolSearch,
  stablePrefixParts,
} from "../prompt/prompt-breakdown.js";

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
  /**
   * What `prompt scaffold`, `loaded tools` and `tool schemas` are made
   * of: prefix sections, built-in tools, one row per MCP server
   * (ATO-2355; tool schemas and per-tool rows ATO-2453). The
   * parts of one parent sum to that parent's tokens. Absent on
   * snapshots saved before the field existed.
   */
  parts?: readonly ContextUsagePart[];
  /** `tool.search` was in the catalog, so tools already load on demand. */
  toolSearchActive?: boolean;
  /**
   * The reply reserve the prompt budget held back on this window
   * (`BuiltPrompt.replyReserve`, `effectiveReplyReserve` with its
   * small-window rule; the cloud prompt's `contextBudget.replyReserve`),
   * so a client draws the agent's figure instead of recomputing it
   * (ATO-2495). Absent on snapshots saved before the field existed.
   */
  replyReserve?: number;
}

export interface ContextUsageSection {
  label: string;
  tokens: number;
}

export interface ContextUsagePart extends ContextUsageSection {
  /** Label of the section row this part breaks down. */
  parent: string;
  /** Set when the part is one MCP server's tool entries. */
  mcpServer?: string;
  /**
   * That server's tools, largest first, summing to `tokens` (ATO-2453):
   * what `/context detail` and the desktop's expanded row list. Absent on
   * other parts and on snapshots saved before the field existed.
   */
  tools?: readonly ContextUsageSection[];
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
  parts: [],
  toolSearchActive: false,
};

/**
 * The transcript's row label. Exported because the context panel has to
 * find that one row to recalculate it when the task count changes, and
 * matching on a literal string in two files is a bug waiting for someone
 * to reword one of them.
 */
export const CONVERSATION_SECTION_LABEL = "conversation";

/** Rows the panel breaks down into `parts`. */
export const PROMPT_SCAFFOLD_SECTION_LABEL = "prompt scaffold";
export const LOADED_TOOLS_SECTION_LABEL = "loaded tools";
export const PROJECT_INSTRUCTIONS_SECTION_LABEL = "project instructions";
export const TOOL_SCHEMA_SECTION_LABEL = "tool schemas";
export const PROJECT_RULES_SECTION_LABEL = "project rules";

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
  { key: "stablePrefix", label: PROMPT_SCAFFOLD_SECTION_LABEL },
  { key: "conversation", label: CONVERSATION_SECTION_LABEL },
  { key: "compaction", label: "context summary" },
  // ATO-2452: the chat's project instructions (ATO-42), counted in `total`.
  { key: "project", label: PROJECT_INSTRUCTIONS_SECTION_LABEL },
  // ATO-2443: path-scoped rules a file tool attached (`.atomic-agent/rules`, Cursor `globs:`).
  { key: "projectRules", label: PROJECT_RULES_SECTION_LABEL },
  { key: "recalled", label: "recalled memory" },
  { key: "memoryIndex", label: "memory index" },
  { key: "worldSnapshot", label: "world snapshot" },
  { key: "loadedTools", label: LOADED_TOOLS_SECTION_LABEL },
  // The native `tools` payload: counted in `total`, so it gets a row,
  // or the rows would not add up to the title.
  { key: "toolSchema", label: TOOL_SCHEMA_SECTION_LABEL },
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
    const tokens = prompt.tokens[key] ?? 0;
    if (tokens > 0) sections.push({ label, tokens });
  }
  const parts: ContextUsagePart[] = [
    ...stablePrefixParts(prompt.stablePrefix, prompt.tokens.stablePrefix).map(
      (part) => ({ ...part, parent: PROMPT_SCAFFOLD_SECTION_LABEL }),
    ),
    ...loadedToolsParts(prompt.tail, prompt.tokens.loadedTools).map((part) => ({
      ...part,
      parent: LOADED_TOOLS_SECTION_LABEL,
    })),
    // The native `tools` array by MCP server (ATO-2453), measured where
    // the array is built; only while it is counted in `total`.
    ...((prompt.tokens.toolSchema ?? 0) > 0 ? prompt.toolSchemaParts ?? [] : []).map(
      (part) => ({ ...part, parent: TOOL_SCHEMA_SECTION_LABEL }),
    ),
  ];
  // A non-finite or negative figure is not a reserve: leave it out so a
  // reader falls back to its own (ATO-1678).
  const reserve = prompt.replyReserve ?? prompt.contextBudget?.replyReserve;
  const replyReserve =
    reserve !== undefined && Number.isFinite(reserve) && reserve >= 0 ? reserve : undefined;
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
    parts,
    toolSearchActive: prefixOffersToolSearch(prompt.stablePrefix),
    ...(replyReserve !== undefined ? { replyReserve } : {}),
  };
}
