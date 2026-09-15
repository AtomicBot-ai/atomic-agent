import { getConfig } from "../config/index.js";
import { getReasoningTurnFraming } from "../llm/model-profile.js";
import { thinkingDisabledOnBuiltPrompt } from "../llm/server-template-policy.js";
import { clipProfileSection } from "./clip-profile-section.js";
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
import type { PromptMessages } from "../llm/provider/completion-types.js";
import {
  packedConversationTurns,
  renderPackedConversation,
  renderWorldSnapshotSection,
} from "./build-prompt-world-conversation.js";
import type {
  BuildPromptInput,
  BuiltPrompt,
  BuiltPromptTruncationFlags,
} from "./build-prompt-types.js";
import { resolveFusionMachineFacts } from "./fusion-machine-facts.js";
import { renderRequestSection, requestInView } from "./request-section.js";
import { buildStablePrefix } from "./stable-prefix.js";
import { buildSessionSectionParts } from "./session-tail-sections.js";
import { renderLoadedToolsSection } from "./render-loaded-tools.js";
import { partitionByRole } from "../tools/tool-roles.js";
import { renderTaskPolicy } from "./render-task-policy.js";
import {
  checkBudget,
  computeEffectiveConversationCap,
  CONVERSATION_CAP_AUTO,
  CONVERSATION_CAP_AUTO_FALLBACK,
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
 * (memory / `### session-facts` / world / conversation, then the sections
 * a step can change: `### profile`, lessons, procedures,
 * `### loaded-skills`, `### loaded-tools`).
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
  // A model with no partial prefix reuse re-reads the whole prompt at
  // every cut, so it cuts deeper and less often; an operator who set the
  // share lower still keeps their own number.
  const configuredLowWater =
    input.conversationLowWater ?? config.agent.conversationLowWater;
  const conversationLowWater =
    input.profile?.prefixReuse === "none"
      ? Math.min(configuredLowWater, 0.5)
      : configuredLowWater;
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
      ? CONVERSATION_CAP_AUTO_FALLBACK
      : conversationMaxTokens,
    worldSnapshot: worldSnapshotMaxTokens,
  });

  // Chat-transport prompts drop every llama-server template artifact:
  // no turn framing, no reasoning system token, no trailing prefill
  // (see `BuildPromptInput.suppressReasoningPrefill`).
  const suppressPrefill = input.suppressReasoningPrefill === true;
  const turnFraming =
    input.profile !== undefined && !suppressPrefill
      ? getReasoningTurnFraming(input.profile)
      : undefined;

  const stablePrefix = buildStablePrefix({
    toolDescriptors: input.toolDescriptors,
    capabilities: input.capabilities,
    skillCatalog: input.skillCatalog,
    reasoningSystemToken: suppressPrefill
      ? undefined
      : input.profile?.reasoningSystemToken,
    maxParallelToolCalls: config.agent.maxParallelToolCalls,
    // Only read when the `### fusion` block actually renders. Config
    // values, so they move only when the operator writes the config
    // file — the same event that already flips the fusion descriptor
    // gate and drops the KV cache once. The observed slot count moves
    // once, when first observed; the measured decode speed is per daemon
    // instance and moves only on a restart, which drops the local cache
    // anyway.
    fusion: resolveFusionMachineFacts(config, {
      workerSlots: input.liveWorkerSlots ?? null,
      tokensPerSecond: input.fusionTokensPerSecond ?? null,
    }),
    ...(turnFraming !== undefined
      ? { turnSystemOpen: turnFraming.systemOpen }
      : {}),
    ...(input.systemPersona !== undefined
      ? { systemPersona: input.systemPersona }
      : {}),
    ...(input.toolTransport !== undefined
      ? { toolTransport: input.toolTransport }
      : {}),
    ...(input.toolRole !== undefined ? { toolRole: input.toolRole } : {}),
  });

  const sessionParts = buildSessionSectionParts(input.session, limits.session);
  const loadedForTail = sessionParts.loaded;
  const factsForTail = sessionParts.facts;
  const sessionPartsForBudget = [loadedForTail, factsForTail]
    .filter(Boolean)
    .join("\n\n");

  const loadedToolsMaxTokens =
    input.loadedToolsMaxTokens ?? config.agent.loadedToolsMaxTokens;
  // A loaded tool the prefix already describes in full for this role
  // (an out-of-role load from an earlier turn under another role, or a
  // frequent tool loaded by hand) is not rendered twice: the tail copy
  // would cost tokens and say nothing the prefix does not.
  const describedInFull = new Set(
    partitionByRole(input.toolRole, input.toolDescriptors)
      .inRole.filter((d) => d.tier !== "rare")
      .map((d) => d.name),
  );
  const loadedToolsRendered = renderLoadedToolsSection(
    input.session,
    loadedToolsMaxTokens,
    { skip: describedInFull },
  );
  const loadedToolsTokens = loadedToolsRendered.tokens;

  const profileMaxTokens =
    input.profileMaxTokens ?? config.memory.profile.maxTokens;
  const contextualKeywordGate =
    input.contextualKeywordGate ?? config.memory.profile.contextualKeywordGate;
  // Whole fact lines, pinned first; `clip` carries the counts whenever a
  // fact was left out, so the loop can warn (issue #407).
  const profileSection =
    input.profileFacts !== undefined
      ? clipProfileSection(input.profileFacts, {
          userMessage: input.userMessage ?? null,
          contextualKeywordGate,
          maxTokens: profileMaxTokens,
        })
      : null;
  const profile = profileSection?.text ?? null;
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

  // One option set for every pack of this build: the `### request`
  // re-pack below must cut under the same low-water mark and from the
  // same remembered start, or the two packs could disagree about where
  // the transcript begins.
  const packOptions = {
    maxPairs: conversationMaxPairs,
    lowWater: conversationLowWater,
    ...(input.session.macroTurnStarts
      ? { macroTurnStarts: input.session.macroTurnStarts }
      : {}),
    ...(input.session.conversationPackStart
      ? { packStart: input.session.conversationPackStart }
      : {}),
  };
  let packed = packConversation(
    input.session.turns,
    conversationCapEffective,
    packOptions,
  );
  // The operator's request, pinned only once the packer has dropped the
  // turn that carried it. It then takes its room out of the conversation
  // cap — a second pack, and only on that path — so the tail still fits
  // the window; the carrier stays dropped under the smaller cap, so the
  // decision cannot flip.
  const request = input.originalRequest?.trim() ?? "";
  const requestSection =
    request.length > 0 && !requestInView(request, packed.visibleTurns)
      ? renderRequestSection(request)
      : null;
  if (requestSection !== null) {
    const requestTokens = estimateTokens(requestSection);
    if (requestTokens < conversationCapEffective) {
      packed = packConversation(
        input.session.turns,
        conversationCapEffective - requestTokens,
        packOptions,
      );
    }
  }
  const conversation = renderPackedConversation(packed);
  const taskPolicy = renderTaskPolicy({
    userMessage: input.userMessage ?? null,
    turns: input.session.turns,
  });
  const taskPolicyTokens =
    taskPolicy === null ? 0 : estimateTokens(taskPolicy.body);

  // Tail order is by what can change WITHIN a turn. Everything ahead of
  // `### conversation` is fixed for the turn (the memory sections are
  // refreshed once, before the first step); everything that a step can
  // change — a `tool.view` adds to loaded-tools, a `skill.view` to
  // loaded-skills, a `memory.profile.set` to the profile — sits after
  // it, so a change lands in the part of the prompt that is re-read
  // anyway rather than ahead of a transcript the model would otherwise
  // have reused from its KV cache.
  // The tail is assembled in two halves around `### conversation`. The
  // flat text joins all three; the structured form (`messages`) sends the
  // conversation as real chat messages and the two halves as one final
  // user message.
  const tailBefore: string[] = [];
  if (memoryIndex !== null) {
    tailBefore.push("### memory-index", memoryIndex, ``);
  }
  if (factsForTail !== null) {
    tailBefore.push("### session-facts", factsForTail, ``);
  }
  if (recalled !== null) {
    tailBefore.push("### recalled", recalled, ``);
  }
  tailBefore.push(`### world`, worldSnapshot, ``);
  // The operator's request, immediately before the conversation, only
  // while the packer has the turn that carried it out of view.
  if (requestSection !== null) {
    tailBefore.push(`### request`, requestSection, ``);
  }
  const conversationParts = [`### conversation`, conversation, ``];
  const tailAfter: string[] = [];
  if (profile !== null) {
    tailAfter.push("### profile", profile, ``);
  }
  if (lessons !== null) {
    tailAfter.push("### lessons", lessons, ``);
  }
  if (procedures !== null) {
    tailAfter.push("### procedures", procedures, ``);
  }
  if (loadedForTail !== null) {
    tailAfter.push("### loaded-skills", loadedForTail, ``);
  }
  if (loadedToolsRendered.body !== null) {
    tailAfter.push("### loaded-tools", loadedToolsRendered.body, ``);
  }
  if (taskPolicy !== null) {
    tailAfter.push(`### task-policy`, taskPolicy.body, ``);
  }
  if (input.transientNotice && input.transientNotice.length > 0) {
    tailAfter.push(`### notice`, input.transientNotice, ``);
  }
  // Current date lives in the variable tail (not the stable prefix) so it
  // sits close to the generation point where the model actually attends to
  // it — empirically the stable-prefix placement was too far upstream and
  // the model kept anchoring on its training-era year. Rendered as a bold
  // standalone line so it stands out. Omitted when not provided.
  if (input.currentDate) {
    tailAfter.push(
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
  tailAfter.push(`### respond`, `Respond now.`, ``);
  // The structured form stops here: the framing and prefill below are
  // text-completion artifacts a chat transport never sees (they are
  // suppressed for it anyway — `suppressReasoningPrefill`).
  const messages: PromptMessages = {
    system: stablePrefix,
    droppedSummary: packed.droppedSummary,
    turns: packedConversationTurns(packed),
    tail: [...tailBefore, ...tailAfter].join("\n"),
  };
  const tailParts: string[] = [...tailBefore, ...conversationParts, ...tailAfter];
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
    !suppressPrefill &&
    input.profile?.requiresPromptThinkPrefix &&
    input.profile.reasoningStyle !== "none"
  ) {
    const disabledMarker = input.profile.promptThinkingDisabledMarker;
    const thinking = input.thinking ?? config.localModels.thinking;
    if (
      disabledMarker !== undefined &&
      thinkingDisabledOnBuiltPrompt(thinking, input.profile)
    ) {
      // `thinking: off` (F49): the template's own disabled rendering —
      // an empty, closed think block — at the generation point, so the
      // model starts on the tool call. The request grammar drops its
      // prelude to match (`withoutReasoningPrelude`).
      tailParts.push(disabledMarker.trimEnd(), ``, ``);
    } else {
      tailParts.push(input.profile.reasoningOpenTag.trimEnd(), ``);
    }
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
    profile: profileSection?.clip !== undefined,
    worldSnapshot: worldSnapshot !== worldSnapshotFull,
    conversation: packed.droppedCount > 0,
    recalled: recalledFull !== null && recalled !== recalledFull,
    memoryIndex: memoryIndexFull !== null && memoryIndex !== memoryIndexFull,
  };

  return {
    text,
    stablePrefix,
    tail,
    messages,
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
    ...(profileSection?.clip !== undefined
      ? { profileClip: profileSection.clip }
      : {}),
    contextWindow,
    conversationCapEffective,
    conversationCapAuto,
    droppedTurns: packed.droppedCount,
    conversationPairs: packed.visiblePairs,
    droppedPairs: packed.droppedPairs,
    conversationPairsCap: conversationMaxPairs,
    conversationBoundBy: packed.boundBy,
    conversationPackStart: packed.packStart,
    pairCosts: pairTokenCosts(
      input.session.turns,
      input.session.macroTurnStarts,
    ),
  };
}
