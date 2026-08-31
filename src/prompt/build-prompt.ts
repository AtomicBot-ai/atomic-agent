import { getConfig, USER_CONFIG_DEFAULTS } from "../config/index.js";
import { getReasoningTurnFraming } from "../llm/model-profile.js";
import { renderProfileSection } from "../memory/profile-renderer.js";
import {
  renderMemoryIndexSection,
  renderRecalledSection,
} from "../memory/notes-renderer.js";
import { renderLessonsSection } from "../memory/lessons/lessons-renderer.js";
import { renderProceduresSection } from "../memory/procedures/procedures-renderer.js";
import {
  packConversation,
  pairTokenCosts,
} from "../session/conversation-turn.js";
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
  CONVERSATION_CAP_AUTO,
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
  // `0` means "let the window decide" (`CONVERSATION_CAP_AUTO`).
  const conversationCapAuto = conversationMaxTokens <= CONVERSATION_CAP_AUTO;
  const conversationMaxPairs =
    input.conversationMaxPairs ?? config.agent.conversationMaxPairs;
  const worldSnapshotMaxTokens =
    input.worldSnapshotMaxTokens ?? config.agent.worldSnapshotMaxTokens;
  const completionMaxTokens =
    input.completionMaxTokens ?? config.localModels.completionMaxTokens;

  // Under auto the conversation share is pinned to the schema default
  // rather than left to `defaultBudget`'s `tokenBudget * 0.35`.
  //
  // That share is a sensible split of a *fixed* budget; it is a
  // catastrophic ceiling for an operator who asked for no ceiling. With
  // the default `tokenBudget: 3000` it is 1050 tokens, and when nothing
  // knows the window `computeEffectiveConversationCap` returns the
  // configured figure verbatim — so pressing "set auto" on a model whose
  // window could not be probed took the transcript from 32k to 1050, a
  // 30x cut in the exact direction the button promises to go. "Let the
  // window decide" must never quietly mean "assume a tiny window".
  const limits = defaultBudget(budgetTotal, {
    conversation: conversationCapAuto
      ? USER_CONFIG_DEFAULTS.agent.conversationMaxTokens
      : conversationMaxTokens,
    worldSnapshot: worldSnapshotMaxTokens,
  });

  const turnFraming =
    input.profile !== undefined
      ? getReasoningTurnFraming(input.profile)
      : undefined;

  const stablePrefix = buildStablePrefix({
    toolDescriptors: input.toolDescriptors,
    capabilities: input.capabilities,
    skillCatalog: input.skillCatalog,
    reasoningSystemToken: input.profile?.reasoningSystemToken,
    maxParallelToolCalls: config.agent.maxParallelToolCalls,
    ...(turnFraming !== undefined
      ? { turnSystemOpen: turnFraming.systemOpen }
      : {}),
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

  const proceduresMaxTokens =
    input.proceduresMaxTokens ?? config.memory.procedures.maxTokens;
  const recalledProcedures = input.session.recalledProcedures;
  const proceduresFull =
    recalledProcedures !== undefined && recalledProcedures.length > 0
      ? renderProceduresSection(recalledProcedures)
      : null;
  const procedures =
    proceduresFull !== null
      ? truncateToTokens(proceduresFull, proceduresMaxTokens)
      : null;
  const proceduresTokens = procedures !== null ? estimateTokens(procedures) : 0;

  const worldSnapshotFull = renderWorldSnapshotSection(input.session);
  const worldSnapshot = truncateToTokens(
    worldSnapshotFull,
    limits.worldSnapshot,
  );

  // The probe first, then whatever the caller resolved (the provider
  // catalogue, for a cloud model that has no `/props` to read). Before
  // this the budget simply had no window off the local path.
  const contextWindow =
    input.profile?.contextWindow ?? input.contextWindow ?? null;
  const sessionTokenEstimate =
    estimateTokens(sessionPartsForBudget) + loadedToolsTokens;
  const conversationCapEffective = computeEffectiveConversationCap({
    configuredCap: limits.conversation,
    ...(conversationCapAuto ? { autoFill: true } : {}),
    contextWindow: contextWindow ?? undefined,
    stablePrefixTokens: estimateTokens(stablePrefix),
    sessionTokens: sessionTokenEstimate,
    worldSnapshotTokens: estimateTokens(worldSnapshot),
    profileTokens,
    recalledTokens,
    memoryIndexTokens,
    lessonsTokens,
    proceduresTokens,
    loadedToolsTokens,
    completionMaxTokens,
  });

  const packed = packConversation(input.session.turns, conversationCapEffective, {
    maxPairs: conversationMaxPairs,
    ...(input.session.macroTurnStarts
      ? { macroTurnStarts: input.session.macroTurnStarts }
      : {}),
  });
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
  if (procedures !== null) {
    tailParts.push("### procedures", procedures, ``);
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
  // Current date lives in the variable tail (not the stable prefix) so it
  // sits close to the generation point where the model actually attends to
  // it — empirically the stable-prefix placement was too far upstream and
  // the model kept anchoring on its training-era year. Rendered as a bold
  // standalone line so it stands out. Omitted when not provided.
  if (input.currentDate) {
    tailParts.push(
      `CURRENT DATE: ${input.currentDate} — this is today. Use it for any time-relative reasoning; never assume an earlier year.`,
      ``,
    );
  }
  // Static 2-line emit anchor right before the (optional) reasoning prefill.
  // Kept out of the stable prefix so it sits as close as possible to the
  // generation point, which empirically prevents reasoning-mode repetition
  // loops (e.g. "I will write the response. I will check the response."
  // observed when the only trailing directive lived ~13k tokens upstream).
  // Byte-stable and short, so it does not meaningfully hurt cache reuse.
  tailParts.push(`### respond`, `Respond now.`, ``);
  if (turnFraming !== undefined) {
    // Gemma 4 turn-framing: close the system turn and open the model turn.
    // The model emits its own `<|channel>thought` block — we do NOT prefill
    // the reasoning open tag (a prefilled `<|channel>thought\n` reads as the
    // template's *thinking-disabled* marker and suppresses reasoning).
    tailParts.push(
      turnFraming.turnClose.trimEnd(),
      turnFraming.assistantOpen.trimEnd(),
      ``,
    );
  } else if (
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
    conversationCapAuto,
    droppedTurns: packed.droppedCount,
    conversationPairs: packed.visiblePairs,
    droppedPairs: packed.droppedPairs,
    conversationPairsCap: conversationMaxPairs,
    conversationBoundBy: packed.boundBy,
    pairCosts: pairTokenCosts(
      input.session.turns,
      input.session.macroTurnStarts,
    ),
  };
}
