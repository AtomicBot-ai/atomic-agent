import { getConfig } from "../config/index.js";
import { renderProfileSection } from "../memory/profile-renderer.js";
import {
  renderMemoryIndexSection,
  renderRecalledSection,
} from "../memory/notes-renderer.js";
import { renderLessonsSection } from "../memory/lessons/lessons-renderer.js";
import { packConversation } from "../session/conversation-turn.js";
import {
  renderPackedConversation,
  renderWorldSnapshotSection,
} from "./build-prompt-world-conversation.js";
import type {
  BuildPromptInput,
  BuiltPrompt,
  BuiltPromptTruncationFlags,
} from "./build-prompt-types.js";
import { buildStablePrefix } from "./stable-prefix.js";
import { buildSessionSectionParts } from "./session-tail-sections.js";
import { renderLoadedToolsSection } from "./render-loaded-tools.js";
import { renderTaskPolicy } from "./render-task-policy.js";
import {
  checkBudget,
  computeEffectiveConversationCap,
  defaultBudget,
  estimateTokens,
  truncateToTokens,
} from "./token-budget.js";

export type {
  BuildPromptInput,
  BuiltPrompt,
  BuiltPromptTruncationFlags,
} from "./build-prompt-types.js";

// TODO(memory-v2): cross-phase invariant 1 — the stable prefix bytes
// must change exactly twice across the v2 rollout: once in phase 5
// (adds `### lessons` to the variable tail + mentions it in the persona)
// and once in phase 7b (adds `### procedures` + mentions it). Pinned by
// hash test in `build-prompt.test.ts`. The expected gold hash moves once
// per phase boundary and stays byte-stable otherwise. This is a
// deliberate deviation from doc §9 invariant 2 (which expected one
// combined release) — see AGENTS.md "Memory fabric" §2 for the rationale.
//
// TODO(memory-v2 phase 5): render `### lessons` between `### profile`
// and `### recalled`. Source: ephemeral `SessionState.recalledLessons`
// pre-fetched by `memory-context-provider`. Token budget
// `memory.lessons.maxTokens` (default 300) subtracted from the effective
// conversation cap in `token-budget.ts`.
//
// TODO(memory-v2 phase 7b): render `### procedures` between
// `### lessons` and `### recalled`. Source: ephemeral
// `SessionState.recalledProcedures`. Token budget
// `memory.procedures.maxTokens` (default 400) likewise subtracted.

/**
 * Assembles the prompt with the stable prefix at the top (persona + tools +
 * capabilities + skill catalog) and the variable tail at the bottom
 * (`### loaded-skills` / `### session-facts` / memory / world / conversation).
 *
 * Budgeting:
 *  - `tokenBudget` caps `### loaded-skills` + `### session-facts` (shared) via
 *    `truncateToTokens` on a combined string. Session facts are placed first
 *    in the combined string so the tail of that blob is trimmed from loaded
 *    skills first, matching the legacy `known facts` + `loaded skills` order.
 *  - `worldSnapshotMaxTokens` caps the ARIA snapshot. It is a safety net,
 *    not a regular truncation path — the snapshot is already compressed
 *    upstream by `aria-compressor`.
 *  - `conversationMaxTokens` caps the transcript. When the model profile
 *    carries a physical `contextWindow`, the effective cap is further
 *    clamped so that `stablePrefix + sessionParts + world + completion + safety`
 *    still fits. Older turns become a deterministic one-line summary.
 *
 * The world snapshot and the conversation transcript live strictly in the
 * variable tail, so expanding them does NOT invalidate the KV cache over
 * the stable prefix.
 */
export function buildPrompt(input: BuildPromptInput): BuiltPrompt {
  const config = getConfig();
  const budgetTotal = input.tokenBudget ?? config.agent.tokenBudget;
  const conversationMaxTokens =
    input.conversationMaxTokens ?? config.agent.conversationMaxTokens;
  const worldSnapshotMaxTokens =
    input.worldSnapshotMaxTokens ?? config.agent.worldSnapshotMaxTokens;
  const completionMaxTokens =
    input.completionMaxTokens ?? config.localModels.completionMaxTokens;

  const limits = defaultBudget(budgetTotal, {
    conversation: conversationMaxTokens,
    worldSnapshot: worldSnapshotMaxTokens,
  });

  const stablePrefix = buildStablePrefix({
    toolDescriptors: input.toolDescriptors,
    capabilities: input.capabilities,
    skillCatalog: input.skillCatalog,
    reasoningSystemToken: input.profile?.reasoningSystemToken,
    maxParallelToolCalls: config.agent.maxParallelToolCalls,
    ...(input.systemPersona !== undefined
      ? { systemPersona: input.systemPersona }
      : {}),
  });

  const sessionParts = buildSessionSectionParts(
    input.session,
    limits.session,
  );
  const loadedForTail = sessionParts.loaded;
  const factsForTail = sessionParts.facts;
  const sessionPartsForBudget = [loadedForTail, factsForTail]
    .filter(Boolean)
    .join("\n\n");

  const loadedToolsMaxTokens =
    input.loadedToolsMaxTokens ?? config.agent.loadedToolsMaxTokens;
  const loadedToolsRendered = renderLoadedToolsSection(
    input.session,
    loadedToolsMaxTokens,
  );
  const loadedToolsTokens = loadedToolsRendered.tokens;

  const profileMaxTokens =
    input.profileMaxTokens ?? config.memory.profile.maxTokens;
  const contextualKeywordGate =
    input.contextualKeywordGate ??
    config.memory.profile.contextualKeywordGate;
  const profileFull =
    input.profileFacts !== undefined
      ? renderProfileSection(input.profileFacts, {
          userMessage: input.userMessage ?? null,
          contextualKeywordGate,
        })
      : null;
  const profile =
    profileFull !== null
      ? truncateToTokens(profileFull, profileMaxTokens)
      : null;
  const profileTokens = profile !== null ? estimateTokens(profile) : 0;

  const recallPreviewChars =
    input.recallPreviewChars ?? config.memory.recallInjection.previewChars;
  const recallMaxTokens =
    input.recallMaxTokens ?? config.memory.recallInjection.maxTokens;
  const recalledNotes = input.session.recalledNotes;
  const recalledFull =
    recalledNotes !== undefined && recalledNotes.length > 0
      ? renderRecalledSection(recalledNotes, {
          previewChars: recallPreviewChars,
        })
      : null;
  const recalled =
    recalledFull !== null
      ? truncateToTokens(recalledFull, recallMaxTokens)
      : null;
  const recalledTokens = recalled !== null ? estimateTokens(recalled) : 0;

  const memoryIndexMaxTokens =
    input.memoryIndexMaxTokens ?? config.memory.index.maxTokens;
  const memoryIndexEntries = input.session.memoryIndex;
  const memoryIndexFull =
    memoryIndexEntries !== undefined && memoryIndexEntries.length > 0
      ? renderMemoryIndexSection(memoryIndexEntries)
      : null;
  const memoryIndex =
    memoryIndexFull !== null
      ? truncateToTokens(memoryIndexFull, memoryIndexMaxTokens)
      : null;
  const memoryIndexTokens =
    memoryIndex !== null ? estimateTokens(memoryIndex) : 0;

  const lessonsMaxTokens =
    input.lessonsMaxTokens ?? config.memory.lessons.maxTokens;
  const recalledLessons = input.session.recalledLessons;
  const lessonsFull =
    recalledLessons !== undefined && recalledLessons.length > 0
      ? renderLessonsSection(recalledLessons)
      : null;
  const lessons =
    lessonsFull !== null
      ? truncateToTokens(lessonsFull, lessonsMaxTokens)
      : null;
  const lessonsTokens = lessons !== null ? estimateTokens(lessons) : 0;

  const worldSnapshotFull = renderWorldSnapshotSection(input.session);
  const worldSnapshot = truncateToTokens(
    worldSnapshotFull,
    limits.worldSnapshot,
  );

  const contextWindow = input.profile?.contextWindow ?? null;
  const sessionTokenEstimate =
    estimateTokens(sessionPartsForBudget) + loadedToolsTokens;
  const conversationCapEffective = computeEffectiveConversationCap({
    configuredCap: limits.conversation,
    contextWindow: contextWindow ?? undefined,
    stablePrefixTokens: estimateTokens(stablePrefix),
    sessionTokens: sessionTokenEstimate,
    worldSnapshotTokens: estimateTokens(worldSnapshot),
    profileTokens,
    recalledTokens,
    memoryIndexTokens,
    lessonsTokens,
    loadedToolsTokens,
    completionMaxTokens,
  });

  const packed = packConversation(input.session.turns, conversationCapEffective);
  const conversation = renderPackedConversation(packed);
  const taskPolicy = renderTaskPolicy({
    userMessage: input.userMessage ?? null,
    turns: input.session.turns,
  });
  const taskPolicyTokens =
    taskPolicy === null ? 0 : estimateTokens(taskPolicy.body);

  const tailParts: string[] = [];
  if (loadedForTail !== null) {
    tailParts.push("### loaded-skills", loadedForTail, ``);
  }
  if (loadedToolsRendered.body !== null) {
    tailParts.push("### loaded-tools", loadedToolsRendered.body, ``);
  }
  if (profile !== null) {
    tailParts.push("### profile", profile, ``);
  }
  if (lessons !== null) {
    tailParts.push("### lessons", lessons, ``);
  }
  if (memoryIndex !== null) {
    tailParts.push("### memory-index", memoryIndex, ``);
  }
  if (factsForTail !== null) {
    tailParts.push("### session-facts", factsForTail, ``);
  }
  if (recalled !== null) {
    tailParts.push("### recalled", recalled, ``);
  }
  tailParts.push(
    `### world`,
    worldSnapshot,
    ``,
    `### conversation`,
    conversation,
    ``,
  );
  if (taskPolicy !== null) {
    tailParts.push(`### task-policy`, taskPolicy.body, ``);
  }
  if (input.transientNotice && input.transientNotice.length > 0) {
    tailParts.push(`### notice`, input.transientNotice, ``);
  }
  // Static 2-line emit anchor right before the (optional) reasoning prefill.
  // Kept out of the stable prefix so it sits as close as possible to the
  // generation point, which empirically prevents reasoning-mode repetition
  // loops (e.g. "I will write the response. I will check the response."
  // observed when the only trailing directive lived ~13k tokens upstream).
  // Byte-stable and short, so it does not meaningfully hurt cache reuse.
  tailParts.push(`### respond`, `Respond now.`, ``);
  if (
    input.profile?.requiresPromptThinkPrefix &&
    input.profile.reasoningStyle !== "none"
  ) {
    tailParts.push(input.profile.reasoningOpenTag.trimEnd(), ``);
  }
  const tail = tailParts.join("\n");

  const text = `${stablePrefix}\n${tail}`;

  const budgetResult = checkBudget(
    {
      stablePrefix,
      loadedSkills: sessionParts.budgetLoaded,
      sessionFacts: sessionParts.budgetFacts,
      worldSnapshot,
      conversation,
    },
    limits,
  );

  const truncation: BuiltPromptTruncationFlags = {
    loadedSkills: sessionParts.truncationLoaded,
    sessionFacts: sessionParts.truncationFacts,
    loadedTools: loadedToolsRendered.truncated,
    profile: profileFull !== null && profile !== profileFull,
    worldSnapshot: worldSnapshot !== worldSnapshotFull,
    conversation: packed.droppedCount > 0,
    recalled: recalledFull !== null && recalled !== recalledFull,
    memoryIndex:
      memoryIndexFull !== null && memoryIndex !== memoryIndexFull,
  };

  return {
    text,
    stablePrefix,
    tail,
    tokens: {
      stablePrefix: budgetResult.perSection.stablePrefix,
      loadedSkills: budgetResult.perSection.loadedSkills,
      sessionFacts: budgetResult.perSection.sessionFacts,
      loadedTools: loadedToolsTokens,
      worldSnapshot: budgetResult.perSection.worldSnapshot,
      conversation: budgetResult.perSection.conversation,
      profile: profileTokens,
      recalled: recalledTokens,
      memoryIndex: memoryIndexTokens,
      taskPolicy: taskPolicyTokens,
      total:
        budgetResult.perSection.total +
        loadedToolsTokens +
        profileTokens +
        recalledTokens +
        memoryIndexTokens +
        taskPolicyTokens,
    },
    limits,
    truncated:
      truncation.loadedSkills ||
      truncation.sessionFacts ||
      truncation.loadedTools ||
      truncation.profile ||
      truncation.worldSnapshot ||
      truncation.conversation ||
      truncation.recalled ||
      truncation.memoryIndex,
    truncation,
    contextWindow,
    conversationCapEffective,
    droppedTurns: packed.droppedCount,
  };
}
