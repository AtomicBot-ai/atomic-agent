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
  tokenBudget?: number;
  conversationMaxTokens?: number;
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
  droppedTurns: number;
}
