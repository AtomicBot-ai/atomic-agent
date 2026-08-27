import type { ModelProfile } from "../llm/model-profile.js";
import type { ProfileFact } from "../memory/profile-store.js";
import type { SessionState } from "../session/session-state.js";
import type {
  CapabilitiesSummary,
  SkillCatalogEntry,
  ToolDescriptor,
} from "./stable-prefix.js";
import type { TokenBudgetLimits } from "./token-budget.js";

export interface BuildPromptInput {
  session: SessionState;
  toolDescriptors: readonly ToolDescriptor[];
  capabilities: CapabilitiesSummary;
  skillCatalog: readonly SkillCatalogEntry[];
  systemPersona?: string;
  /**
   * Pre-formatted current date (see `formatCurrentDate`) rendered as a
   * `CURRENT DATE:` line in the variable tail just before `### respond`.
   * Lives in the tail, not the stable prefix, so it never affects
   * KV-cache reuse. When omitted the line is not rendered.
   */
  currentDate?: string;
  tokenBudget?: number;
  conversationMaxTokens?: number;
  /** Overrides `agent.conversationMaxPairs` for this build. */
  conversationMaxPairs?: number;
  /**
   * The model's context window, when something other than the profile
   * probe knows it.
   *
   * `profile.contextWindow` is filled only by the llama-server `/props`
   * probe, so on a cloud model the budget had no window at all and every
   * window-relative decision — the auto cap especially — silently fell
   * back to a fixed number. The provider catalogue does know, and this
   * is how that reaches the budget. Kept separate from `profile` so the
   * UI can still tell a probed window from a catalogued one.
   */
  contextWindow?: number | null;
  worldSnapshotMaxTokens?: number;
  completionMaxTokens?: number;
  transientNotice?: string;
  profile?: ModelProfile;
  profileFacts?: readonly ProfileFact[];
  profileMaxTokens?: number;
  userMessage?: string | null;
  contextualKeywordGate?: boolean;
  recallPreviewChars?: number;
  recallMaxTokens?: number;
  memoryIndexMaxTokens?: number;
  /**
   * Memory-v2 phase 5. Safety cap for the `### lessons` pointer
   * section. Defaults to `config.memory.lessons.maxTokens` (300).
   */
  lessonsMaxTokens?: number;
  /**
   * Memory-v2 phase 7b. Safety cap for the `### procedures` pointer
   * section. Defaults to `config.memory.procedures.maxTokens` (400).
   */
  proceduresMaxTokens?: number;
  /** Safety cap for `### loaded-tools` (defaults to `agent.loadedToolsMaxTokens`). */
  loadedToolsMaxTokens?: number;
}

export interface BuiltPromptTruncationFlags {
  loadedSkills: boolean;
  sessionFacts: boolean;
  loadedTools: boolean;
  profile: boolean;
  worldSnapshot: boolean;
  conversation: boolean;
  recalled: boolean;
  memoryIndex: boolean;
}

export interface BuiltPrompt {
  text: string;
  stablePrefix: string;
  tail: string;
  tokens: {
    stablePrefix: number;
    loadedSkills: number;
    sessionFacts: number;
    loadedTools: number;
    profile: number;
    worldSnapshot: number;
    conversation: number;
    recalled: number;
    memoryIndex: number;
    taskPolicy: number;
    total: number;
  };
  limits: TokenBudgetLimits;
  truncated: boolean;
  truncation: BuiltPromptTruncationFlags;
  contextWindow: number | null;
  conversationCapEffective: number;
  /**
   * `agent.conversationMaxTokens` was left at `0` — the transcript takes
   * whatever the window leaves rather than sitting under a fixed
   * ceiling. Reported rather than inferred: under auto the configured
   * figure in `limits.conversation` is a *fallback* for an unknown
   * window, not a ceiling, and comparing it against
   * `conversationCapEffective` — which is how the UI decides what is
   * holding the transcript down — would name the wrong knob.
   */
  conversationCapAuto: boolean;
  droppedTurns: number;
  /** Macro-turns the prompt carries. */
  conversationPairs: number;
  /** Macro-turns dropped whole. */
  droppedPairs: number;
  /** The cap in force, i.e. `agent.conversationMaxPairs`. */
  conversationPairsCap: number;
  /** Which limit made the cut, when history was trimmed at all. */
  conversationBoundBy: "pairs" | "tokens" | null;
  /**
   * Token cost of each macro-turn, oldest first.
   *
   * Published so the context panel can answer "what would N tasks cost?"
   * with a prefix sum instead of waiting for the next prompt build —
   * lowering the pair count has to move the gauge while the operator is
   * looking at it, not one turn later. Per-turn costs are already
   * memoised, so this is close to free.
   */
  pairCosts: number[];
}
