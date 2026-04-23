import { getConfig } from "../config/index.js";
import type { ModelProfile } from "../llm/model-profile.js";
import type { ProfileFact } from "../memory/profile-store.js";
import { renderProfileSection } from "../memory/profile-renderer.js";
import type { SessionState } from "../session/session-state.js";
import {
  packConversation,
  renderTurnForPrompt,
} from "../session/conversation-turn.js";
import { buildStablePrefix } from "./stable-prefix.js";
import type {
  CapabilitiesSummary,
  SkillCatalogEntry,
  ToolDescriptor,
} from "./stable-prefix.js";
import {
  checkBudget,
  computeEffectiveConversationCap,
  defaultBudget,
  estimateTokens,
  truncateToTokens,
} from "./token-budget.js";
import type { TokenBudgetLimits } from "./token-budget.js";

export interface BuildPromptInput {
  session: SessionState;
  toolDescriptors: readonly ToolDescriptor[];
  capabilities: CapabilitiesSummary;
  skillCatalog: readonly SkillCatalogEntry[];
  systemPersona?: string;
  tokenBudget?: number;
  /**
   * Safety-net ceiling for the `### conversation` section. Defaults to
   * `agent.conversationMaxTokens`. Acts as an upper bound that is then
   * clamped by the model's physical `contextWindow` when known.
   */
  conversationMaxTokens?: number;
  /** Safety-net ceiling for the `### world` section. */
  worldSnapshotMaxTokens?: number;
  /** Tokens reserved for the model's reply; drives the n_ctx-aware clamp. */
  completionMaxTokens?: number;
  /**
   * One-shot message injected into the variable tail as a `### notice`
   * section. Used by the loop detector to nudge the model out of
   * no-progress loops without invalidating the stable prefix.
   */
  transientNotice?: string;
  profile?: ModelProfile;
  /**
   * User profile facts rendered into the `### profile` section. Lives in
   * the variable tail (never the stable prefix) so KV-cache reuse is
   * preserved across profile edits. Pass `undefined` to suppress the
   * section entirely; pass `[]` to render the `(no profile)` sentinel.
   */
  profileFacts?: readonly ProfileFact[];
  /** Safety-net ceiling for the `### profile` section. */
  profileMaxTokens?: number;
}

export interface BuiltPromptTruncationFlags {
  session: boolean;
  profile: boolean;
  worldSnapshot: boolean;
  conversation: boolean;
}

export interface BuiltPrompt {
  /** Concatenated prompt ready to be sent to llama-server. */
  text: string;
  /** Byte-stable portion suitable for KV-cache slot assignment. */
  stablePrefix: string;
  /** Variable tail included for observability/debugging. */
  tail: string;
  tokens: {
    stablePrefix: number;
    session: number;
    profile: number;
    worldSnapshot: number;
    conversation: number;
    total: number;
  };
  limits: TokenBudgetLimits;
  /** True when any section was trimmed. Individual flags in `truncation`. */
  truncated: boolean;
  truncation: BuiltPromptTruncationFlags;
  /** Physical context window from the model profile, if known. */
  contextWindow: number | null;
  /** Conversation cap actually enforced for this build (after n_ctx clamp). */
  conversationCapEffective: number;
  /** Number of older turns folded into the deterministic summary line. */
  droppedTurns: number;
}

/**
 * Assembles the prompt with the stable prefix at the top (persona + tools +
 * capabilities + skill catalog) and the variable tail at the bottom
 * (session facts, world snapshot, conversation transcript).
 *
 * Budgeting:
 *  - `tokenBudget` caps `session` facts/skills via a direct `truncateToTokens`.
 *  - `worldSnapshotMaxTokens` caps the ARIA snapshot. It is a safety net,
 *    not a regular truncation path — the snapshot is already compressed
 *    upstream by `aria-compressor`.
 *  - `conversationMaxTokens` caps the transcript. When the model profile
 *    carries a physical `contextWindow`, the effective cap is further
 *    clamped so that `stablePrefix + session + world + completion + safety`
 *    still fits. Older turns become a deterministic one-line summary.
 *
 * Both the world snapshot and the conversation transcript live strictly
 * in the variable tail, so expanding them does NOT invalidate the KV
 * cache over the stable prefix.
 */
export function buildPrompt(input: BuildPromptInput): BuiltPrompt {
  const config = getConfig();
  const budgetTotal = input.tokenBudget ?? config.agent.tokenBudget;
  const conversationMaxTokens =
    input.conversationMaxTokens ?? config.agent.conversationMaxTokens;
  const worldSnapshotMaxTokens =
    input.worldSnapshotMaxTokens ?? config.agent.worldSnapshotMaxTokens;
  const completionMaxTokens =
    input.completionMaxTokens ?? config.llama.completionMaxTokens;

  const limits = defaultBudget(budgetTotal, {
    conversation: conversationMaxTokens,
    worldSnapshot: worldSnapshotMaxTokens,
  });

  const stablePrefix = buildStablePrefix({
    toolDescriptors: input.toolDescriptors,
    capabilities: input.capabilities,
    skillCatalog: input.skillCatalog,
    reasoningSystemToken: input.profile?.reasoningSystemToken,
    ...(input.systemPersona !== undefined
      ? { systemPersona: input.systemPersona }
      : {}),
  });

  const sessionSection = renderSessionSection(input.session);
  const session = truncateToTokens(sessionSection, limits.session);

  const profileMaxTokens =
    input.profileMaxTokens ?? config.memory.profile.maxTokens;
  const profileFull =
    input.profileFacts !== undefined
      ? renderProfileSection(input.profileFacts)
      : null;
  const profile =
    profileFull !== null ? truncateToTokens(profileFull, profileMaxTokens) : null;
  const profileTokens = profile !== null ? estimateTokens(profile) : 0;

  const worldSnapshotFull = renderWorldSnapshotSection(input.session);
  const worldSnapshot = truncateToTokens(
    worldSnapshotFull,
    limits.worldSnapshot,
  );

  const contextWindow = input.profile?.contextWindow ?? null;
  const conversationCapEffective = computeEffectiveConversationCap({
    configuredCap: limits.conversation,
    contextWindow: contextWindow ?? undefined,
    stablePrefixTokens: estimateTokens(stablePrefix),
    sessionTokens: estimateTokens(session),
    worldSnapshotTokens: estimateTokens(worldSnapshot),
    profileTokens,
    completionMaxTokens,
  });

  const packed = packConversation(input.session.turns, conversationCapEffective);
  const conversation = renderPackedConversation(packed);

  const tailParts: string[] = [`### session`, session, ``];
  if (profile !== null) {
    tailParts.push(`### profile`, profile, ``);
  }
  tailParts.push(
    `### world`,
    worldSnapshot,
    ``,
    `### conversation`,
    conversation,
    ``,
  );
  if (input.transientNotice && input.transientNotice.length > 0) {
    tailParts.push(`### notice`, input.transientNotice, ``);
  }
  tailParts.push(
    `### response`,
    `Emit one JSON tool call now. Use \`reply\` for natural-language answers to the user.`,
  );
  if (input.profile?.requiresPromptThinkPrefix && input.profile.reasoningStyle !== "none") {
    tailParts.push(input.profile.reasoningOpenTag.trimEnd(), ``);
  }
  const tail = tailParts.join("\n");

  const text = `${stablePrefix}\n${tail}`;

  const budgetResult = checkBudget(
    { stablePrefix, session, worldSnapshot, conversation },
    limits,
  );

  const truncation: BuiltPromptTruncationFlags = {
    session: session !== sessionSection,
    profile: profileFull !== null && profile !== profileFull,
    worldSnapshot: worldSnapshot !== worldSnapshotFull,
    conversation: packed.droppedCount > 0,
  };

  return {
    text,
    stablePrefix,
    tail,
    tokens: {
      ...budgetResult.perSection,
      profile: profileTokens,
      total: budgetResult.perSection.total + profileTokens,
    },
    limits,
    truncated:
      truncation.session ||
      truncation.profile ||
      truncation.worldSnapshot ||
      truncation.conversation,
    truncation,
    contextWindow,
    conversationCapEffective,
    droppedTurns: packed.droppedCount,
  };
}

function renderSessionSection(session: SessionState): string {
  const facts = session.knownFacts
    .slice(-8)
    .map((fact) => `- ${fact.text}`)
    .join("\n");
  const loadedSkills =
    session.loadedSkills.length > 0
      ? session.loadedSkills
          .map((s) => `--- skill:${s.name} v${s.version} ---\n${s.body}`)
          .join("\n\n")
      : "(none)";
  return [
    facts.length > 0 ? `known facts:\n${facts}` : `known facts: (none)`,
    ``,
    `loaded skills:`,
    loadedSkills,
  ].join("\n");
}

function renderWorldSnapshotSection(session: SessionState): string {
  const snap = session.worldSnapshot;
  if (!snap || snap.kind === "none") return "(no world snapshot available)";
  return [`kind: ${snap.kind}`, `digest: ${snap.digest}`, ``, snap.text].join(
    "\n",
  );
}

/**
 * Render the packed conversation section. When `packConversation` folded
 * older turns into a summary, that summary is emitted as the first line
 * so the model can tell the transcript was compressed.
 */
function renderPackedConversation(packed: {
  visibleTurns: readonly import("../session/conversation-turn.js").ConversationTurn[];
  droppedSummary: string | null;
}): string {
  if (packed.visibleTurns.length === 0 && packed.droppedSummary === null) {
    return "(no messages yet)";
  }
  const lines: string[] = [];
  if (packed.droppedSummary) lines.push(packed.droppedSummary);
  for (const turn of packed.visibleTurns) {
    lines.push(renderTurnForPrompt(turn));
  }
  return lines.join("\n");
}
